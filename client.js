/**
 * dsh-usd-brep client half — CAD studio layout.
 * Left 1/3: light form panel (white bg). Right 2/3: black 3D viewport
 * with a top toolbar: 适合 / 重置 / 线框 / 测量 / 截图.
 * three.js served by the plugin (GET /api/usd-brep/three.js) — no CDN.
 */
/* eslint-disable */
(function () {
  'use strict';

  window.__ModuleLoader__.load({
    id: 'dsh-usd-brep',
    factory: function (require) {
      var React = require('react');
      var h = React.createElement;

      var CUSTOM_TEMPLATE = [
        'import math',
        '',
        '# 在这里用 usd_brep 建模，最后定义变量 brep（Brep 实体）',
        '# 例：带螺栓孔的法兰盘',
        'R = 3.0          # 法兰外半径',
        'hub_r = 1.2      # 轮毂外半径',
        'bore_r = 0.6     # 中心孔半径',
        'h = 0.8          # 总厚度',
        '',
        'plate = usd_brep.primitives.create_cylinder((0, 0, -h/2), R, h)',
        'hub = usd_brep.primitives.create_cylinder((0, 0, -h/2), hub_r, h * 1.8)',
        'body = usd_brep.booleans.boolean_union(plate, hub)',
        '',
        'for i in range(4):',
        '    a = math.pi / 2 * i + math.pi / 4',
        '    pin = usd_brep.primitives.create_cylinder(',
        '        (2.2 * math.cos(a), 2.2 * math.sin(a), -h), 0.25, h * 3)',
        '    body = usd_brep.booleans.boolean_difference(body, pin)',
        '',
        'bore = usd_brep.primitives.create_cylinder((0, 0, -h), bore_r, h * 4)',
        'brep = usd_brep.booleans.boolean_difference(body, bore)',
      ].join('\n');

      function fmt(n) {
        if (!isFinite(n)) return '—';
        var abs = Math.abs(n);
        if (abs >= 100) return n.toFixed(1);
        if (abs >= 1) return n.toFixed(3);
        return n.toFixed(4);
      }

      function Panel() {
        var canvasRef = React.useRef(null);
        var engineRef = React.useRef(null);
        var lastMeshRef = React.useRef(null);
        var threeState = React.useRef('loading');
        var [kind, setKind] = React.useState('washer');
        var [params, setParams] = React.useState({
          outerRadius: 3, innerRadius: 1, height: 0.5,
          radius: 2, boxSize: 2,
          majorRadius: 2, minorRadius: 0.6,
          teeth: 12,
        });
        var [customCode, setCustomCode] = React.useState(CUSTOM_TEMPLATE);
        var [showCustom, setShowCustom] = React.useState(false);
        var [busy, setBusy] = React.useState(false);
        var [status, setStatus] = React.useState('');
        var [error, setError] = React.useState('');
        var [meta, setMeta] = React.useState(null);
        var [wire, setWire] = React.useState(true);
        var [measure, setMeasure] = React.useState(false);
        var [nlText, setNlText] = React.useState('');
        var [nlBusy, setNlBusy] = React.useState(false);
        var [nlLog, setNlLog] = React.useState('');

        React.useEffect(function () {
          var cancelled = false;
          // fetch-based loader: works under dsh-app:// (script tags with custom
          // protocols fail) and http(s) alike — the build API already proves
          // fetch reaches the host on this scheme.
          loadThree('api/usd-brep/three.js', function () {
            if (cancelled) return;
            threeState.current = 'ready';
            var tries = 0;
            (function tryInit() {
              if (cancelled) return;
              if (canvasRef.current && canvasRef.current.clientHeight > 10) {
                engineRef.current = initScene(canvasRef.current);
              } else if (tries++ < 60) {
                setTimeout(tryInit, 250);
              } else {
                setError('3D 画布尺寸异常（容器高度为 0）');
              }
            })();
          }, function (err) {
            if (cancelled) return;
            threeState.current = 'failed';
            setError('three.js 加载失败：' + (err || '未知原因'));
          });
          return function () {
            cancelled = true;
            if (engineRef.current) engineRef.current.dispose();
          };
        }, []);

        function num(k) { var v = parseFloat(params[k]); return isFinite(v) ? v : 0; }

        function buildShape() {
          var shape = { kind: kind, tolerance: 0.01 };
          if (kind === 'washer') { shape.outerRadius = num('outerRadius'); shape.innerRadius = num('innerRadius'); shape.height = num('height'); }
          if (kind === 'sphere_minus_box') { shape.radius = num('radius'); shape.boxSize = num('boxSize'); }
          if (kind === 'torus') { shape.majorRadius = num('majorRadius'); shape.minorRadius = num('minorRadius'); }
          if (kind === 'gear') { shape.teeth = Math.round(num('teeth')); shape.outerRadius = num('outerRadius'); shape.innerRadius = num('innerRadius'); shape.height = num('height'); }
          if (kind === 'custom') { shape.custom_code = customCode; }
          return shape;
        }

        function run() {
          setBusy(true); setError(''); setStatus('建模 + 细分中…');
          xhrSend('POST', 'api/usd-brep/build', buildShape(), function (err, res) {
            setBusy(false);
            if (err) { setError(String(err)); setStatus(''); return; }
            var j = res.json;
            if (!j || j.ok !== true) {
              setError((j && (j.stderr || j.error)) || ('HTTP ' + res.status));
              setStatus('');
              return;
            }
            setStatus('');
            var data = { points: j.points, triangles: j.triangles };
            lastMeshRef.current = data;
            setMeta({ vertices: data.points.length, triangles: data.triangles.length, volume: j.volume });
            if (engineRef.current) {
              engineRef.current.setMesh(data.points, data.triangles, wire);
              engineRef.current.setMeasure(measure);
            }
          });
        }

        React.useEffect(function () {
          if (engineRef.current && engineRef.current.hasMesh()) engineRef.current.setWire(wire);
        }, [wire]);

        React.useEffect(function () {
          if (engineRef.current && engineRef.current.hasMesh()) engineRef.current.setMeasure(measure);
        }, [measure]);

        // ---- 对话建模：把自然语言描述交给宿主会话里的 agent 生成代码并执行 ----
        var progressTimerRef = React.useRef(null);
        function stopProgressPoll() {
          if (progressTimerRef.current) { clearInterval(progressTimerRef.current); progressTimerRef.current = null; }
        }
        React.useEffect(function () { return stopProgressPoll; }, []);

        function runNaturalLanguage() {
          var text = nlText.trim();
          if (!text || nlBusy) return;
          setNlBusy(true); setError(''); setNlLog('');
          // 生成任务号，随请求体传给后端，供进度轮询
          var taskId = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
          // 轮询进度并把阶段列表实时显示在左侧
          stopProgressPoll();
          var ticks = 0;
          progressTimerRef.current = setInterval(function () {
            ticks++;
            if (ticks > 600) { stopProgressPoll(); return; } // 5 分钟上限
            xhrSend('GET', 'api/usd-brep/progress?id=' + encodeURIComponent(taskId), null, function (perr, pres) {
              if (perr || !pres.json || pres.json.ok !== true) return;
              var lines = pres.json.stages.map(function (s) { return s.text; });
              setNlLog(lines.join('\n'));
            });
          }, 800);
          xhrSend('POST', 'api/usd-brep/nlbuild', { prompt: text, taskId: taskId }, function (err, res) {
            stopProgressPoll();
            setNlBusy(false);
            // 最终进度刷一遍（含“全部完成”或失败行）
            xhrSend('GET', 'api/usd-brep/progress?id=' + encodeURIComponent(taskId), null, function (perr, pres) {
              if (!perr && pres.json && pres.json.ok === true) {
                var lines = pres.json.stages.map(function (s) { return s.text; });
                setNlLog(lines.join('\n'));
              }
            });
            if (err) { setError(String(err)); return; }
            var j = res.json;
            if (!j || j.ok !== true) {
              setError((j && (j.stderr || j.error)) || ('HTTP ' + res.status));
              return;
            }
            if (j.code) setCustomCode(j.code);
            var data = { points: j.points, triangles: j.triangles };
            lastMeshRef.current = data;
            setMeta({ vertices: data.points.length, triangles: data.triangles.length, volume: j.volume });
            if (engineRef.current) {
              engineRef.current.setMesh(data.points, data.triangles, wire);
              engineRef.current.setMeasure(measure);
            }
          });
        }

        var dims = null;
        if (measure && lastMeshRef.current) {
          var pts = lastMeshRef.current.points;
          var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
          for (var i = 0; i < pts.length; i++) {
            for (var a = 0; a < 3; a++) {
              if (pts[i][a] < mn[a]) mn[a] = pts[i][a];
              if (pts[i][a] > mx[a]) mx[a] = pts[i][a];
            }
          }
          dims = {
            x: mx[0] - mn[0], y: mx[1] - mn[1], z: mx[2] - mn[2],
            diag: Math.sqrt((mx[0]-mn[0])*(mx[0]-mn[0]) + (mx[1]-mn[1])*(mx[1]-mn[1]) + (mx[2]-mn[2])*(mx[2]-mn[2])),
          };
        }

        function toolbarBtn(label, onClick, active) {
          return h('button', {
            key: label,
            style: Object.assign({}, styles.tbBtn, active ? styles.tbBtnActive : null),
            onClick: onClick,
          }, label);
        }

        var field = function (label, key, step) {
          return h('div', { key: key, style: styles.row },
            h('span', { style: styles.label }, label),
            h('input', {
              type: 'number', step: step || 0.1, value: params[key], style: styles.input,
              onChange: function (e) {
                var next = Object.assign({}, params);
                next[key] = e.target.value;
                setParams(next);
              },
            }));
        };

        return h('div', { style: styles.frame },
          h('div', { style: styles.left },
            // 上部：可滚动的信息区（错误 / 结果）
            h('div', { style: styles.leftScroll },
            h('div', { style: styles.title }, 'usd_brep 建模工作台'),
            status && h('div', { style: styles.status }, status),
            error && h('div', { style: styles.error }, '⚠ ' + error),
            meta && h('div', { style: styles.meta },
              '体积 ', h('b', null, String(meta.volume)),
              ' · ', meta.vertices, ' 顶点 · ', meta.triangles, ' 三角面'),
            h('div', { style: styles.hint },
              '用下方输入框描述想要的模型，AI 会生成 usd_brep 代码并实时渲染。'),
            ), // /leftScroll

            // ---- 对话建模：DSH composer 风格，固定在左栏底部 ----
            h('div', { style: styles.nlSection },
              h('div', { style: styles.nlBox },
                h('textarea', {
                  style: styles.nlTextarea, value: nlText, spellCheck: false,
                  placeholder: '描述你要的模型…',
                  rows: 1,
                  onChange: function (e) { setNlText(e.target.value); },
                  onKeyDown: function (e) {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runNaturalLanguage(); }
                  },
                }),
                h('div', { style: styles.nlRow },
                  nlBusy
                    ? h('span', { style: styles.nlBusy }, '🤔 建模中…')
                    : h('span', { style: styles.nlMicro }, 'Enter 发送 · Shift+Enter 换行'),
                  h('div', { style: styles.tbFlex }),
                  nlBusy
                    ? h('div', { style: styles.nlSendBusy }, '…')
                    : h('button', {
                        style: Object.assign({}, styles.nlSend, nlText.trim() ? null : styles.nlSendDim),
                        title: '生成',
                        onClick: runNaturalLanguage,
                      }, '↑'),
                ),
              ),
              nlLog && h('div', { style: styles.nlStages },
                nlLog.split('\n').map(function (line, i) {
                  return h('div', { key: i, style: styles.nlStageLine }, line);
                })),
            ),

            showCustom && h('div', { style: styles.overlay, onClick: function () { setShowCustom(false); } },
              h('div', { style: styles.dialog, onClick: function (e) { e.stopPropagation(); } },
                h('div', { style: styles.dialogTitle }, '自定义建模代码'),
                h('div', { style: styles.dialogHint },
                  '用 usd_brep API 建模，最后定义变量 ', h('code', null, 'brep'), '（Brep 实体）。可用：usd_brep / math / json。'),
                h('textarea', {
                  style: styles.textarea, value: customCode, spellCheck: false,
                  onChange: function (e) { setCustomCode(e.target.value); },
                }),
                h('div', { style: styles.dialogActions },
                  h('button', { style: styles.ghostBtn, onClick: function () { setCustomCode(CUSTOM_TEMPLATE); } }, '重置示例'),
                  h('button', { style: styles.ghostBtn, onClick: function () { setShowCustom(false); } }, '取消'),
                  h('button', {
                    style: styles.button2,
                    onClick: function () { setShowCustom(false); run(); },
                  }, '✔ 应用并生成')),
              )),
          ),
          h('div', { style: styles.right },
            h('div', { style: styles.toolbar },
              toolbarBtn('⟲ 重置', function () { if (engineRef.current) engineRef.current.resetView(); }),
              toolbarBtn('⤢ 适合', function () { if (engineRef.current) engineRef.current.fit(); }),
              h('div', { style: styles.tbSep }),
              toolbarBtn('线框', function () { setWire(function (w) { return !w; }); }, wire),
              toolbarBtn('测量', function () { setMeasure(function (m) { return !m; }); }, measure),
              toolbarBtn('截图', function () { if (engineRef.current) engineRef.current.screenshot(); }),
              h('div', { style: styles.tbFlex }),
              h('span', { style: styles.tbTitle }, 'NURBS BRep 实时视图'),
            ),
            h('div', { ref: canvasRef, style: styles.canvas }),
            threeState.current === 'loading' && h('div', { style: styles.centerNote }, '加载 three.js…'),

            measure && dims && h('div', { style: styles.measureCard },
              h('div', { style: styles.measureTitle }, '📏 测量'),
              h('div', { style: styles.measureRow }, h('span', null, '尺寸 X'), h('b', null, fmt(dims.x))),
              h('div', { style: styles.measureRow }, h('span', null, '尺寸 Y'), h('b', null, fmt(dims.y))),
              h('div', { style: styles.measureRow }, h('span', null, '尺寸 Z'), h('b', null, fmt(dims.z))),
              h('div', { style: styles.measureRow }, h('span', null, '对角线'), h('b', null, fmt(dims.diag))),
              meta && h('div', { style: styles.measureRow }, h('span', null, '体积'), h('b', null, String(meta.volume))),
            ),
          ),
        );
      }

      // XHR-based helpers: the desktop shell wraps window.fetch and (as of the
      // current build) attaches a body even to GET, which fetch rejects.
      // XMLHttpRequest is immune and reaches the host through the same channel.
      function xhrSend(method, url, bodyObj, onDone) {
        try {
          var xhr = new XMLHttpRequest();
          xhr.open(method, url, true);
          if (bodyObj != null) xhr.setRequestHeader('content-type', 'application/json');
          xhr.onload = function () {
            var j = null;
            try { j = JSON.parse(xhr.responseText); } catch (e) { /* non-JSON */ }
            onDone(null, { status: xhr.status, json: j, text: xhr.responseText });
          };
          xhr.onerror = function () { onDone(new Error('网络错误（XHR onerror）')); };
          xhr.send(bodyObj != null ? JSON.stringify(bodyObj) : null);
        } catch (e) { onDone(e); }
      }

      function loadThree(url, ok, fail) {
        if (window.THREE) { ok(); return; }
        try {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                (0, eval)(xhr.responseText); // UMD build assigns window.THREE
                if (window.THREE) ok();
                else fail(new Error('three.js 已下载但未定义 THREE 全局'));
              } catch (e) { fail(String(e && e.message ? e.message : e)); }
            } else {
              fail(new Error('HTTP ' + xhr.status));
            }
          };
          xhr.onerror = function () { fail(new Error('网络错误（XHR onerror）')); };
          xhr.send();
        } catch (e) { fail(String(e && e.message ? e.message : e)); }
      }

      function initScene(container) {
        var THREE = window.THREE;
        var scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0a0a14);
        var camera = new THREE.PerspectiveCamera(45, 1, 0.01, 2000);
        var renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        container.appendChild(renderer.domElement);
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        renderer.domElement.style.display = 'block';

        scene.add(new THREE.AmbientLight(0xffffff, 0.5));
        var key = new THREE.DirectionalLight(0xffffff, 1.7); key.position.set(5, 8, 4); scene.add(key);
        var rim = new THREE.DirectionalLight(0x88aaff, 0.6); rim.position.set(-5, -2, -4); scene.add(rim);
        var grid = new THREE.GridHelper(14, 14, 0x2a3a55, 0x1a1a2e); scene.add(grid);

        var group = new THREE.Group(); scene.add(group);
        var meshObj = null, edgesObj = null, bboxHelper = null, measureOn = false;

        var HOME = { theta: Math.PI / 4, phi: Math.PI / 3.2 };
        var radius = 10, theta = HOME.theta, phi = HOME.phi;
        var target = new THREE.Vector3(0, 0, 0);
        var dragging = false, button = 0, lastX = 0, lastY = 0;

        function onDown(e) { dragging = true; button = e.button; lastX = e.clientX; lastY = e.clientY; }
        function onUp() { dragging = false; }
        function onMove(e) {
          if (!dragging) return;
          var dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
          if (button === 0) { theta -= dx * 0.008; phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi - dy * 0.008)); }
          else {
            var fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
            var right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
            target.addScaledVector(right, dx * 0.01 * radius / 10).addScaledVector(camera.up, -dy * 0.01 * radius / 10);
          }
        }
        function onWheel(e) { radius = Math.max(0.2, Math.min(500, radius * (1 + e.deltaY * 0.001))); e.preventDefault(); }
        var el = renderer.domElement;
        el.addEventListener('pointerdown', onDown);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointermove', onMove);
        el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        el.addEventListener('wheel', onWheel, { passive: false });

        var running = true;
        (function loop() {
          if (!running) return;
          requestAnimationFrame(loop);
          var w = container.clientWidth || 1, hh = container.clientHeight || 1;
          var dw = Math.round(w * (window.devicePixelRatio || 1));
          var dh = Math.round(hh * (window.devicePixelRatio || 1));
          if (el.width !== dw || el.height !== dh) renderer.setSize(w, hh, false);
          if (Math.abs(camera.aspect - w / hh) > 0.001) { camera.aspect = w / hh; camera.updateProjectionMatrix(); }
          camera.position.set(
            target.x + radius * Math.sin(phi) * Math.cos(theta),
            target.y + radius * Math.cos(phi),
            target.z + radius * Math.sin(phi) * Math.sin(theta));
          camera.lookAt(target);
          renderer.render(scene, camera);
        })();

        function showBbox() {
          if (bboxHelper) { scene.remove(bboxHelper); bboxHelper.geometry.dispose?.(); bboxHelper.material.dispose?.(); bboxHelper = null; }
          if (measureOn && meshObj) {
            var box3 = new THREE.Box3().setFromObject(meshObj);
            bboxHelper = new THREE.Box3Helper(box3, 0x33ddff);
            scene.add(bboxHelper);
          }
        }

        function clearMesh() {
          if (meshObj) { group.remove(meshObj); meshObj.geometry.dispose(); meshObj.material.dispose(); meshObj = null; }
          if (edgesObj) { group.remove(edgesObj); edgesObj.geometry.dispose(); edgesObj.material.dispose(); edgesObj = null; }
          if (bboxHelper) { scene.remove(bboxHelper); bboxHelper.geometry.dispose?.(); bboxHelper.material.dispose?.(); bboxHelper = null; }
        }

        return {
          setMesh: function (points, triangles, wire) {
            clearMesh();
            var geo = new THREE.BufferGeometry();
            var flat = [];
            for (var i = 0; i < points.length; i++) flat.push(points[i][0], points[i][1], points[i][2]);
            geo.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
            var idx = [];
            for (var t = 0; t < triangles.length; t++) idx.push(triangles[t][0], triangles[t][1], triangles[t][2]);
            geo.setIndex(idx);
            geo.computeVertexNormals();
            geo.computeBoundingSphere();
            var c = geo.boundingSphere.center, rr = Math.max(geo.boundingSphere.radius, 0.2);
            group.position.set(-c.x, -c.y, -c.z);
            radius = rr * 3.2; target.set(0, 0, 0);
            theta = HOME.theta; phi = HOME.phi;
            grid.position.y = -rr * 1.15;
            grid.scale.setScalar(rr / 4);
            meshObj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
              color: 0xffa552, metalness: 0.35, roughness: 0.35, side: THREE.DoubleSide,
            }));
            group.add(meshObj);
            edgesObj = new THREE.LineSegments(
              new THREE.EdgesGeometry(geo, 25),
              new THREE.LineBasicMaterial({ color: 0x33ddff, transparent: true, opacity: 0.35 }));
            edgesObj.visible = wire; group.add(edgesObj);
            showBbox();
          },
          setWire: function (w) { if (edgesObj) edgesObj.visible = w; },
          setMeasure: function (on) { measureOn = on; showBbox(); },
          fit: function () {
            if (!meshObj) return;
            var geo = meshObj.geometry;
            geo.computeBoundingSphere();
            radius = Math.max(geo.boundingSphere.radius, 0.2) * 3.2;
            target.set(0, 0, 0);
          },
          resetView: function () {
            theta = HOME.theta; phi = HOME.phi; target.set(0, 0, 0);
            if (meshObj) this.fit();
          },
          hasMesh: function () { return !!meshObj; },
          screenshot: function () {
            try {
              var url = renderer.domElement.toDataURL('image/png');
              var a = document.createElement('a');
              a.href = url; a.download = 'usd-brep-' + Date.now() + '.png';
              document.body.appendChild(a); a.click(); a.remove();
            } catch (e) { console.error('[usd-brep] screenshot failed', e); }
          },
          dispose: function () {
            running = false; clearMesh();
            el.removeEventListener('pointerdown', onDown);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointermove', onMove);
            renderer.dispose();
            if (el.parentNode) el.parentNode.removeChild(el);
          },
        };
      }

      // ---------- styles: light left / dark right ----------
      var styles = {
        frame: { display: 'flex', width: '100%', height: '100%', minHeight: '560px', background: '#0a0a14', fontFamily: 'system-ui, sans-serif', position: 'relative', overflow: 'hidden' },
        left: { width: '33.33%', minWidth: 300, boxSizing: 'border-box', background: '#f7f8fa', color: '#1a1a2e', borderRight: '1px solid #e2e5ea', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
        leftScroll: { flex: 1, overflowY: 'auto', padding: '18px 16px', minHeight: 0 },
        title: { fontSize: 16, fontWeight: 700, marginBottom: 16, color: '#b45309' },
        row: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
        label: { width: 96, flexShrink: 0, fontSize: 13, color: '#5a6270' },
        input: { flex: 1, minWidth: 0, padding: '7px 9px', borderRadius: 6, border: '1px solid #d5d9e0', background: '#ffffff', color: '#1a1a2e', fontSize: 13, outline: 'none' },
        button: { width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: '#2f6bff', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', marginTop: 6 },
        button2: { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#2f6bff', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
        linkBtn: { padding: '4px 10px', borderRadius: 6, border: '1px solid #2f6bff', background: 'transparent', color: '#2f6bff', fontSize: 12, cursor: 'pointer' },
        status: { marginTop: 10, fontSize: 13, color: '#2563eb' },
        error: { marginTop: 10, fontSize: 13, color: '#dc2626', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
        meta: { marginTop: 12, fontSize: 13, color: '#15803d' },
        hint: { marginTop: 18, fontSize: 12, color: '#9aa1ad', lineHeight: 1.6 },
        codePreview: { marginTop: 4, marginBottom: 12, padding: '8px 10px', borderRadius: 6, background: '#eef1f5', border: '1px solid #e2e5ea', color: '#475569', fontSize: 11, fontFamily: 'Consolas, monospace', whiteSpace: 'pre-wrap', maxHeight: 110, overflow: 'hidden' },
        nlSection: { flexShrink: 0, margin: '10px 12px 12px' },
        nlBox: { background: '#ffffff', border: '1px solid #d5d9e0', borderRadius: 22, padding: '10px 10px 8px 14px', boxShadow: '0 1px 3px rgba(20,20,46,0.08)' },
        nlTextarea: { width: '100%', boxSizing: 'border-box', border: 'none', outline: 'none', background: 'transparent', color: '#1a1a2e', fontSize: 13, fontFamily: 'inherit', lineHeight: 1.5, resize: 'none', maxHeight: 120, overflowY: 'auto' },
        nlRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 },
        nlMicro: { fontSize: 11, color: '#9aa1ad' },
        nlBusy: { fontSize: 12, color: '#1d4ed8' },
        nlSend: { width: 30, height: 30, borderRadius: 15, border: 'none', background: '#2f6bff', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', lineHeight: '30px', padding: 0, flexShrink: 0 },
        nlSendDim: { background: '#c6d4f7', cursor: 'default' },
        nlSendBusy: { width: 30, height: 30, borderRadius: 15, background: '#eef1f5', color: '#9aa1ad', fontSize: 15, textAlign: 'center', lineHeight: '30px', flexShrink: 0 },
        nlLog: { marginTop: 8, fontSize: 12, color: '#1d4ed8', paddingLeft: 4 },
        nlStages: { marginTop: 8, padding: '6px 10px', borderRadius: 8, background: '#f3f6fb', border: '1px solid #e3e9f2', maxHeight: 200, overflowY: 'auto' },
        nlStageLine: { fontSize: 12, color: '#3b5b8f', lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
        right: { flex: 1, position: 'relative', overflow: 'hidden', background: '#0a0a14', minHeight: '360px' },
        canvas: { position: 'absolute', inset: 0 },
        centerNote: { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', color: '#667', fontSize: 14 },
        toolbar: { position: 'absolute', top: 0, left: 0, right: 0, height: 46, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', background: 'rgba(16,16,30,0.88)', borderBottom: '1px solid #23233c', zIndex: 20 },
        tbBtn: { padding: '5px 12px', borderRadius: 6, border: '1px solid #2c2c4a', background: '#161628', color: '#aab', fontSize: 12, cursor: 'pointer', lineHeight: 1.4 },
        tbBtnActive: { background: '#2f6bff', borderColor: '#2f6bff', color: '#fff' },
        tbSep: { width: 1, height: 20, background: '#2c2c4a' },
        tbFlex: { flex: 1 },
        tbTitle: { fontSize: 12, color: '#556' },
        measureCard: { position: 'absolute', top: 58, right: 12, width: 200, background: 'rgba(16,16,30,0.92)', border: '1px solid #2c2c4a', borderRadius: 10, padding: '10px 12px', zIndex: 20, color: '#ccd' },
        measureTitle: { fontSize: 13, fontWeight: 600, color: '#33ddff', marginBottom: 8 },
        measureRow: { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#99a', marginBottom: 4 },
        overlay: { position: 'fixed', inset: 0, background: 'rgba(15,15,30,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
        dialog: { width: 'min(760px, 90vw)', background: '#ffffff', border: '1px solid #e2e5ea', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 10, color: '#1a1a2e' },
        dialogTitle: { fontSize: 15, fontWeight: 700, color: '#b45309' },
        dialogHint: { fontSize: 12, color: '#5a6270', lineHeight: 1.5 },
        textarea: { width: '100%', height: 340, boxSizing: 'border-box', padding: 12, borderRadius: 8, border: '1px solid #d5d9e0', background: '#fbfcfe', color: '#1a1a2e', fontSize: 13, fontFamily: 'Consolas, Menlo, monospace', lineHeight: 1.5, resize: 'vertical', outline: 'none' },
        dialogActions: { display: 'flex', gap: 10, justifyContent: 'flex-end' },
        ghostBtn: { padding: '8px 14px', borderRadius: 8, border: '1px solid #d5d9e0', background: '#fff', color: '#5a6270', fontSize: 13, cursor: 'pointer' },
      };

      return {
        inject: ['slots'],
        apply: function (ctx) {
          ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: 'usd-brep-studio' }, Panel);
          });
          ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register(
              { name: 'sidebar.panellist', id: 'usd-brep-studio', order: 30, label: 'usd_brep 建模工作台' },
              function (props) {
                var size = props && typeof props.size === 'number' ? props.size : 20;
                return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true },
                  h('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: '#ffa552', 'stroke-width': 2.4 }),
                  h('circle', { cx: 12, cy: 12, r: 3.4, fill: 'none', stroke: '#ffa552', 'stroke-width': 2 }));
              });
          });
        },
      };
    },
  });
})();

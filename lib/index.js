/**
 * dsh-usd-brep — DSH host plugin that drives the NVIDIA-Omniverse `usd-brep`
 * Python library (NURBS-based BRep solid modeling with native OpenUSD I/O)
 * from a DSH agent via host tools.
 *
 * 插件运行在 profile 的 node_modules 下，解析不到 @deepseek-ai/dsh-tools，
 * 所以【不 import 任何 @deepseek-ai 运行时包】。工具定义直接满足
 * ctx.tools.register() 契约：
 *   { name, description, parameters(标准 JSON Schema),
 *     output:{schema, render}, timeoutMs, execute }
 * 唯一允许的外部依赖是 @deepseek-ai/schemastery（构建 Config 用）。
 *
 * usd_brep 需要 CPython 3.12（wheel 只发 3.12，64 位，Windows/Linux x86_64/
 * aarch64）。插件在本地用 uv 管理的 3.12 解释器创建一个独立 venv
 * （D:\usd-brep\.venv 或 config.venvDir），首次用时 `pip install usd-brep`，
 * 然后 spawn 该 venv 的 python 运行用户传入的 snippet 或对内置示例做
 * BRep 运算并把结果（含导出的 .usda 文件路径）回传。
 */

import { execSync, spawn } from "node:child_process";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import z from "@deepseek-ai/schemastery";

/** 插件包根目录（lib/index.js 的上一级），用于定位随包资源。 */
const package_dir = join(dirname(fileURLToPath(import.meta.url)), "..");

export const name = "usd-brep";
// llm 为可选依赖：不可用时对话建模路由自动降级（返回友好提示）。
export const inject = ["tools", "connection", "llm"];

/** 插件配置（zod schema）+ 默认值。apply() 里两者显式合并。 */
export const Config = z.object({
  /** uv 托管的 CPython 3.12 解释器路径（留空则自动探测 py -3.12 / uv）。 */
  pythonExe: z.string().default(""),
  /** venv 根目录；空 = 每用户默认（~/.dsh-usd-brep-venv）；相对路径按 process.cwd() 解析。 */
  venvDir: z.string().default(""),
  /** 是否自动安装 usd-brep（缺省时安装）。 */
  autoInstall: z.boolean().default(true),
  /** 运行 snippet 时的 cwd。 */
  workDir: z.string().default(""),
  /** snippet 执行超时（毫秒）。 */
  timeoutMs: z.number().default(120_000),
  /** 默认要导出的 .usda 文件名（run_example 用）。 */
  defaultUsda: z.string().default("brep_example.usda"),
});

const DEFAULTS = {
  pythonExe: "",
  venvDir: "",
  autoInstall: true,
  workDir: "",
  timeoutMs: 120_000,
  defaultUsda: "brep_example.usda",
};

/** venv 默认目录：每用户稳定位置，与宿主进程 cwd 无关（发布安全）。 */
function defaultVenvDir() {
  return join(homedir(), ".dsh-usd-brep-venv");
}

/** 解析配置里的 venvDir（空 → 每用户默认；相对 → 按 cwd 解析）。 */
function resolveVenvDir(venvDir) {
  if (!venvDir) return defaultVenvDir();
  return isAbsolute(venvDir) ? venvDir : resolve(process.cwd(), venvDir);
}

/* ---------- 小工具 ---------- */

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** 定位 venv 里的 python 可执行文件（Windows 是 Scripts/python.exe，其余 bin/python）。 */
function venvPython(venvDir, isWin) {
  return isWin
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
}

/**
 * 保证 venv 已创建且 usd-brep 已安装；返回该 venv 的 python 可执行文件路径。
 * 需要 CPython 3.12：若 config.pythonExe 给了就用它作为 base 解释器，
 * 否则用 uv 托管的 3.12（Windows 默认位置）或 `py -3.12`。
 */
async function ensureVenv(config, signal) {
  const isWin = process.platform === "win32";
  const venvDir = resolveVenvDir(config.venvDir);
  const py = venvPython(venvDir, isWin);

  if (!(await pathExists(py))) {
    await mkdir(venvDir, { recursive: true });
    const base = await resolvePython312(config, isWin);
    const args = ["-m", "venv", venvDir];
    const venvRes = await runCmd(base, args, { signal });
    if (venvRes.code !== 0 || !(await pathExists(py))) {
      throw new Error(
        `usd-brep: failed to create CPython 3.12 venv at ${venvDir} using ${base} ` +
          `(exit=${venvRes.code}). stderr: ${venvRes.err.slice(0, 500)}`,
      );
    }
  }

  // 幂等安装 usd-brep（用 venv 自己的 pip）。
  if (config.autoInstall !== false) {
    if (spawnSyncProbe(py) === "missing") {
      const pipRes = await runCmd(py, ["-m", "pip", "install", "--quiet", "usd-brep"], { signal });
      if (pipRes.code !== 0) {
        throw new Error(
          `usd-brep: pip install usd-brep failed (exit=${pipRes.code}). ` +
            `stderr: ${pipRes.err.slice(0, 500)}`,
        );
      }
    }
  }
  return py;
}

/** 同步探测 `python -c "import usd_brep"`：ok / missing。用导入的 execSync（ESM 兼容）。 */
function spawnSyncProbe(py) {
  try {
    execSync(`"${py}" -c "import usd_brep"`, { timeout: 30_000, stdio: "ignore" });
    return "ok";
  } catch {
    return "missing";
  }
}

/** 解析可用的 CPython 3.12 解释器路径。 */
async function resolvePython312(config, isWin) {
  if (config.pythonExe && (await pathExists(config.pythonExe))) {
    return config.pythonExe;
  }
  if (isWin) {
    // 常见 uv 托管 3.12 位置（与本机探测一致）。
    const uvPy = join(
      process.env.USERPROFILE ?? "",
      "AppData", "Roaming", "uv", "python",
      "cpython-3.12.14-windows-x86_64-none", "python.exe",
    );
    if (await pathExists(uvPy)) return uvPy;
    // 退而求其次：用 py launcher。
    return "py";
  }
  return "python3.12";
}

/** 运行一条命令并等待退出，返回 { code, stdout, stderr }。 */
function runCmd(cmd, args, { signal, timeoutMs = 300_000, cwd } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      signal,
      cwd: cwd || undefined,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    if (signal) signal.addEventListener("abort", () => child.kill(), { once: true });
    child.on("error", (e) => rej(e));
    child.on("close", (code) => {
      res({ code, out, err });
    });
  });
}

/* ---------- 内置示例 snippet：建 BRep、布尔差、导出 .usda ---------- */

const EXAMPLE_SNIPPET = `
import json, tempfile, os
import usd_brep

def main():
    sphere = usd_brep.primitives.create_sphere((0.0, 0.0, 0.0), 1.0)
    box = usd_brep.primitives.create_box((0.0, 0.0, 0.0), 1.0, 1.0, 1.0)
    cut = usd_brep.booleans.boolean_difference(sphere, box)  # 缺一个八分体的球
    out = os.environ.get("USD_BREP_OUT", "brep_example.usda")
    usd_brep.usd.export_brep(cut, out)
    (back,) = usd_brep.usd.import_breps(out)
    return {"ok": True, "usda": out, "reimported": 1, "api": "usd_brep 1.0.1"}

print(json.dumps(main()))
`;

const VERSION_SNIPPET = `
import json, importlib
import usd_brep
v = getattr(usd_brep, "__version__", None)
mods = [n for n in dir(usd_brep) if not n.startswith("_")]
print(json.dumps({"version": v, "modules": mods}))
`;

/* ---------- 输出 schema ---------- */

const RUN_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    exit: { type: "number" },
    usda: { type: "string" },
    result: {},
    stderr: { type: "string" },
    message: { type: "string" },
  },
  required: ["ok", "exit"],
};

const VERSION_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    version: { type: "string" },
    modules: { type: "array", items: { type: "string" } },
    message: { type: "string" },
  },
  required: ["ok"],
};

function runBlocks(value, headline) {
  const lines = [headline, `exit=${value.exit}`];
  if (value.usda) lines.push(`usda=${value.usda}`);
  if (value.message) lines.push(value.message);
  if (value.result && value.result !== true && value.result !== "null") {
    lines.push(`result=${typeof value.result === "string" ? value.result : JSON.stringify(value.result)}`);
  }
  if (value.stderr) lines.push(`stderr: ${String(value.stderr).slice(0, 800)}`);
  const out = [{ type: "text", text: lines.join("\n") }];
  return out;
}

function versionBlocks(value, headline) {
  const lines = [headline];
  if (value.version) lines.push(`version=${value.version}`);
  if (value.modules?.length) lines.push(`modules: ${value.modules.join(", ")}`);
  if (value.message) lines.push(value.message);
  return [{ type: "text", text: lines.join("\n") }];
}

/* ---------- 工具定义工厂 ---------- */

function runExampleTool(ctx, config) {
  return {
    name: "usd_brep_run_example",
    description:
      "Run the built-in usd_brep BRep example: create a sphere & box, boolean-difference them, export a .usda and re-import. Returns the usda path and import sanity check.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        usda: { type: "string", description: "输出 .usda 文件路径；默认 config.defaultUsda" },
      },
    },
    output: { schema: RUN_OUTPUT, render: (a, v) => runBlocks(v, "usd_brep example") },
    timeoutMs: config.timeoutMs + 60_000,
    async execute(args, exec) {
      const py = await ensureVenv(config, exec.signal);
      const usda = args.usda || config.defaultUsda;
      const { code, out, err } = await runCmdWithEnv(
        py,
        ["-c", EXAMPLE_SNIPPET],
        { USD_BREP_OUT: usda },
        exec.signal,
        config.timeoutMs,
        config.workDir || undefined,
      );
      let result = null;
      try {
        result = JSON.parse(out.trim());
      } catch {
        result = out.trim();
      }
      const ok = code === 0 && result && result.ok === true;
      return {
        ok,
        exit: code,
        usda: result?.usda ?? usda,
        result,
        stderr: err.slice(0, 1000),
        message: ok ? "sphere-minus-box BRep exported & re-imported" : "run failed — see stderr",
      };
    },
  };
}

function runSnippetTool(ctx, config) {
  return {
    name: "usd_brep_run_snippet",
    description:
      "Execute a user-supplied Python snippet against usd_brep in the managed CPython 3.12 venv. The snippet is `exec`-ed; it must `print(json.dumps(...))` a final JSON value (any object) which is returned as `result`. Set env var USD_BREP_OUT to the .usda path if exporting.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: {
        code: { type: "string", description: "Python source to run (top-level statements allowed)" },
        usda: { type: "string", description: "Optional output .usda path (exported to env USD_BREP_OUT)" },
      },
    },
    output: { schema: RUN_OUTPUT, render: (a, v) => runBlocks(v, "usd_brep snippet") },
    timeoutMs: config.timeoutMs + 60_000,
    async execute(args, exec) {
      const py = await ensureVenv(config, exec.signal);
      const envUsda = args.usda ? { USD_BREP_OUT: args.usda } : undefined;
      const { code, out, err } = envUsda
        ? await runCmdWithEnv(py, ["-c", args.code], envUsda, exec.signal, config.timeoutMs, config.workDir || undefined)
        : await runCmd(py, ["-c", args.code], { signal: exec.signal, timeoutMs: config.timeoutMs, cwd: config.workDir || undefined });
      let result = null;
      try {
        result = JSON.parse(out.trim());
      } catch {
        result = out.trim();
      }
      const ok = code === 0;
      return {
        ok,
        exit: code,
        // DSH 工具桥要求返回值为 lossless JSON：undefined 属性会被整体拒绝，故省略。
        ...(args.usda ? { usda: args.usda } : {}),
        result,
        stderr: err.slice(0, 1000),
        message: ok ? "snippet completed" : "snippet exited non-zero — see stderr",
      };
    },
  };
}

async function runCmdWithEnv(cmd, args, env, signal, timeoutMs, cwd) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
      timeout: timeoutMs,
      signal,
      cwd: cwd || undefined,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    if (signal) signal.addEventListener("abort", () => child.kill(), { once: true });
    child.on("error", rej);
    child.on("close", (code) => res({ code, out, err }));
  });
}

function versionTool(ctx, config) {
  return {
    name: "usd_brep_version",
    description:
      "Probe the managed usd_brep environment: import the module and report its version + available submodules. Installs the venv if needed.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: { schema: VERSION_OUTPUT, render: (a, v) => versionBlocks(v, "usd_brep environment") },
    timeoutMs: config.timeoutMs + 60_000,
    async execute(_args, exec) {
      const py = await ensureVenv(config, exec.signal);
      const { code, out, err } = await runCmd(py, ["-c", VERSION_SNIPPET], {
        signal: exec.signal,
        timeoutMs: config.timeoutMs,
        cwd: config.workDir || undefined,
      });
      let parsed = null;
      try {
        parsed = JSON.parse(out.trim());
      } catch {
        parsed = {};
      }
      const ok = code === 0;
      return {
        ok,
        version: parsed.version ?? (ok ? "installed" : "unavailable"),
        modules: parsed.modules ?? [],
        message: ok ? "usd_brep importable" : err.slice(0, 500),
      };
    },
  };
}

/* ---------- apply ---------- */

/**
 * 建模网格脚手架：按 shape 参数建 BRep → 细分 → 输出三角网格 JSON。
 * shapes: washer | sphere_minus_box | torus | fillet_box | gear
 */
const BUILD_SNIPPET = `
import json, math, usd_brep

shape = SHAPE_JSON
kind = shape["kind"]
tol = float(shape.get("tolerance", 0.01))

def finish(brep, out_path):
    usd_brep.usd.export_brep(brep, out_path)
    (back,) = usd_brep.usd.import_breps(out_path)
    mesh = usd_brep.tessellate(back, chord_height_tolerance=tol, surface_angle_tolerance_deg=15.0)
    arr = mesh.to_mesh_arrays()
    flat = arr["faces"]
    tris = []
    i = 0
    while i < len(flat):
        n = flat[i]
        tris.append([flat[i+1], flat[i+2], flat[i+3]])
        i += 4
    return {
        "points": [[float(x), float(y), float(z)] for x, y, z in arr["points"]],
        "triangles": tris,
        "volume": round(float(usd_brep.compute_volume(back)), 6),
        "usdaPath": out_path,
        "exact": {
            "volume": round(float(usd_brep.compute_volume(brep)), 6),
            "area": round(float(brep.area() if callable(getattr(brep, "area", None)) else getattr(brep, "area", 0.0) or 0.0), 6),
        },
    }

import tempfile, os
out = os.path.join(tempfile.gettempdir(), "usd_brep_ui_build.usda")

if kind == "custom":
    # 用户代码模式：执行 custom_code，约定最后定义变量 brep（usd_brep Brep 对象）。
    _ns = {"usd_brep": usd_brep, "math": math, "json": json}
    exec(shape.get("custom_code", ""), _ns)
    brep = _ns.get("brep")
    if brep is None:
        raise ValueError("custom code must define a variable named 'brep'")
elif kind == "washer":
    R = float(shape.get("outerRadius", 3.0)); r = float(shape.get("innerRadius", 1.0)); h = float(shape.get("height", 0.5))
    body = usd_brep.primitives.create_cylinder((0.0, 0.0, -h/2), R, h)
    hole = usd_brep.primitives.create_cylinder((0.0, 0.0, -h), r, h*3)
    brep = usd_brep.booleans.boolean_difference(body, hole)
elif kind == "sphere_minus_box":
    R = float(shape.get("radius", 2.0)); s = float(shape.get("boxSize", 2.0))
    body = usd_brep.primitives.create_sphere((0.0, 0.0, 0.0), R)
    box = usd_brep.primitives.create_box((0.0, 0.0, 0.0), s, s, s)
    brep = usd_brep.booleans.boolean_difference(body, box)
elif kind == "torus":
    R = float(shape.get("majorRadius", 2.0)); r = float(shape.get("minorRadius", 0.6))
    brep = usd_brep.primitives.create_torus((0.0, 0.0, 0.0), R, r)
elif kind == "fillet_box":
    s = float(shape.get("size", 2.0)); f = float(shape.get("filletRadius", 0.3))
    brep = usd_brep.primitives.create_box((0.0, 0.0, 0.0), s, s, s)
    try:
        brep = usd_brep.fillet_edges(brep, f)
    except Exception:
        pass
elif kind == "gear":
    teeth = int(shape.get("teeth", 12)); R = float(shape.get("outerRadius", 3.0)); r = float(shape.get("innerRadius", 0.8)); h = float(shape.get("height", 0.6))
    body = usd_brep.primitives.create_cylinder((0.0, 0.0, -h/2), R, h)
    for t in range(teeth):
        ang = 2.0 * math.pi * t / teeth
        w = 0.55 * R * math.pi / teeth
        tooth = usd_brep.primitives.create_box((R * math.cos(ang), R * math.sin(ang), -h/2), R, w, h)
        body = usd_brep.booleans.boolean_union(body, tooth)
    hole = usd_brep.primitives.create_cylinder((0.0, 0.0, -h), r, h*3)
    brep = usd_brep.booleans.boolean_difference(body, hole)
else:
    raise ValueError("unknown shape kind: " + kind)

print(json.dumps({"ok": True, **finish(brep, out)}))
`;

function buildSnippetFor(shape) {
  return BUILD_SNIPPET.replace("SHAPE_JSON", JSON.stringify(shape));
}

/* ---------- 纯 JS STEP (AP214) 写出器：三角网格 → 平面壳 B-rep ---------- */
/* 每个三角形一个 ADVANCED_FACE（PLANE + LINE 边），闭合成 MANIFOLD_SOLID_BREP。
 * SolidWorks / FreeCAD / NX / UG / Fusion360 可直接导入。单位：mm（模型单位 × 1000）。 */

function meshToStep(points, triangles, productName = "usd_brep model") {
  const fmtNum = (n) => {
    if (!Number.isFinite(n)) return "0.";
    const s = Number(n).toPrecision(10);
    return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, ".") : s + ".";
  };
  const esc = (s) => String(s).replace(/'/g, "''");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const L = [];
  let idCounter = 100;
  const id = () => ++idCounter;

  /* header */
  L.push("ISO-10303-21;");
  L.push("HEADER;");
  L.push("FILE_DESCRIPTION(('ViewDefinition [design]'),'2;1');");
  L.push("FILE_NAME('" + esc(productName) + ".step','" + stamp + "',('dsh-usd-brep')," +
        "('dsh-usd-brep'),'mesh->planar-shell STEP','dsh-usd-brep','');");
  L.push("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));");
  L.push("ENDSEC;");
  L.push("DATA;");

  /* units + context (mm) */
  const MM = 1000.0;
  const siLen = id(); L.push("#" + siLen + "=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));");
  const siAng = id(); L.push("#" + siAng + "=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));");
  const unc   = id(); L.push("#" + unc + "=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#" + siLen + ",'distance_accuracy_value','confusion accuracy');");
  const ctx   = id(); L.push("#" + ctx + "=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#" + unc + "))GLOBAL_UNIT_ASSIGNED_CONTEXT((#" + siLen + ",#" + siAng + "))REPRESENTATION_CONTEXT('Context #1','3D'));");
  const pctx  = id(); L.push("#" + pctx + "=PRODUCT_CONTEXT('',#" + ctx + ",'mechanical');");
  const prod  = id(); L.push("#" + prod + "=PRODUCT('" + esc(productName) + "','" + esc(productName) + "','',(#" + pctx + "));");
  const pdef  = id(); L.push("#" + pdef + "=PRODUCT_DEFINITION('design','',#" + prod + ",#0);");
  const pshape= id(); L.push("#" + pshape + "=PRODUCT_DEFINITION_SHAPE('','',#" + pdef + ");");
  const pdsr  = id(); // 末尾再 push（引用 mssr）
  // pdsr 引用的 representation id 需要先有 body；用占位后补 —— 简单起见直接建一个空 MSA 引用链：
  // 实际更省事：MANIFOLD_SOLID_BREP → ADVANCED_BREP_SHAPE_REPRESENTATION → SHAPE_DEFINITION_REPRESENTATION。

  /* 共享几何 */
  const cartIds = points.map((p) => {
    const c = id();
    L.push("#" + c + "=CARTESIAN_POINT('',(" + fmtNum(p[0] * MM) + "," + fmtNum(p[1] * MM) + "," + fmtNum(p[2] * MM) + "));");
    return c;
  });

  const faceIds = [];
  for (const tri of triangles) {
    const ia = tri[0], ib = tri[1], ic = tri[2];
    const pa = points[ia], pb = points[ib], pc = points[ic];

    /* 顶点 */
    const vA = id(); L.push("#" + vA + "=VERTEX_POINT('',#" + cartIds[ia] + ");");
    const vB = id(); L.push("#" + vB + "=VERTEX_POINT('',#" + cartIds[ib] + ");");
    const vC = id(); L.push("#" + vC + "=VERTEX_POINT('',#" + cartIds[ic] + ");");

    /* 3 条边：LINE(起点, VECTOR(方向, 长度)) —— 参数 0..1 */
    const mkEdge = (vFrom, vTo, iFrom, iTo) => {
      const df = points[iTo], di = points[iFrom];
      const dx = df[0] - di[0], dy = df[1] - di[1], dz = df[2] - di[2];
      const len = Math.hypot(dx, dy, dz) * MM;
      const d = id(); L.push("#" + d + "=DIRECTION('',(" + fmtNum(dx) + "," + fmtNum(dy) + "," + fmtNum(dz) + "));");
      const v = id(); L.push("#" + v + "=VECTOR('',#" + d + "," + fmtNum(len) + ");");
      const ln = id(); L.push("#" + ln + "=LINE('',#" + cartIds[iFrom] + ",#" + v + ");");
      const e = id(); L.push("#" + e + "=EDGE_CURVE('',#" + vFrom + ",#" + vTo + ",#" + ln + ",.T.);");
      return e;
    };
    const eAB = mkEdge(vA, vB, ia, ib);
    const eBC = mkEdge(vB, vC, ib, ic);
    const eCA = mkEdge(vC, vA, ic, ia);
    const oeAB = id(); L.push("#" + oeAB + "=ORIENTED_EDGE('',*,*,#" + eAB + ",.T.);");
    const oeBC = id(); L.push("#" + oeBC + "=ORIENTED_EDGE('',*,*,#" + eBC + ",.T.);");
    const oeCA = id(); L.push("#" + oeCA + "=ORIENTED_EDGE('',*,*,#" + eCA + ",.T.);");
    const el = id(); L.push("#" + el + "=EDGE_LOOP('',(#" + oeAB + ",#" + oeBC + ",#" + oeCA + "));");

    /* 平面：AXIS2_PLACEMENT_3D(原点=pa, z=法向) */
    const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl2 = Math.hypot(nx, ny, nz) || 1;
    nx /= nl2; ny /= nl2; nz /= nl2;
    const nd = id(); L.push("#" + nd + "=DIRECTION('',(" + fmtNum(nx) + "," + fmtNum(ny) + "," + fmtNum(nz) + "));");
    const odir = id(); L.push("#" + odir + "=DIRECTION('',(1.,0.,0.));"); // 参考方向（可任取）
    const ax = id(); L.push("#" + ax + "=AXIS2_PLACEMENT_3D('',#" + cartIds[ia] + ",#" + nd + ",#" + odir + ");");
    const pl = id(); L.push("#" + pl + "=PLANE('',#" + ax + ");");

    const bound = id(); L.push("#" + bound + "=FACE_OUTER_BOUND('',#" + el + ",.T.);");
    const face = id(); L.push("#" + face + "=ADVANCED_FACE('',(#" + bound + "),#" + pl + ",.T.);");
    faceIds.push(face);
  }

  /* 壳 + 体 */
  const shell = id(); L.push("#" + shell + "=CLOSED_SHELL('',(" + faceIds.map((x) => "#" + x).join(",") + "));");
  const solid = id(); L.push("#" + solid + "=MANIFOLD_SOLID_BREP('" + esc(productName) + "',#" + shell + ");");
  const mssr  = id(); L.push("#" + mssr + "=MANIFOLD_SURFACE_SHAPE_REPRESENTATION('',(#" + solid + "),#" + ctx + ");");
  L.push("#" + pdsr + "=SHAPE_DEFINITION_REPRESENTATION(#" + pshape + ",#" + mssr + ");");

  L.push("ENDSEC;");
  L.push("END-ISO-10303-21;");
  return L.join("\n");
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) };

  // ---- 共享管线：LLM 生成代码 + 执行（工具与 HTTP 路由共用） ----
  const NL_SYSTEM = [
    "你是 usd_brep（NVIDIA Omniverse NURBS BRep 建模库）的代码生成器。",
    "用户会用中文描述想要的 3D 实体。你只输出一段可执行的 Python 代码（不要 markdown 代码块、不要解释）。",
    "代码约束：",
    "- 顶层可用名字：usd_brep（库）、math、json（已预导入）",
    "- 常用 API：usd_brep.primitives.create_cylinder((x,y,z), radius, height)、create_sphere(center, r)、create_box(center, sx, sy, sz)、create_torus(center, R, r)",
    "- 布尔：usd_brep.booleans.boolean_union(a,b) / boolean_difference(a,b) / boolean_intersection(a,b)",
    "- 圆角：usd_brep.fillet_edges(brep, radius)",
    "- 最后必须定义变量 brep = <最终的 Brep 实体>",
    "- 中心放在原点附近，尺寸合理（单位约定为英寸级，避免极端数值）",
    "示例输出：",
    "plate = usd_brep.primitives.create_cylinder((0,0,-0.4), 3.0, 0.8)",
    "bore = usd_brep.primitives.create_cylinder((0,0,-1), 0.6, 2)",
    "brep = usd_brep.booleans.boolean_difference(plate, bore)",
  ].join("\n");

  const buildExecute = async (shape, signal) => {
    const py = await ensureVenv(config, signal);
    const { code, out, err } = await runCmd(py, ["-c", buildSnippetFor(shape)], {
      signal,
      timeoutMs: config.timeoutMs,
    });
    if (code !== 0) {
      const e = new Error(`python exit ${code}`);
      e.stderr = err.slice(-1200);
      throw e;
    }
    return JSON.parse(out.trim());
  };

  const generateCodeFromPrompt = async (prompt, signal) => {
    const llm = ctx.llm;
    if (!llm || typeof llm.listProviders !== "function") {
      throw new Error("LLM 服务不可用（llm 未注入或未配置）");
    }
    const providers = llm.listProviders();
    if (!providers || providers.length === 0) {
      throw new Error("没有可用的 LLM provider（请先在 DSH 设置里配置模型）");
    }
    const provider = providers[0].id;
    const models = await llm.listModels(provider);
    if (!models || models.length === 0) {
      throw new Error(`provider ${provider} 没有可用模型`);
    }
    const model = models[0].id;
    let text = "";
    let finishReason = null;
    let finishError = null;
    for await (const chunk of llm.stream({
      provider,
      model,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      system: NL_SYSTEM,
      temperature: 0.2,
      maxTokens: 1500,
      signal,
    })) {
      if (chunk.type === "text-delta") text += chunk.text;
      else if (chunk.type === "finish") {
        finishReason = chunk.reason?.kind ?? null;
        finishError = chunk.reason?.failure?.message ?? null;
      }
    }
    if (finishReason === "error" || finishReason === "aborted") {
      throw new Error(`LLM 调用失败（${finishReason}）：${finishError ?? "未知原因"}`);
    }
    if (!text.trim()) {
      throw new Error(`LLM 返回空文本（finish=${finishReason ?? "none"}；请重试）`);
    }
    const fence = text.match(/```(?:python)?\s*\n([\s\S]*?)```/);
    const codeText = (fence ? fence[1] : text).trim();
    if (!codeText.includes("brep")) {
      throw new Error(
        "生成的代码没有定义 brep 变量。模型原始输出开头：\n" + text.slice(0, 400),
      );
    }
    return codeText;
  };

  const nlBuild = async (prompt, signal, onStage) => {
    const stage = async (text) => { if (onStage) try { await onStage(text); } catch { /* 阶段上报失败不影响主流程 */ } };
    await stage(`📋 请求：${prompt}`);
    await stage("🤖 正在调用 LLM 生成建模代码…");
    const pyCode = await generateCodeFromPrompt(prompt, signal);
    await stage(`✍️ 已生成代码（${pyCode.length} 字符），正在启动 Python 建模…`);
    const value = await buildExecute({ kind: "custom", custom_code: pyCode }, signal);
    await stage(`📐 建模完成：${value.points?.length} 顶点 · ${value.triangles?.length} 三角面`);
    const providers = ctx.llm?.listProviders?.() ?? [];
    return {
      ok: true,
      code: pyCode,
      summary: providers[0] ? `已生成（${providers[0].id}）` : "已生成",
      ...value,
    };
  };

  // ---- 自测工具：与 nlbuild HTTP 路由同一管线，便于从会话内全链路验证 ----
  ctx.tools.register({
    name: "usd_brep_nl_selftest",
    description:
      "Self-test the natural-language modeling pipeline end to end (LLM code generation + python execution), same path the studio panel uses. Returns the generated code, mesh stats, and volume.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "模型描述，如：带 4 个螺栓孔的法兰盘" },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          provider: { type: "string" },
          code: { type: "string" },
          points: { type: "number" },
          triangles: { type: "number" },
          volume: { type: "number" },
          error: { type: "string" },
        },
        required: ["ok"],
      },
      render: (a, v) => [
        { type: "text", text: v.ok
          ? `selftest OK — ${v.provider}: ${v.points} verts, ${v.triangles} tris, volume ${v.volume}`
          : `selftest FAILED: ${v.error}` },
      ],
    },
    timeoutMs: config.timeoutMs + 120_000,
    async execute(args, exec) {
      const prompt = (args.prompt || "带 4 个螺栓孔的法兰盘，外径 6，厚 0.8").trim();
      const providers = ctx.llm?.listProviders?.() ?? [];
      const provider = providers[0]?.id ?? "none";
      try {
        const result = await nlBuild(prompt, exec.signal);
        return {
          ok: true,
          provider,
          code: result.code,
          points: result.points.length,
          triangles: result.triangles.length,
          volume: result.volume,
        };
      } catch (error) {
        return {
          ok: false,
          provider,
          error: String(error?.message ?? error),
        };
      }
    },
  });

  const definitions = [
    versionTool(ctx, config),
    runExampleTool(ctx, config),
    runSnippetTool(ctx, config),
  ];
  for (const definition of definitions) ctx.tools.register(definition);

  // ---- Web UI 后端：POST /api/usd-brep/build → { points, triangles, volume } ----
  const register = ctx.connection?.fetch?.register;
  if (typeof register === "function") {
    // GET /api/usd-brep/three.js — 自托管 three.js（无 CDN 依赖，浏览器同源加载无 CORS）。
    const threePath = join(package_dir, "lib", "vendor", "three.min.js");
    ctx.effect(() =>
      register({
        path: "/api/usd-brep/three.js",
        methods: ["GET"],
        fetch: async () => {
          try {
            const body = await readFile(threePath);
            return new Response(body, {
              headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" },
            });
          } catch (e) {
            return new Response("// three.min.js missing: " + String(e?.message ?? e), {
              status: 404,
              headers: { "content-type": "text/javascript" },
            });
          }
        },
      }),
    );
    ctx.effect(() =>
      register({
        path: "/api/usd-brep/build",
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          let shape = null;
          try {
            shape = await request.json();
          } catch {
            return Response.json({ ok: false, error: "body is not JSON" }, { status: 400 });
          }
          if (typeof shape !== "object" || shape === null || typeof shape.kind !== "string") {
            return Response.json({ ok: false, error: "missing shape.kind" }, { status: 400 });
          }
          if (shape.kind === "custom" && typeof shape.custom_code !== "string") {
            return Response.json({ ok: false, error: "custom shape needs custom_code" }, { status: 400 });
          }
          try {
            const py = await ensureVenv(config, request.signal);
            const { code, out, err } = await runCmd(py, ["-c", buildSnippetFor(shape)], {
              signal: request.signal,
              timeoutMs: config.timeoutMs,
            });
            if (code !== 0) {
              return Response.json(
                { ok: false, error: `python exit ${code}`, stderr: err.slice(-1200) },
                { status: 500 },
              );
            }
            const value = JSON.parse(out.trim());
            return Response.json(value, { headers: { "cache-control": "no-store" } });
          } catch (error) {
            return Response.json(
              { ok: false, error: String(error?.message ?? error) },
              { status: 500 },
            );
          }
        },
      }),
    );

    // ---- 对话建模：POST /api/usd-brep/nlbuild { prompt } → agent 生成代码 + 执行 ----
    // 与 usd_brep_nl_selftest 工具共用 nlBuild 管线；阶段进度写入诊断日志，前端可读。
    const nlDiag = async (line) => {
      try {
        const { appendFile, mkdir } = await import("node:fs/promises");
        const logDir = join(homedir(), ".dsh-usd-brep-logs");
        await mkdir(logDir, { recursive: true });
        await appendFile(join(logDir, "nlbuild.log"), line + "\n");
      } catch { /* 诊断失败不影响主流程 */ }
    };

    // 进度通道：任务 id → 阶段数组。POST nlbuild 创建，GET progress 查询，带 TTL 清理。
    const progressMap = new Map();
    const progressTtlMs = 10 * 60 * 1000;
    const sweepProgress = () => {
      const now = Date.now();
      for (const [id, entry] of progressMap) {
        if (now - entry.t > progressTtlMs) progressMap.delete(id);
      }
    };

    // ---- STEP 导出：POST /api/usd-brep/export { points, triangles, name } → .step 文件 ----
    // 网格 → AP214 平面壳 B-rep（SolidWorks/FreeCAD/NX/UG 可读），单位 mm。
    ctx.effect(() =>
      register({
        path: "/api/usd-brep/export",
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          let body = null;
          try {
            body = await request.json();
          } catch {
            return Response.json({ ok: false, error: "body is not JSON" }, { status: 400 });
          }
          const points = body?.points;
          const triangles = body?.triangles;
          const name = typeof body?.name === "string" && body.name ? body.name.slice(0, 60) : "usd_brep_model";
          if (
            !Array.isArray(points) || points.length < 3 ||
            !Array.isArray(triangles) || triangles.length < 1
          ) {
            return Response.json({ ok: false, error: "mesh required (points + triangles)" }, { status: 400 });
          }
          try {
            const step = meshToStep(points, triangles, name);
            const safe = name.replace(/[^\w.-]+/g, "_") || "model";
            return new Response(step, {
              headers: {
                "content-type": "application/step",
                "content-disposition": `attachment; filename="${safe}.step"`,
                "cache-control": "no-store",
              },
            });
          } catch (error) {
            return Response.json(
              { ok: false, error: String(error?.message ?? error) },
              { status: 500 },
            );
          }
        },
      }),
    );

    ctx.effect(() =>
      register({
        path: "/api/usd-brep/progress",
        methods: ["GET"],
        fetch: async (request) => {
          sweepProgress();
          const id = new URL(request.url).searchParams.get("id");
          const entry = id ? progressMap.get(id) : undefined;
          return Response.json(
            entry ? { ok: true, stages: entry.stages, done: entry.done } : { ok: false },
            { headers: { "cache-control": "no-store" } },
          );
        },
      }),
    );

    ctx.effect(() =>
      register({
        path: "/api/usd-brep/nlbuild",
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          let body = null;
          try {
            body = await request.json();
          } catch {
            return Response.json({ ok: false, error: "body is not JSON" }, { status: 400 });
          }
          const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
          if (!prompt) {
            return Response.json({ ok: false, error: "missing prompt" }, { status: 400 });
          }
          // 任务 id：优先用前端传来的（便于提前开始轮询），否则自生成
          const taskId =
            typeof body?.taskId === "string" && body.taskId.length < 64
              ? body.taskId
              : String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
          const entry = { stages: [], done: false, t: Date.now() };
          progressMap.set(taskId, entry);
          const onStage = async (text) => {
            entry.stages.push({ at: Date.now(), text });
            await nlDiag(`[${taskId}] ${text}`);
          };
          try {
            const result = await nlBuild(prompt, request.signal, onStage);
            entry.done = true;
            entry.stages.push({ at: Date.now(), text: "✅ 全部完成" });
            return Response.json(
              { ...result, taskId },
              { headers: { "cache-control": "no-store" } },
            );
          } catch (error) {
            entry.done = true;
            entry.stages.push({ at: Date.now(), text: "❌ " + String(error?.message ?? error).slice(0, 200) });
            return Response.json(
              {
                ok: false,
                taskId,
                error: String(error?.message ?? error),
                stderr: typeof error?.stderr === "string" ? error.stderr : undefined,
              },
              { status: 500 },
            );
          }
        },
      }),
    );
  }
}

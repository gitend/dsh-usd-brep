import json, math, tempfile, os, usd_brep

# 复刻 shim 后的 custom 分支，用【错误签名】的代码验证容错：
shape = {"kind": "custom", "tolerance": 0.01,
         "custom_code": "box = usd_brep.primitives.create_box((0,0,0), 2.0, 2.0, 2.0)\nbrep = usd_brep.fillet_edges(box, 0.1)  # 故意写错签名（LLM 的典型错误）"}

_fe = usd_brep.fillet_edges
def _fillet_edges_shim(brep, edges, radius=None, **kw):
    if isinstance(edges, (int, float)):
        return _fe(brep, list(brep.edges()), radius=float(edges))
    if edges is None and radius is not None:
        return _fe(brep, list(brep.edges()), radius=radius, **kw)
    return _fe(brep, edges, radius=radius, **kw)
usd_brep.fillet_edges = _fillet_edges_shim
try:
    _ns = {"usd_brep": usd_brep, "math": math, "json": json}
    exec(shape["custom_code"], _ns)
finally:
    usd_brep.fillet_edges = _fe
brep = _ns["brep"]

out = os.path.join(tempfile.gettempdir(), "shim_test.usda")
usd_brep.usd.export_brep(brep, out)
(back,) = usd_brep.usd.import_breps(out)
print(json.dumps({
    "ok": True,
    "faces": back.face_count(),
    "edges": back.edge_count(),
    "volume": round(float(usd_brep.compute_volume(back)), 6),
    "hint": "rounded box volume should be < 8 (sharp 2^3)",
}))
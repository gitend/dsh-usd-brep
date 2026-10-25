import json, math, tempfile, os, usd_brep

# 复刻 BUILD_SNIPPET 的 finish() 修复版 + custom 分支，端到端验证
shape = {"kind": "custom", "tolerance": 0.01, "custom_code": "plate = usd_brep.primitives.create_cylinder((0,0,-0.25), 3.0, 0.5)\nbore = usd_brep.primitives.create_cylinder((0,0,-0.5), 1.0, 1.5)\nbrep = usd_brep.booleans.boolean_difference(plate, bore)"}
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

_ns = {"usd_brep": usd_brep, "math": math, "json": json}
exec(shape.get("custom_code", ""), _ns)
brep = _ns.get("brep")
if brep is None:
    raise ValueError("custom code must define a variable named 'brep'")

out = os.path.join(tempfile.gettempdir(), "usd_brep_ui_build.usda")
result = finish(brep, out)
print(json.dumps({
    "ok": True,
    "volume": result["volume"],
    "exact": result["exact"],
    "points": len(result["points"]),
    "triangles": len(result["triangles"]),
    "usdaPath": result["usdaPath"],
}))
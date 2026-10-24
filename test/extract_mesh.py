import json, usd_brep

(back,) = usd_brep.usd.import_breps("D:/usd-brep/sphere_r2_minus_box.usda")
mesh = usd_brep.tessellate(back, chord_height_tolerance=0.01, surface_angle_tolerance_deg=15.0)
arr = mesh.to_mesh_arrays()

# faces is a flat list with per-triangle count prefix: [3, a, b, c, 3, a, b, c, ...]
flat = arr["faces"]
tris = []
i = 0
while i < len(flat):
    n = flat[i]
    assert n == 3, f"expected triangle, got n={n}"
    tris.append([flat[i + 1], flat[i + 2], flat[i + 3]])
    i += 4

data = {
    "points": [[float(x), float(y), float(z)] for x, y, z in arr["points"]],
    "triangles": tris,
}

with open("D:/usd-brep/mesh_data.json", "w") as f:
    json.dump(data, f, separators=(",", ":"))

print(json.dumps({"ok": True, "vertices": len(data["points"]), "triangles": len(tris)}))

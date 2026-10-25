import json, usd_brep
body = usd_brep.primitives.create_cylinder((0,0,0), 3.0, 0.5)
a = getattr(body, "area", None)
print(json.dumps({
    "type": str(type(a)),
    "callable": callable(a),
    "called_value": float(a()) if callable(a) else None,
}))
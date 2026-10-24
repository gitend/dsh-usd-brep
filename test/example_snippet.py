import json, tempfile, os
import usd_brep

def main():
    sphere = usd_brep.primitives.create_sphere((0.0, 0.0, 0.0), 1.0)
    box = usd_brep.primitives.create_box((0.0, 0.0, 0.0), 1.0, 1.0, 1.0)
    cut = usd_brep.booleans.boolean_difference(sphere, box)
    out = os.environ.get("USD_BREP_OUT", "brep_example.usda")
    usd_brep.usd.export_brep(cut, out)
    (back,) = usd_brep.usd.import_breps(out)
    return {"ok": True, "usda": out, "reimported": 1, "api": "usd_brep 1.0.1"}

print(json.dumps(main()))

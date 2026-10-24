import json, importlib
import usd_brep
v = getattr(usd_brep, "__version__", None)
mods = [n for n in dir(usd_brep) if not n.startswith("_")]
print(json.dumps({"version": v, "modules": mods}))

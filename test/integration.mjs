/**
 * Integration test: run the registered tools' execute() end-to-end against
 * the real per-user venv (same one the installed plugin would use).
 * Requires: the default venv (homedir/.dsh-usd-brep-venv) with usd-brep installed.
 */
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const registered = [];
apply({ tools: { register: (d) => registered.push(d) } }, undefined);
const byName = Object.fromEntries(registered.map((d) => [d.name, d]));
assert.deepEqual(
  Object.keys(byName).sort(),
  ["usd_brep_run_example", "usd_brep_run_snippet", "usd_brep_version"],
  "three tools registered",
);

// A live AbortController signal — this is what triggered the old kill bug
// (setTimeout(...,0) killed the child on first tick whenever a signal existed).
const controller = new AbortController();
const exec = { signal: controller.signal };

// 1) version tool: must reach python, parse JSON, and report modules.
const v = await byName.usd_brep_version.execute({}, exec);
console.log("version tool result:", JSON.stringify(v, null, 2));
assert.equal(v.ok, true, "version tool ok");
assert.equal(v.version, "installed", "version fallback text (module has no __version__)");
assert.ok(Array.isArray(v.modules) && v.modules.length > 50, "modules list populated");
assert.ok(v.modules.includes("primitives") && v.modules.includes("booleans") && v.modules.includes("usd"), "key submodules present");

// 2) example tool: sphere - box, export + reimport, absolute usda path.
const usda = join(homedir(), "brep_example_integration.usda");
if (existsSync(usda)) unlinkSync(usda);
const r = await byName.usd_brep_run_example.execute({ usda }, exec);
console.log("example tool result:", JSON.stringify(r, null, 2));
assert.equal(r.ok, true, "example tool ok");
assert.equal(r.exit, 0, "example exit 0");
assert.equal(r.usda, usda, "usda path echoed");
assert.ok(existsSync(usda), "usda file written");
console.log("usda size:", (await import("node:fs/promises")).stat(usda).then(s => `${s.size} bytes`));

// 3) snippet tool: same code path as example but user-supplied.
const s = await byName.usd_brep_run_snippet.execute(
  {
    code:
      'import json, usd_brep\nv = usd_brep.primitives.create_sphere((0,0,0), 2.0)\nprint(json.dumps({"sphere_radius": 2.0, "ok": True}))',
  },
  exec,
);
console.log("snippet tool result:", JSON.stringify(s, null, 2));
assert.equal(s.ok, true, "snippet tool ok");
assert.equal(s.result.sphere_radius, 2.0, "snippet result parsed");

// Abort signal was never triggered; all three tools completed under a live signal.
console.log("integration: OK — version, example, snippet all ran under a live AbortSignal");

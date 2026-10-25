/**
 * Smoke test for dsh-usd-brep plugin: verify module shape + that apply()
 * registers the three tools against a mock ctx. Does NOT run python.
 */
import assert from "node:assert/strict";
import { name, inject, Config, apply } from "../lib/index.js";

assert.equal(name, "usd-brep", "plugin name");
assert.deepEqual(inject, ["tools", "connection", "llm"], "inject targets");

// Config is a schemastery object schema; it is used as metadata/typing for
// rawConfig. apply() merges over a DEFAULTS const that mirrors the schema
// fields, so we check the shape of Config (a live schema object) instead of
// calling .parse() — schemastery 3.x does not expose a zod-style .parse().
assert.ok(Config, "Config is a schema object");
assert.equal(typeof Config.toJSON, "function", "schema exposes .toJSON");

// apply() registers exactly the three tools, in order.
const registered = [];
const ctx = { tools: { register: (d) => registered.push(d) } };
apply(ctx, undefined);
assert.deepEqual(
  registered.map((d) => d.name),
  [
    "usd_brep_nl_selftest",
    "usd_brep_version",
    "usd_brep_run_example",
    "usd_brep_run_snippet",
  ],
  "tool registration order"
);

for (const d of registered) {
  assert.ok(d.description, `${d.name} has description`);
  assert.ok(d.parameters && d.parameters.type === "object", `${d.name} has JSON schema params`);
  assert.ok(d.output && d.output.schema, `${d.name} has output schema`);
  assert.equal(typeof d.output.render, "function", `${d.name} has render`);
  assert.equal(typeof d.timeoutMs, "number", `${d.name} has timeoutMs`);
  assert.equal(typeof d.execute, "function", `${d.name} has execute`);
}

// Raw config override merges over defaults.
const registered2 = [];
apply(
  { tools: { register: (d) => registered2.push(d) } },
  { timeoutMs: 5_000, defaultUsda: "custom.usda" },
);
assert.equal(registered2.length, 4);

console.log("smoke: OK —", registered.map((d) => d.name).join(", "));

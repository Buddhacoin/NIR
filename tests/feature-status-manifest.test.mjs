import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "docs/feature-status.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

test("feature status manifest has traceable conservative classifications", () => {
  assert.equal(manifest.format, "nir-feature-status-v1");
  assert.match(manifest.scope, /no public NIR network/i);
  assert.ok(Array.isArray(manifest.features) && manifest.features.length > 0);
  const ids = new Set();
  for (const feature of manifest.features) {
    assert.match(feature.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(ids.has(feature.id), false, `duplicate feature id: ${feature.id}`);
    ids.add(feature.id);
    assert.ok(["implemented", "partial", "specified-only"].includes(feature.implementation));
    assert.ok(["local-only", "planned"].includes(feature.availability));
    assert.ok(Array.isArray(feature.entrypoints));
    assert.ok(Array.isArray(feature.evidence) && feature.evidence.length > 0);
    for (const path of feature.evidence) {
      assert.equal(existsSync(resolve(root, path)), true, `missing evidence: ${path}`);
    }
    for (const command of feature.entrypoints) {
      assert.equal(typeof packageJson.scripts[command], "string", `missing npm script: ${command}`);
    }
    if (feature.availability === "planned") assert.equal(feature.implementation, "specified-only");
  }
});

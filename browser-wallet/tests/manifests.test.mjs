import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const readManifest = (folder) => JSON.parse(readFileSync(resolve(import.meta.dirname, `../${folder}/manifest.json`), "utf8"));

test("Chromium and Firefox builds have distinct supported backgrounds", () => {
  const chromium = readManifest("dist");
  const firefox = readManifest("dist-firefox");
  assert.equal(chromium.background.service_worker, "background.js");
  assert.deepEqual(firefox.background.scripts, ["background.js"]);
  assert.equal(firefox.background.service_worker, undefined);
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions.required, ["none"]);
  assert.equal(chromium.permissions.includes("storage"), true);
  assert.equal(firefox.permissions.includes("storage"), true);
});

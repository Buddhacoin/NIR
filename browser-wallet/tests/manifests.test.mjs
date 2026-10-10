import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";

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

test("store icons have the dimensions advertised in both manifests", async () => {
  for (const folder of ["dist", "dist-firefox"]) {
    const manifest = readManifest(folder);
    for (const size of [16, 48, 128]) {
      const filename = manifest.icons[String(size)];
      const metadata = await sharp(resolve(import.meta.dirname, `../${folder}/${filename}`)).metadata();
      assert.equal(metadata.width, size);
      assert.equal(metadata.height, size);
    }
  }
});

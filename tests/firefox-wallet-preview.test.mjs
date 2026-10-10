import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { firefoxPreviewManifest, stageFirefoxPreview } from "../blockchain/firefox-wallet-preview.mjs";

const chromeManifest = JSON.parse(readFileSync(new URL("../wallet-ui/manifest.json", import.meta.url)));

test("Firefox preview has its own signing identity and background fallback", () => {
  const manifest = firefoxPreviewManifest(chromeManifest);
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.background, { scripts: ["extension-background.js"] });
  assert.match(manifest.browser_specific_settings.gecko.id,
    /^\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/);
  assert.deepEqual(manifest.permissions, []);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions,
    { required: ["authenticationInfo", "financialAndPaymentInfo"] });
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "142.0");
  assert.equal(manifest.content_security_policy.extension_pages,
    chromeManifest.content_security_policy.extension_pages);
  assert.equal(chromeManifest.browser_specific_settings, undefined);
  assert.deepEqual(chromeManifest.background, { service_worker: "extension-background.js" });
});

test("Firefox preview refuses a source with expanded privileges", () => {
  assert.throws(() => firefoxPreviewManifest({ ...chromeManifest, permissions: ["tabs"] }),
    /source manifest/i);
  assert.throws(() => firefoxPreviewManifest({ ...chromeManifest,
    host_permissions: ["<all_urls>"] }), /source manifest/i);
  assert.throws(() => firefoxPreviewManifest({ ...chromeManifest,
    content_scripts: [{ matches: ["<all_urls>"], js: ["app.js"] }] }), /source manifest/i);
  assert.throws(() => firefoxPreviewManifest({ ...chromeManifest,
    content_security_policy: { ...chromeManifest.content_security_policy,
      sandbox: "allow-scripts" } }), /source manifest/i);
});

test("Firefox staging copies the fixed assets and refuses an existing destination", () => {
  const parent = mkdtempSync(join(tmpdir(), "nir-firefox-preview-test-"));
  try {
    const target = join(parent, "extension");
    assert.equal(stageFirefoxPreview(target), target);
    const staged = JSON.parse(readFileSync(join(target, "manifest.json")));
    assert.deepEqual(staged.background.scripts, ["extension-background.js"]);
    assert.equal(existsSync(join(target, "app.js")), true);
    assert.throws(() => stageFirefoxPreview(target), /EEXIST/);
    assert.throws(() => stageFirefoxPreview("relative/output"), /absolute directory/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

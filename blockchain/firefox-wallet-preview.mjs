#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// This stages an unsigned development package. It is not a production release or AMO upload.
const SOURCE = fileURLToPath(new URL("../wallet-ui/", import.meta.url));
const FILES = Object.freeze([
  "address-book.js", "app.js", "extension-background.js", "index.html",
  "manifest.webmanifest", "nir-coin-icon.png", "nir-coin-icon.svg",
  "node-selection.js", "nodes.json", "offline-signing.js", "qr.js", "style.css",
  "submission-status.js", "sw.js", "transaction-decoder.js",
]);
const FIREFOX_ID = "{9eeb5c1f-8628-4c41-98ce-1fd5a654091d}";
const CSP = "default-src 'self'; base-uri 'none'; connect-src 'self' http://127.0.0.1:*; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'";
const CHROME_FIELDS = ["action", "background", "content_security_policy", "description", "host_permissions",
  "icons", "key", "manifest_version", "name", "permissions", "version"];

function exactFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");
}

export function firefoxPreviewManifest(source) {
  if (!exactFields(source, CHROME_FIELDS) ||
      !exactFields(source.action, ["default_icon", "default_title"]) ||
      !exactFields(source.background, ["service_worker"]) ||
      !exactFields(source.content_security_policy, ["extension_pages"]) ||
      !exactFields(source.icons, ["16", "48", "128"]) ||
      source.action.default_icon !== "nir-coin-icon.png" ||
      source.action.default_title !== "NIR Wallet" ||
      Object.values(source.icons).some((icon) => icon !== "nir-coin-icon.png") ||
      source.manifest_version !== 3 || source.name !== "NIR Wallet" ||
      JSON.stringify(source.permissions) !== "[]" ||
      JSON.stringify(source.host_permissions) !== '["http://127.0.0.1/*"]' ||
      source.background.service_worker !== "extension-background.js" ||
      source.content_security_policy?.extension_pages !== CSP ||
      typeof source.version !== "string" ||
      !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(source.version)) {
    throw new Error("Firefox source manifest exceeds the reviewed Chrome preview policy");
  }
  return {
    ...source,
    background: { scripts: ["extension-background.js"] },
    // Pairing codes and transaction details cross the extension boundary to local services.
    browser_specific_settings: { gecko: {
      id: FIREFOX_ID, strict_min_version: "142.0",
      data_collection_permissions: { required: ["authenticationInfo", "financialAndPaymentInfo"] },
    } },
    // The source PNG is 256x256. Do not claim smaller dimensions.
    icons: { "256": "nir-coin-icon.png" },
  };
}

function boundedRegular(name) {
  const path = join(SOURCE, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || stat.nlink !== 1) {
    throw new Error(`Firefox preview asset is not a bounded regular file: ${name}`);
  }
  return readFileSync(path);
}

export function stageFirefoxPreview(output) {
  if (typeof output !== "string" || !isAbsolute(output) || output === "/") {
    throw new Error("Firefox preview output must be an explicit absolute directory");
  }
  const manifest = firefoxPreviewManifest(JSON.parse(boundedRegular("manifest.json")));
  const assets = FILES.map((name) => [name, boundedRegular(name)]);
  mkdirSync(output, { mode: 0o700 }); // Exclusive: never overwrite a user's existing directory.
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  for (const [name, content] of assets) {
    writeFileSync(join(output, name), content, { flag: "wx", mode: 0o600 });
  }
  return output;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: wallet:firefox-stage <absolute-new-directory>");
    console.log(`Unsigned Firefox preview staged at ${stageFirefoxPreview(process.argv[2])}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

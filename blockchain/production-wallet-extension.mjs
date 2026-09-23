import { createHash } from "node:crypto";

import { parseConsensusJson } from "./consensus-json.mjs";

const FILES = Object.freeze([
  "address-book.js", "app.js", "index.html", "manifest.json", "manifest.webmanifest",
  "nir-coin-icon.png", "nir-coin-icon.svg", "node-selection.js", "nodes.json",
  "offline-signing.js", "qr.js", "style.css", "sw.js", "transaction-decoder.js",
]);
const CSP = "default-src 'self'; base-uri 'none'; connect-src 'self' http://127.0.0.1:*; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'";
const EXTENSION_PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1spnrvEc4lOeKPugnlZ8dWGkhaW3ohhy/2d1PQbQOE7Y/8G00yMTZ9s3E6tYylHJqdX1K9Aw3wubM8Px4K6t3daeYZW7HBrKu8Y1Otkgw/0t4VehrzvhrkLqylNt+LWv0FD5uZuoTTNs9WRa5Mt8Zr7fEdygXmVNFlf5hlXo2EQ3MoGnOSp95tUBBgspqZaJH6rfH16QmY2fZvCVt+bv1i0fQ9sl4+gOP6FUwLwQ6GV1K1srf2QbRsIwqUXcP8Ce0kKyukq5hfQHiKfVOvk0iuvWoVrFqGo0OwMGQ5CUHXOukBuuOPuUHUtSVAnTm0cRle3WD4qWtVFK1WaY/jAs2wIDAQAB";

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}

function localReference(value, files) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 ||
      /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(value) || value.includes("\\") ||
      value.includes("%")) throw new Error("extension contains a remote or unsafe asset reference");
  const path = (value === "./" ? "index.html" : value.split(/[?#]/, 1)[0].replace(/^\.\//, ""));
  if (!path || path.startsWith("/") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      !files.has(path)) throw new Error("extension references an unverified asset");
  return path;
}

function validateManifest(text, files) {
  const manifest = parseConsensusJson(text);
  exact(manifest, ["action", "content_security_policy", "description", "host_permissions",
    "icons", "key", "manifest_version", "name", "permissions", "version"],
    "extension manifest");
  exact(manifest.action, ["default_icon", "default_popup", "default_title"], "extension action");
  exact(manifest.icons, ["16", "48", "128"], "extension icons");
  exact(manifest.content_security_policy, ["extension_pages"], "extension CSP");
  if (manifest.manifest_version !== 3 || manifest.name !== "NIR Wallet" ||
      typeof manifest.version !== "string" ||
      !/^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/.test(manifest.version) ||
      !Array.isArray(manifest.permissions) || manifest.permissions.length !== 0 ||
      JSON.stringify(manifest.host_permissions) !== JSON.stringify(["http://127.0.0.1/*"]) ||
      manifest.key !== EXTENSION_PUBLIC_KEY ||
      manifest.action.default_title !== "NIR Wallet" ||
      manifest.content_security_policy.extension_pages !== CSP) {
    throw new Error("extension permissions or CSP exceed the production policy");
  }
  localReference(manifest.action.default_popup, files);
  localReference(manifest.action.default_icon, files);
  for (const icon of Object.values(manifest.icons)) localReference(icon, files);
}

function validateCode(path, text, files) {
  if (/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\bimportScripts\s*\(/.test(text)) {
    throw new Error("extension executable code contains dynamic evaluation");
  }
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g)) {
    localReference(match[1], files);
  }
  for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    localReference(match[1], files);
  }
  for (const match of text.matchAll(/(?:\bnew\s+Worker|serviceWorker\.register)\s*\(\s*["']([^"']+)["']/g)) {
    localReference(match[1], files);
  }
  if (/\bimport\s*\(\s*[^"']/.test(text)) {
    throw new Error("extension contains a computed dynamic import");
  }
  if (path === "sw.js") {
    for (const match of text.matchAll(/["'](\.\/[^"']+)["']/g)) {
      localReference(match[1], files);
    }
  }
}

function validateHtml(text, files) {
  if (/<script\b(?![^>]*\bsrc=)|\bon[a-z]+\s*=|javascript:/i.test(text)) {
    throw new Error("extension HTML contains inline executable code");
  }
  for (const match of text.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
    localReference(match[1], files);
  }
}

export function validateProductionWalletExtensionArtifact(artifact) {
  if (artifact?.kind !== "wallet" || !Array.isArray(artifact.entries)) {
    throw new Error("production extension artifact is invalid");
  }
  const entries = new Map();
  for (const entry of artifact.entries) {
    const path = typeof entry?.path === "string" && entry.path.startsWith("wallet-ui/")
      ? entry.path.slice("wallet-ui/".length) : "";
    if (!FILES.includes(path) || entries.has(path) || !Number.isSafeInteger(entry.size) ||
        entry.size < 0 || entry.size > 8 * 1024 * 1024 || typeof entry.content !== "string") {
      throw new Error("production extension contains an extra or invalid file");
    }
    const body = Buffer.from(entry.content, "base64");
    const digest = createHash("sha3-256").update("NIR/ARTIFACT_FILE/v1\0").update(body).digest("hex");
    if (body.length !== entry.size || body.toString("base64") !== entry.content ||
        digest !== entry.sha3_256) throw new Error("production extension file bytes are invalid");
    entries.set(path, body);
  }
  if (entries.size !== FILES.length || FILES.some((path) => !entries.has(path))) {
    throw new Error("production extension file allowlist is incomplete");
  }
  const files = new Set(entries.keys());
  validateManifest(entries.get("manifest.json").toString("utf8"), files);
  validateHtml(entries.get("index.html").toString("utf8"), files);
  for (const [path, body] of entries) {
    if (path.endsWith(".js")) validateCode(path, body.toString("utf8"), files);
  }
  for (const match of entries.get("style.css").toString("utf8")
    .matchAll(/\burl\(\s*["']?([^"')]+)["']?\s*\)/gi)) localReference(match[1], files);
  const webManifest = parseConsensusJson(entries.get("manifest.webmanifest").toString("utf8"));
  exact(webManifest, ["background_color", "description", "display", "icons", "name",
    "short_name", "start_url", "theme_color"], "wallet web manifest");
  if (webManifest.display !== "standalone" || webManifest.start_url !== "./" ||
      !Array.isArray(webManifest.icons) || webManifest.icons.length !== 1) {
    throw new Error("wallet web manifest is invalid");
  }
  for (const icon of webManifest.icons) {
    exact(icon, ["purpose", "sizes", "src", "type"], "wallet web manifest icon");
    localReference(icon.src, files);
  }
  const nodes = parseConsensusJson(entries.get("nodes.json").toString("utf8"));
  exact(nodes, ["minimumAgreement", "nodes"], "wallet node policy");
  if (!Number.isSafeInteger(nodes.minimumAgreement) || nodes.minimumAgreement < 1 ||
      !Array.isArray(nodes.nodes) || nodes.nodes.length < nodes.minimumAgreement ||
      nodes.nodes.length > 16 || new Set(nodes.nodes).size !== nodes.nodes.length ||
      nodes.nodes.some((url) => !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(url))) {
    throw new Error("wallet node policy exceeds the extension loopback boundary");
  }
  return { artifactHash: artifact.artifactHash, files: FILES.length, manifestVersion: 3,
    sourceManifestHash: artifact.sourceManifestHash, verified: true };
}

export function productionPackageFromWalletStartup(wallet) {
  validateProductionWalletExtensionArtifact(wallet?.artifact);
  if (!wallet?.productionReport || !wallet?.productionTarget ||
      !/^[0-9a-f]{64}$/.test(wallet?.packageHash ?? "")) {
    throw new Error("production wallet startup evidence is incomplete");
  }
  return { artifact: wallet.artifact, format: "nir-production-release-package-v1",
    packageHash: wallet.packageHash, productionReport: wallet.productionReport,
    productionTarget: wallet.productionTarget, version: 1 };
}

export const PRODUCTION_EXTENSION_FILES = FILES;

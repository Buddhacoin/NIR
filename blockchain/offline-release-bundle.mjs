import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import {
  addressFromPublicKey, canonicalJson, hashObject, publicWallet, signObject, verifyObject,
} from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";

const BUNDLE_FORMAT = "nir-offline-release-bundle-v1";
const MANIFEST_FORMAT = "nir-offline-release-manifest-v1";
const APPROVAL_FORMAT = "nir-offline-release-approval-v1";
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 192 * 1024 * 1024;
const HASH = /^sha3-256:[0-9a-f]{64}$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,32})?$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\..*)?|DEVNET-KEYS\.json|[^/]+\.(?:key|pem|p12|pfx|jks|keystore)|[^/]*\.nirvault(?:\.json)?)(?:$|\/)/i;
const INSTALL_SCRIPTS = new Set(["preinstall", "install", "postinstall", "prepare", "prepack", "postpack"]);

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function canonicalPath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 ||
      value !== value.normalize("NFC") || value.startsWith("/") || value.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(value)) throw new Error("release path is invalid");
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..") ||
      parts.includes(".git") || parts.includes("node_modules") || SECRET_PATH.test(value)) {
    throw new Error("release path is unsafe or non-canonical");
  }
  return parts.join("/");
}

function canonicalBase64(value, maximum, label) {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > maximum || decoded.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

function digest(contents) {
  return `sha3-256:${createHash("sha3-256").update(contents).digest("hex")}`;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireSecureOpen() {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
    throw new Error("secure no-follow release reads are unavailable");
  }
}

function openDirectory(path, label) {
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`${label} is unsafe`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  if (!opened.isDirectory() || !sameIdentity(before, opened)) {
    closeSync(descriptor);
    throw new Error(`${label} changed during open`);
  }
  return { descriptor, metadata: opened, path };
}

function assertDirectory(directory, label) {
  const descriptor = fstatSync(directory.descriptor);
  const linked = lstatSync(directory.path);
  if (!linked.isDirectory() || linked.isSymbolicLink() ||
      !sameIdentity(descriptor, directory.metadata) || !sameIdentity(linked, directory.metadata) ||
      descriptor.mode !== directory.metadata.mode || descriptor.uid !== directory.metadata.uid ||
      descriptor.mtimeMs !== directory.metadata.mtimeMs || descriptor.ctimeMs !== directory.metadata.ctimeMs) {
    throw new Error(`${label} changed during release read`);
  }
}

function readSourceFile(root, relativePath, { _afterFileOpen } = {}) {
  requireSecureOpen();
  const absolute = resolve(root, ...relativePath.split("/"));
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error("release source escapes its root");
  }
  const directories = [];
  let descriptor;
  try {
    let current = root;
    directories.push(openDirectory(current, "release root"));
    for (const part of relativePath.split("/").slice(0, -1)) {
      current = join(current, part);
      directories.push(openDirectory(current, "release source directory"));
    }
    const beforeOpen = lstatSync(absolute);
    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) {
      throw new Error("release source is not a bounded unique regular file");
    }
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(beforeOpen, opened) || opened.nlink !== 1 ||
        opened.size < 0 || opened.size > MAX_FILE_BYTES) {
      throw new Error("release source is not a bounded unique regular file");
    }
    if (_afterFileOpen !== undefined) {
      if (typeof _afterFileOpen !== "function") throw new Error("release read hook is invalid");
      _afterFileOpen({ descriptor, path: absolute, relativePath });
    }
    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const length = readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (length === 0) throw new Error("release source changed during read");
      offset += length;
    }
    const after = fstatSync(descriptor);
    const linked = lstatSync(absolute);
    if (!sameIdentity(opened, after) || !sameIdentity(opened, linked) ||
        after.size !== opened.size || after.mode !== opened.mode ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error("release source changed during read");
    }
    for (let index = directories.length - 1; index >= 0; index -= 1) {
      assertDirectory(directories[index], "release source directory");
    }
    return { contents, mode: (opened.mode & 0o111) === 0 ? 0o644 : 0o755 };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    for (const directory of directories.reverse()) closeSync(directory.descriptor);
  }
}

function secretContentCheck(path, contents) {
  const text = contents.toString("utf8");
  if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text)) {
    throw new Error(`release source contains private-key material: ${path}`);
  }
  if (path.endsWith(".json")) {
    try {
      const value = JSON.parse(text);
      if (value?.format === "nir-encrypted-vault" || value?.privateKey !== undefined ||
          value?.password !== undefined || value?.mnemonic !== undefined || value?.seed !== undefined) {
        throw new Error(`release source contains secret-bearing JSON: ${path}`);
      }
    } catch (error) {
      if (/secret-bearing JSON/.test(error.message)) throw error;
    }
  }
}

function validatePackagePolicy(entries) {
  const packageEntry = entries.find(({ path }) => path === "package.json");
  if (!packageEntry) return;
  let packageValue;
  try { packageValue = JSON.parse(Buffer.from(packageEntry.content, "base64").toString("utf8")); }
  catch { throw new Error("package.json in release bundle is invalid"); }
  const scripts = packageValue?.scripts ?? {};
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts) ||
      Object.keys(scripts).some((name) => INSTALL_SCRIPTS.has(name))) {
    throw new Error("release package enables an npm lifecycle script");
  }
  let dependencyCount = 0;
  const rootDependencies = {};
  const dependencyNames = new Set();
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = packageValue?.[section] ?? {};
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      throw new Error("release package dependency map is invalid");
    }
    for (const [name, version] of Object.entries(dependencies)) {
      dependencyCount += 1;
      if (dependencyNames.has(name)) {
        throw new Error("release dependency name appears in multiple package sections");
      }
      dependencyNames.add(name);
      if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error("release dependencies must use exact registry versions");
      }
    }
    Object.assign(rootDependencies, dependencies);
  }
  const lockEntry = entries.find(({ path }) => path === "package-lock.json");
  if (dependencyCount > 0 && !lockEntry) {
    throw new Error("release dependencies require a committed package lock");
  }
  if (!lockEntry) return;
  let lock;
  try { lock = JSON.parse(Buffer.from(lockEntry.content, "base64").toString("utf8")); }
  catch { throw new Error("package-lock.json in release bundle is invalid"); }
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object" ||
      Array.isArray(lock.packages) || !lock.packages[""]) {
    throw new Error("release package lock must use lockfileVersion 3");
  }
  const lockedRoot = {
    ...(lock.packages[""].dependencies ?? {}),
    ...(lock.packages[""].devDependencies ?? {}),
    ...(lock.packages[""].optionalDependencies ?? {}),
    ...(lock.packages[""].peerDependencies ?? {}),
  };
  if (canonicalJson(lockedRoot) !== canonicalJson(rootDependencies)) {
    throw new Error("release package lock root dependencies do not match package.json");
  }
  for (const name of dependencyNames) {
    if (!lock.packages[`node_modules/${name}`]) {
      throw new Error("release package lock is missing a root dependency entry");
    }
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "") continue;
    if (!path.startsWith("node_modules/") || !entry || typeof entry !== "object" ||
        entry.link === true || entry.hasInstallScript === true ||
        typeof entry.version !== "string" ||
        !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version) ||
        !validRegistryUrl(entry.resolved) || !validSha512Integrity(entry.integrity)) {
      throw new Error("release package lock contains an unpinned or scripted package");
    }
  }
}

function validSha512Integrity(value) {
  if (typeof value !== "string" || !value.startsWith("sha512-")) return false;
  const encoded = value.slice(7);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return false;
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 64 && decoded.toString("base64") === encoded;
}

function validRegistryUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === "https://registry.npmjs.org" &&
      url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  } catch { return false; }
}

function manifestPayload(value) {
  exact(value, ["files", "format", "networkId", "previousBundleHash", "protocolVersion",
    "releaseVersion", "sourceRevision", "totalBytes"], "release manifest");
  if (value.format !== MANIFEST_FORMAT || !VERSION.test(value.releaseVersion ?? "") ||
      !NETWORK.test(value.networkId ?? "") || !REVISION.test(value.sourceRevision ?? "") ||
      !Number.isSafeInteger(value.protocolVersion) || value.protocolVersion < 1 ||
      value.protocolVersion > 0x7fffffff ||
      !(value.previousBundleHash === null || HASH.test(value.previousBundleHash ?? "")) ||
      !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || value.totalBytes > MAX_TOTAL_BYTES ||
      !Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_FILES) {
    throw new Error("release manifest metadata is invalid");
  }
  let total = 0;
  const seen = new Set();
  const folded = new Set();
  const files = value.files.map((entry) => {
    exact(entry, ["mode", "path", "sha3_256", "size"], "release file entry");
    const path = canonicalPath(entry.path);
    const collision = path.toLocaleLowerCase("en-US");
    if (seen.has(path) || folded.has(collision) || ![0o644, 0o755].includes(entry.mode) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES ||
        !HASH.test(entry.sha3_256 ?? "")) throw new Error("release file entry is invalid or ambiguous");
    seen.add(path); folded.add(collision); total += entry.size;
    if (total > MAX_TOTAL_BYTES) throw new Error("release manifest is too large");
    return { mode: entry.mode, path, sha3_256: entry.sha3_256, size: entry.size };
  });
  if (files.some((entry, index) => entry.path !== value.files[index].path) || total !== value.totalBytes) {
    throw new Error("release manifest ordering or total is invalid");
  }
  return { ...value, files };
}

export function validateOfflineReleaseBundle(value) {
  exact(value, ["bundleHash", "entries", "format", "manifest", "manifestHash", "version"],
    "release bundle");
  if (value.format !== BUNDLE_FORMAT || value.version !== 1 || !HASH.test(value.manifestHash ?? "") ||
      !HASH.test(value.bundleHash ?? "") || !Array.isArray(value.entries)) {
    throw new Error("release bundle header is invalid");
  }
  const manifest = manifestPayload(value.manifest);
  const expectedManifestHash = `sha3-256:${hashObject(manifest, "OFFLINE_RELEASE_MANIFEST_V1")}`;
  if (value.manifestHash !== expectedManifestHash || value.entries.length !== manifest.files.length) {
    throw new Error("release manifest hash or entry count is invalid");
  }
  const entries = value.entries.map((entry, index) => {
    exact(entry, ["content", "path"], "release bundle entry");
    const path = canonicalPath(entry.path);
    if (path !== manifest.files[index].path) throw new Error("release entry ordering is invalid");
    const contents = canonicalBase64(entry.content, MAX_FILE_BYTES, "release content");
    const file = manifest.files[index];
    if (contents.length !== file.size || digest(contents) !== file.sha3_256) {
      throw new Error("release entry does not match its manifest");
    }
    secretContentCheck(path, contents);
    return { content: entry.content, path };
  });
  validatePackagePolicy(entries);
  const payload = { entries, format: BUNDLE_FORMAT, manifest, manifestHash: value.manifestHash, version: 1 };
  const expectedBundleHash = `sha3-256:${hashObject(payload, "OFFLINE_RELEASE_BUNDLE_V1")}`;
  if (value.bundleHash !== expectedBundleHash) throw new Error("release bundle hash is invalid");
  return { ...payload, bundleHash: value.bundleHash };
}

export function createOfflineReleaseBundle(rootPath, paths, metadata = {}) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_FILES) {
    throw new Error("release path allowlist is invalid");
  }
  const root = resolve(rootPath);
  const normalized = paths.map(canonicalPath).sort();
  if (new Set(normalized).size !== normalized.length ||
      new Set(normalized.map((path) => path.toLocaleLowerCase("en-US"))).size !== normalized.length) {
    throw new Error("release path allowlist contains duplicate or ambiguous paths");
  }
  const sources = [];
  for (const path of normalized) {
    const { contents, mode } = readSourceFile(root, path, metadata);
    sources.push({ contents, mode, path });
  }
  return createOfflineReleaseBundleFromEntries(sources, metadata);
}

export function createOfflineReleaseBundleFromEntries(sourceEntries, metadata = {}) {
  if (!Array.isArray(sourceEntries) || sourceEntries.length < 1 || sourceEntries.length > MAX_FILES) {
    throw new Error("release entry allowlist is invalid");
  }
  const normalized = sourceEntries.map((entry) => ({
    contents: Buffer.isBuffer(entry?.contents) ? Buffer.from(entry.contents) :
      Buffer.from(entry?.contents ?? ""),
    mode: entry?.mode ?? 0o644,
    path: canonicalPath(entry?.path),
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(normalized.map(({ path }) => path)).size !== normalized.length ||
      new Set(normalized.map(({ path }) => path.toLocaleLowerCase("en-US"))).size !== normalized.length) {
    throw new Error("release entry allowlist contains duplicate or ambiguous paths");
  }
  let totalBytes = 0;
  const entries = [];
  const files = [];
  for (const { contents, mode, path } of normalized) {
    if (!Buffer.isBuffer(contents) || contents.length > MAX_FILE_BYTES || ![0o644, 0o755].includes(mode)) {
      throw new Error("release entry is not a bounded regular-file image");
    }
    secretContentCheck(path, contents);
    totalBytes += contents.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("release sources are too large");
    entries.push({ content: contents.toString("base64"), path });
    files.push({ mode, path, sha3_256: digest(contents), size: contents.length });
  }
  validatePackagePolicy(entries);
  const manifest = manifestPayload({
    files, format: MANIFEST_FORMAT, networkId: metadata.networkId,
    previousBundleHash: metadata.previousBundleHash ?? null,
    protocolVersion: metadata.protocolVersion, releaseVersion: metadata.releaseVersion,
    sourceRevision: metadata.sourceRevision, totalBytes,
  });
  const manifestHash = `sha3-256:${hashObject(manifest, "OFFLINE_RELEASE_MANIFEST_V1")}`;
  const payload = { entries, format: BUNDLE_FORMAT, manifest, manifestHash, version: 1 };
  const bundle = {
    ...payload, bundleHash: `sha3-256:${hashObject(payload, "OFFLINE_RELEASE_BUNDLE_V1")}`,
  };
  return validateOfflineReleaseBundle(bundle);
}

export function verifyOfflineReleaseGitTree(rootPath, bundleValue, sourceRevision) {
  const bundle = validateOfflineReleaseBundle(bundleValue);
  const root = resolve(rootPath);
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8", maxBuffer: 1024 * 1024,
  }).trim();
  if (head !== sourceRevision || bundle.manifest.sourceRevision !== sourceRevision) {
    throw new Error("release source revision does not match Git HEAD");
  }
  for (let index = 0; index < bundle.entries.length; index += 1) {
    const entry = bundle.entries[index];
    const expected = execFileSync("git", ["-C", root, "show", `${sourceRevision}:${entry.path}`], {
      encoding: null, maxBuffer: 40 * 1024 * 1024,
    });
    if (expected.toString("base64") !== entry.content) {
      throw new Error(`bundled source does not match Git revision: ${entry.path}`);
    }
    const tree = execFileSync("git", ["-C", root, "ls-tree", sourceRevision, "--", entry.path], {
      encoding: "utf8", maxBuffer: 1024 * 1024,
    });
    const matched = /^(100644|100755) blob [0-9a-f]+\t/.exec(tree);
    const expectedMode = matched?.[1] === "100755" ? 0o755 : matched?.[1] === "100644" ? 0o644 : null;
    if (expectedMode !== bundle.manifest.files[index].mode) {
      throw new Error(`bundled mode does not match Git revision: ${entry.path}`);
    }
  }
  const finalHead = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8", maxBuffer: 1024 * 1024,
  }).trim();
  const status = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  if (finalHead !== sourceRevision || status !== "") {
    throw new Error("release source changed while bundle provenance was verified");
  }
  return { bundleHash: bundle.bundleHash, files: bundle.entries.length, sourceRevision };
}

export function serializeOfflineReleaseBundle(bundle) {
  return `${canonicalJson(validateOfflineReleaseBundle(bundle))}\n`;
}

export function parseOfflineReleaseBundle(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BUNDLE_BYTES || text.includes("\u0000")) {
    throw new Error("release bundle text is invalid or too large");
  }
  const canonical = text.endsWith("\n") && !text.endsWith("\n\n") ? text.slice(0, -1) : text;
  let value;
  try { value = JSON.parse(canonical); } catch { throw new Error("release bundle is not JSON"); }
  if (canonicalJson(value) !== canonical) throw new Error("release bundle JSON is not canonical");
  return validateOfflineReleaseBundle(value);
}

function approvalPayload(bundle) {
  return { bundleHash: bundle.bundleHash, manifestHash: bundle.manifestHash };
}

export function signOfflineReleaseBundle(bundleValue, wallet) {
  const bundle = validateOfflineReleaseBundle(bundleValue);
  const approval = {
    bundleHash: bundle.bundleHash, format: APPROVAL_FORMAT, manifestHash: bundle.manifestHash,
    signature: signObject(approvalPayload(bundle), wallet, "OFFLINE_RELEASE_APPROVAL_V1"),
    signer: publicWallet(wallet), version: 1,
  };
  return validateOfflineReleaseApproval(bundle, approval, { trustedAddress: wallet.address }).approval;
}

export function validateOfflineReleaseApproval(bundleValue, approval, {
  trustedAddress, releaseVersion, networkId, protocolVersion, previousBundleHash,
} = {}) {
  const bundle = validateOfflineReleaseBundle(bundleValue);
  exact(approval, ["bundleHash", "format", "manifestHash", "signature", "signer", "version"],
    "release approval");
  exact(approval.signer, ["address", "algorithm", "publicKey"], "release signer");
  canonicalBase64(approval.signature, 16 * 1024, "release signature");
  canonicalBase64(approval.signer.publicKey, 8 * 1024, "release public key");
  if (approval.format !== APPROVAL_FORMAT || approval.version !== 1 ||
      approval.bundleHash !== bundle.bundleHash || approval.manifestHash !== bundle.manifestHash ||
      approval.signer.algorithm !== SIGNATURE_ALGORITHM || approval.signer.address !== trustedAddress ||
      addressFromPublicKey(approval.signer.publicKey) !== approval.signer.address ||
      !verifyObject(approvalPayload(bundle), approval.signature, approval.signer.publicKey,
        "OFFLINE_RELEASE_APPROVAL_V1")) throw new Error("release approval is invalid or untrusted");
  const manifest = bundle.manifest;
  if ((releaseVersion !== undefined && manifest.releaseVersion !== releaseVersion) ||
      (networkId !== undefined && manifest.networkId !== networkId) ||
      (protocolVersion !== undefined && manifest.protocolVersion !== protocolVersion) ||
      (previousBundleHash !== undefined && manifest.previousBundleHash !== previousBundleHash)) {
    throw new Error("release approval does not match the expected update context");
  }
  return { approval: structuredClone(approval), bundle };
}

export function serializeOfflineReleaseApproval(bundle, approval) {
  return `${canonicalJson(validateOfflineReleaseApproval(bundle, approval, {
    trustedAddress: approval?.signer?.address,
  }).approval)}\n`;
}

export function parseOfflineReleaseApproval(text, bundle, options) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 32 * 1024 || text.includes("\u0000")) {
    throw new Error("release approval text is invalid or too large");
  }
  const canonical = text.endsWith("\n") && !text.endsWith("\n\n") ? text.slice(0, -1) : text;
  let value;
  try { value = JSON.parse(canonical); } catch { throw new Error("release approval is not JSON"); }
  if (canonicalJson(value) !== canonical) throw new Error("release approval JSON is not canonical");
  return validateOfflineReleaseApproval(bundle, value, options);
}

export const OFFLINE_RELEASE_LIMITS = Object.freeze({
  maxBundleBytes: MAX_BUNDLE_BYTES, maxFileBytes: MAX_FILE_BYTES,
  maxFiles: MAX_FILES, maxTotalBytes: MAX_TOTAL_BYTES,
});

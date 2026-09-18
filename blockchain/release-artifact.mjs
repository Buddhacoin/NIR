import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { canonicalJson, hashObject } from "./crypto.mjs";
import {
  verifyReleaseFiles,
  verifyReleaseManifest,
  verifySignedRelease,
} from "./release-manifest.mjs";

const KINDS = new Set(["node", "wallet"]);
const MAX_ENTRIES = 20_000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function entryExists(path) {
  try { lstatSync(path); return true; }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function openDirectory(path, label) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
    throw new Error(`${label} requires no-follow directory support`);
  }
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`${label} is not a regular directory`);
  }
  const descriptor = openSync(
    path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const opened = fstatSync(descriptor);
  if (!opened.isDirectory() || !sameIdentity(before, opened)) {
    closeSync(descriptor);
    throw new Error(`${label} changed during open`);
  }
  return { descriptor, metadata: opened };
}

function assertDirectoryIdentity(path, opened, label, requireStableMetadata = false) {
  const current = lstatSync(path);
  const descriptorMetadata = fstatSync(opened.descriptor);
  if (!current.isDirectory() || current.isSymbolicLink() ||
      !sameIdentity(current, opened.metadata) || !sameIdentity(descriptorMetadata, opened.metadata) ||
      (requireStableMetadata &&
       (descriptorMetadata.mtimeMs !== opened.metadata.mtimeMs ||
        descriptorMetadata.ctimeMs !== opened.metadata.ctimeMs ||
        descriptorMetadata.mode !== opened.metadata.mode))) {
    throw new Error(`${label} changed during operation`);
  }
}

function readRegularFile(path, { label, maximum = MAX_ENTRY_BYTES } = {}) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    throw new Error(`${label} requires no-follow file support`);
  }
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size < 0 || opened.size > maximum) {
      throw new Error(`${label} is not a bounded regular file`);
    }
    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const length = readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (length === 0) throw new Error(`${label} changed during read`);
      offset += length;
    }
    const after = fstatSync(descriptor);
    if (!sameIdentity(after, opened) || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        after.mode !== opened.mode) {
      throw new Error(`${label} changed during read`);
    }
    const linked = lstatSync(path);
    if (!linked.isFile() || linked.isSymbolicLink() || !sameIdentity(linked, opened)) {
      throw new Error(`${label} changed during read`);
    }
    return { contents, metadata: opened };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeRegularFile(path, contents, mode, label) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    throw new Error(`${label} requires no-follow file support`);
  }
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    writeFileSync(descriptor, contents);
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    const written = fstatSync(descriptor);
    if (!written.isFile() || written.size !== contents.length || (written.mode & 0o777) !== mode) {
      throw new Error(`${label} write verification failed`);
    }
    const check = Buffer.alloc(contents.length);
    let offset = 0;
    while (offset < check.length) {
      const length = readSync(descriptor, check, offset, check.length - offset, offset);
      if (length === 0) throw new Error(`${label} changed during verification`);
      offset += length;
    }
    const after = fstatSync(descriptor);
    const linked = lstatSync(path);
    if (!sameIdentity(written, after) || !sameIdentity(written, linked) ||
        after.size !== written.size || after.mtimeMs !== written.mtimeMs ||
        after.ctimeMs !== written.ctimeMs || !check.equals(contents)) {
      throw new Error(`${label} changed during verification`);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncDirectory(path, label) {
  const opened = openDirectory(path, label);
  try {
    fsyncSync(opened.descriptor);
    assertDirectoryIdentity(path, opened, label);
  } finally { closeSync(opened.descriptor); }
}

function canonicalPath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 ||
      value.startsWith("/") || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value) ||
      value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("release artifact path is invalid");
  }
  return value;
}

function digest(contents) {
  return createHash("sha3-256").update("NIR/ARTIFACT_FILE/v1\0").update(contents).digest("hex");
}

function payloadFrom(artifact) {
  if (artifact?.format !== "nir-reproducible-package-v1" || !KINDS.has(artifact.kind) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(artifact.sourceRevision ?? "") ||
      !/^[0-9a-f]{64}$/.test(artifact.sourceManifestHash ?? "") ||
      typeof artifact.releaseVersion !== "string" ||
      !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(artifact.releaseVersion) ||
      !Array.isArray(artifact.entries) || artifact.entries.length < 1 ||
      artifact.entries.length > MAX_ENTRIES) {
    throw new Error("release artifact header is invalid");
  }
  let total = 0;
  const seen = new Set();
  const entries = artifact.entries.map((entry) => {
    const path = canonicalPath(entry?.path);
    if (seen.has(path) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        entry.size > MAX_ENTRY_BYTES || typeof entry.executable !== "boolean" ||
        !/^[0-9a-f]{64}$/.test(entry.sha3_256 ?? "") ||
        typeof entry.content !== "string" || entry.content.length > MAX_ENTRY_BYTES * 2 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.content)) {
      throw new Error("release artifact entry is invalid");
    }
    const contents = Buffer.from(entry.content, "base64");
    if (contents.toString("base64") !== entry.content || contents.length !== entry.size ||
        digest(contents) !== entry.sha3_256) {
      throw new Error("release artifact entry digest is invalid");
    }
    total += contents.length;
    if (total > MAX_ARTIFACT_BYTES) throw new Error("release artifact is too large");
    seen.add(path);
    return { content: entry.content, executable: entry.executable, path,
      sha3_256: entry.sha3_256, size: entry.size };
  });
  const sorted = [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (sorted.some((entry, index) => entry.path !== entries[index].path)) {
    throw new Error("release artifact entries are not canonically ordered");
  }
  return {
    entries,
    format: "nir-reproducible-package-v1",
    kind: artifact.kind,
    releaseVersion: artifact.releaseVersion,
    sourceManifestHash: artifact.sourceManifestHash,
    sourceRevision: artifact.sourceRevision,
  };
}

export function artifactPaths(kind, trackedPaths) {
  if (!KINDS.has(kind) || !Array.isArray(trackedPaths)) {
    throw new Error("release artifact recipe is invalid");
  }
  const selected = trackedPaths.filter((path) => kind === "wallet"
    ? path.startsWith("wallet-ui/")
    : path === "package.json" || path.startsWith("blockchain/"));
  if (selected.length === 0) throw new Error("release artifact recipe has no files");
  return selected.sort();
}

export function createReleaseArtifact(root, paths, { kind, sourceManifest } = {}) {
  const manifest = verifyReleaseManifest(sourceManifest);
  verifyReleaseFiles(root, manifest);
  const allowed = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const selected = [...new Set(paths.map(canonicalPath))].sort();
  const expected = artifactPaths(kind, manifest.files.map(({ path }) => path));
  if (selected.length !== paths.length || selected.some((path) => !allowed.has(path))) {
    throw new Error("artifact recipe is not a subset of the signed sources");
  }
  if (selected.length !== expected.length || selected.some((path, index) => path !== expected[index])) {
    throw new Error("artifact recipe is incomplete");
  }
  const base = resolve(root);
  const entries = selected.map((path) => {
    const absolute = resolve(base, ...path.split("/"));
    if (absolute !== base && !absolute.startsWith(`${base}${sep}`)) {
      throw new Error("artifact source escapes the root");
    }
    const metadata = lstatSync(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("artifact source is not a regular file");
    }
    const contents = readFileSync(absolute);
    return {
      content: contents.toString("base64"),
      executable: (metadata.mode & 0o111) !== 0,
      path,
      sha3_256: digest(contents),
      size: contents.length,
    };
  });
  const payload = payloadFrom({
    entries, format: "nir-reproducible-package-v1", kind,
    releaseVersion: manifest.releaseVersion,
    sourceManifestHash: manifest.manifestHash,
    sourceRevision: manifest.sourceRevision,
  });
  return { ...payload, artifactHash: hashObject(payload, "RELEASE_ARTIFACT_HASH") };
}

export function verifyReleaseArtifact(artifact, { sourceManifest } = {}) {
  const payload = payloadFrom(artifact);
  if (artifact.artifactHash !== hashObject(payload, "RELEASE_ARTIFACT_HASH")) {
    throw new Error("release artifact hash is invalid");
  }
  if (sourceManifest) {
    const manifest = verifyReleaseManifest(sourceManifest);
    if (payload.sourceManifestHash !== manifest.manifestHash ||
        payload.sourceRevision !== manifest.sourceRevision ||
        payload.releaseVersion !== manifest.releaseVersion) {
      throw new Error("release artifact is not bound to the trusted source manifest");
    }
    const sources = new Map(manifest.files.map((entry) => [entry.path, entry]));
    const expectedPaths = artifactPaths(payload.kind, manifest.files.map(({ path }) => path));
    if (expectedPaths.length !== payload.entries.length || expectedPaths.some(
      (path, index) => path !== payload.entries[index]?.path,
    )) {
      throw new Error("release artifact does not contain its complete deterministic recipe");
    }
    for (const entry of payload.entries) {
      const source = sources.get(entry.path);
      const sourceDigest = createHash("sha3-256")
        .update("NIR/RELEASE_FILE/v1\0").update(Buffer.from(entry.content, "base64")).digest("hex");
      if (!source || source.size !== entry.size || source.executable !== entry.executable ||
          source.sha3_256 !== sourceDigest) {
        throw new Error("release artifact contents differ from the trusted sources");
      }
    }
  }
  return { ...payload, artifactHash: artifact.artifactHash };
}

export function serializeReleaseArtifact(artifact) {
  return `${canonicalJson(verifyReleaseArtifact(artifact))}\n`;
}

function installationSpec(kind) {
  if (kind === "wallet") {
    return {
      format: "nir-wallet-install-v1",
      relativePath(path) {
        if (!path.startsWith("wallet-ui/")) {
          throw new Error("wallet package contains a non-wallet path");
        }
        const relative = path.slice("wallet-ui/".length);
        if (!relative) throw new Error("wallet package path is invalid");
        return relative;
      },
    };
  }
  if (kind === "node") {
    return {
      format: "nir-node-install-v1",
      relativePath(path) {
        if (path !== "package.json" && !path.startsWith("blockchain/")) {
          throw new Error("node package contains a non-node path");
        }
        return path;
      },
    };
  }
  throw new Error("installation kind is invalid");
}

function installArtifact(artifact, targetPath, { kind, signedRelease, trustedAddress } = {}) {
  const { manifest, signer } = verifySignedRelease(signedRelease, { trustedAddress });
  const verified = verifyReleaseArtifact(artifact, { sourceManifest: manifest });
  if (verified.kind !== kind) throw new Error(`${kind} installation metadata is invalid`);
  const spec = installationSpec(kind);
  const entries = verified.entries.map((entry) => ({
    entry,
    relative: spec.relativePath(entry.path),
  }));
  const target = resolve(targetPath);
  const parent = dirname(target);
  const parentOpened = openDirectory(parent, `${kind} installation parent`);
  if (entryExists(target)) {
    closeSync(parentOpened.descriptor);
    throw new Error(`${kind} installation requires a new directory in a regular parent`);
  }
  let staging = null;
  let stagingIdentity = null;
  try {
    for (let attempt = 0; attempt < 16 && staging === null; attempt += 1) {
      const candidate = join(parent,
        `.${basename(target)}.nir-staging-${randomBytes(16).toString("hex")}`);
      try {
        mkdirSync(candidate, { mode: 0o700 });
        staging = candidate;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    if (staging === null) throw new Error(`${kind} installation cannot allocate staging`);
    stagingIdentity = lstatSync(staging);
    if (!stagingIdentity.isDirectory() || stagingIdentity.isSymbolicLink() ||
        (stagingIdentity.mode & 0o777) !== 0o700) {
      throw new Error(`${kind} installation staging directory is unsafe`);
    }
    const directories = new Set([staging]);
    for (const { entry, relative } of entries) {
      const parts = relative.split("/");
      let directory = staging;
      for (const part of parts.slice(0, -1)) {
        directory = join(directory, part);
        if (!entryExists(directory)) mkdirSync(directory, { mode: 0o755 });
        const directoryMetadata = lstatSync(directory);
        if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
            (directoryMetadata.mode & 0o777) !== 0o755) {
          throw new Error(`${kind} installation directory is unsafe`);
        }
        directories.add(directory);
      }
      const destination = join(directory, parts.at(-1));
      const contents = Buffer.from(entry.content, "base64");
      writeRegularFile(
        destination, contents, entry.executable ? 0o755 : 0o644,
        `${kind} installation file`,
      );
    }
    const provenance = {
      artifactHash: verified.artifactHash,
      format: spec.format,
      releaseVersion: verified.releaseVersion,
      signerAddress: signer.address,
      sourceManifestHash: verified.sourceManifestHash,
      sourceRevision: verified.sourceRevision,
    };
    writeRegularFile(
      join(staging, "NIR-INSTALL.json"), Buffer.from(`${canonicalJson(provenance)}\n`),
      0o644, `${kind} installation provenance`,
    );
    for (const directory of [...directories]
      .sort((left, right) => right.split(sep).length - left.split(sep).length)) {
      syncDirectory(directory, `${kind} installation directory`);
    }
    verifyInstallation(staging, { kind, signedRelease, trustedAddress });
    assertDirectoryIdentity(parent, parentOpened, `${kind} installation parent`);
    const stagingOpened = openDirectory(staging, `${kind} installation staging directory`);
    try {
      if (!sameIdentity(stagingOpened.metadata, stagingIdentity) || entryExists(target)) {
        throw new Error(`${kind} installation target changed before activation`);
      }
      renameSync(staging, target);
      staging = null;
      fsyncSync(parentOpened.descriptor);
      const installed = lstatSync(target);
      if (!installed.isDirectory() || installed.isSymbolicLink() ||
          !sameIdentity(installed, stagingIdentity)) {
        throw new Error(`${kind} installation activation is inconsistent`);
      }
    } finally { closeSync(stagingOpened.descriptor); }
    return provenance;
  } catch (error) {
    if (staging !== null && stagingIdentity !== null) {
      try {
        const current = lstatSync(staging);
        if (current.isDirectory() && !current.isSymbolicLink() &&
            sameIdentity(current, stagingIdentity)) {
          rmSync(staging, { recursive: true, force: true });
          fsyncSync(parentOpened.descriptor);
        }
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError.message;
      }
    }
    throw error;
  } finally { closeSync(parentOpened.descriptor); }
}

export function installWalletArtifact(artifact, targetPath, options = {}) {
  return installArtifact(artifact, targetPath, { ...options, kind: "wallet" });
}

export function installNodeArtifact(artifact, targetPath, options = {}) {
  return installArtifact(artifact, targetPath, { ...options, kind: "node" });
}

function installedFiles(directory, kind, prefix = "", result = []) {
  if (prefix.split("/").filter(Boolean).length > 32) {
    throw new Error(`${kind} installation directory depth is excessive`);
  }
  const opened = openDirectory(directory, `${kind} installation directory`);
  try {
    const expectedMode = prefix === "" ? 0o700 : 0o755;
    if ((opened.metadata.mode & 0o777) !== expectedMode) {
      throw new Error(`${kind} installation directory mode is invalid`);
    }
    const names = readdirSync(directory).sort();
    result.seen = (result.seen ?? 0) + names.length;
    if (names.length > MAX_ENTRIES || result.seen > MAX_ENTRIES) {
      throw new Error(`${kind} installation contains too many entries`);
    }
    for (const name of names) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`${kind} installation contains a symbolic link`);
      }
      if ((metadata.mode & 0o022) !== 0) {
        throw new Error(`${kind} installation contains a group- or world-writable entry`);
      }
      if (metadata.isDirectory()) installedFiles(path, kind, relative, result);
      else if (metadata.isFile()) result.push(relative);
      else throw new Error(`${kind} installation contains an unsupported entry`);
    }
    assertDirectoryIdentity(directory, opened, `${kind} installation directory`, true);
  } finally { closeSync(opened.descriptor); }
  return result;
}

function verifyInstallation(targetPath, { kind, signedRelease, trustedAddress } = {}) {
  const { manifest, signer } = verifySignedRelease(signedRelease, { trustedAddress });
  const spec = installationSpec(kind);
  const target = resolve(targetPath);
  const targetOpened = openDirectory(target, `${kind} installation`);
  if ((targetOpened.metadata.mode & 0o777) !== 0o700) {
    closeSync(targetOpened.descriptor);
    throw new Error(`${kind} installation directory mode is invalid`);
  }
  try {
    const sourceEntries = new Map(manifest.files.map((entry) => [entry.path, entry]));
    const sourcePaths = artifactPaths(kind, manifest.files.map(({ path }) => path));
    const expectedRelative = sourcePaths.map((path) => spec.relativePath(path));
    const actualRelative = installedFiles(target, kind);
    const expectedFiles = [...expectedRelative, "NIR-INSTALL.json"].sort();
    if (actualRelative.length !== expectedFiles.length ||
        actualRelative.some((path, index) => path !== expectedFiles[index])) {
      throw new Error(`${kind} installation file set does not match the signed release`);
    }
    const entries = sourcePaths.map((path, index) => {
      const relative = expectedRelative[index];
      if (!relative) throw new Error(`${kind} installation path is invalid`);
      const destination = join(target, ...relative.split("/"));
      const { contents, metadata } = readRegularFile(destination, {
        label: `${kind} installation file`, maximum: MAX_ENTRY_BYTES,
      });
      const source = sourceEntries.get(path);
      const sourceDigest = createHash("sha3-256")
        .update("NIR/RELEASE_FILE/v1\0").update(contents).digest("hex");
      const executable = (metadata.mode & 0o111) !== 0;
      const expectedMode = source?.executable ? 0o755 : 0o644;
      if (!source || contents.length !== source.size || executable !== source.executable ||
          (metadata.mode & 0o777) !== expectedMode ||
          sourceDigest !== source.sha3_256) {
        throw new Error(`${kind} installation contents differ from the signed release`);
      }
      return {
        content: contents.toString("base64"), executable, path,
        sha3_256: digest(contents), size: contents.length,
      };
    });
    const payload = payloadFrom({
      entries,
      format: "nir-reproducible-package-v1",
      kind,
      releaseVersion: manifest.releaseVersion,
      sourceManifestHash: manifest.manifestHash,
      sourceRevision: manifest.sourceRevision,
    });
    const artifactHash = hashObject(payload, "RELEASE_ARTIFACT_HASH");
    const provenancePath = join(target, "NIR-INSTALL.json");
    const { contents: provenanceContents, metadata: provenanceMetadata } = readRegularFile(
      provenancePath, { label: `${kind} installation provenance`, maximum: 16 * 1024 },
    );
    if ((provenanceMetadata.mode & 0o777) !== 0o644) {
      throw new Error(`${kind} installation provenance is invalid`);
    }
    const provenance = JSON.parse(provenanceContents.toString("utf8"));
    const expectedProvenance = {
      artifactHash,
      format: spec.format,
      releaseVersion: manifest.releaseVersion,
      signerAddress: signer.address,
      sourceManifestHash: manifest.manifestHash,
      sourceRevision: manifest.sourceRevision,
    };
    if (canonicalJson(provenance) !== canonicalJson(expectedProvenance)) {
      throw new Error(`${kind} installation provenance does not match its contents`);
    }
    assertDirectoryIdentity(target, targetOpened, `${kind} installation`, true);
    return { ...expectedProvenance, files: entries.length, verified: true };
  } finally { closeSync(targetOpened.descriptor); }
}

export function verifyWalletInstallation(targetPath, options = {}) {
  return verifyInstallation(targetPath, { ...options, kind: "wallet" });
}

export function verifyNodeInstallation(targetPath, options = {}) {
  return verifyInstallation(targetPath, { ...options, kind: "node" });
}

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

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
  const parentMetadata = lstatSync(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || existsSync(target)) {
    throw new Error(`${kind} installation requires a new directory in a regular parent`);
  }
  mkdirSync(target, { mode: 0o700 });
  try {
    for (const { entry, relative } of entries) {
      const destination = join(target, ...relative.split("/"));
      const directory = dirname(destination);
      mkdirSync(directory, { recursive: true, mode: 0o755 });
      const directoryMetadata = lstatSync(directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
        throw new Error(`${kind} installation directory is unsafe`);
      }
      writeFileSync(destination, Buffer.from(entry.content, "base64"), {
        flag: "wx", mode: entry.executable ? 0o755 : 0o644,
      });
      chmodSync(destination, entry.executable ? 0o755 : 0o644);
    }
    const provenance = {
      artifactHash: verified.artifactHash,
      format: spec.format,
      releaseVersion: verified.releaseVersion,
      signerAddress: signer.address,
      sourceManifestHash: verified.sourceManifestHash,
      sourceRevision: verified.sourceRevision,
    };
    writeFileSync(join(target, "NIR-INSTALL.json"), `${canonicalJson(provenance)}\n`, {
      flag: "wx", mode: 0o644,
    });
    return provenance;
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
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
  const names = readdirSync(directory).sort();
  result.seen = (result.seen ?? 0) + names.length;
  if (names.length > MAX_ENTRIES || result.seen > MAX_ENTRIES) {
    throw new Error(`${kind} installation contains too many entries`);
  }
  for (const name of names) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const path = join(directory, name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error(`${kind} installation contains a symbolic link`);
    if ((metadata.mode & 0o022) !== 0) {
      throw new Error(`${kind} installation contains a group- or world-writable entry`);
    }
    if (metadata.isDirectory()) installedFiles(path, kind, relative, result);
    else if (metadata.isFile()) result.push(relative);
    else throw new Error(`${kind} installation contains an unsupported entry`);
  }
  return result;
}

function verifyInstallation(targetPath, { kind, signedRelease, trustedAddress } = {}) {
  const { manifest, signer } = verifySignedRelease(signedRelease, { trustedAddress });
  const spec = installationSpec(kind);
  const target = resolve(targetPath);
  const targetMetadata = lstatSync(target);
  if (!targetMetadata.isDirectory() || targetMetadata.isSymbolicLink() ||
      (targetMetadata.mode & 0o022) !== 0) {
    throw new Error(`${kind} installation must be a regular directory`);
  }
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
    const metadata = lstatSync(destination);
    const contents = readFileSync(destination);
    const source = sourceEntries.get(path);
    const sourceDigest = createHash("sha3-256")
      .update("NIR/RELEASE_FILE/v1\0").update(contents).digest("hex");
    const executable = (metadata.mode & 0o111) !== 0;
    if (!metadata.isFile() || metadata.isSymbolicLink() || !source ||
        contents.length !== source.size || executable !== source.executable ||
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
  const provenanceMetadata = lstatSync(provenancePath);
  if (!provenanceMetadata.isFile() || provenanceMetadata.isSymbolicLink() ||
      provenanceMetadata.size > 16 * 1024) {
    throw new Error(`${kind} installation provenance is invalid`);
  }
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
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
  return { ...expectedProvenance, files: entries.length, verified: true };
}

export function verifyWalletInstallation(targetPath, options = {}) {
  return verifyInstallation(targetPath, { ...options, kind: "wallet" });
}

export function verifyNodeInstallation(targetPath, options = {}) {
  return verifyInstallation(targetPath, { ...options, kind: "node" });
}

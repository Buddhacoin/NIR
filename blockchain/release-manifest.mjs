import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve, sep } from "node:path";

import {
  addressFromPublicKey,
  hashObject,
  publicWallet,
  signObject,
  verifyObject,
} from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedPath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 ||
      value.startsWith("/") || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("release file path is invalid");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("release file path is not canonical");
  }
  return parts.join("/");
}

function fileDigest(contents) {
  return createHash("sha3-256")
    .update("NIR/RELEASE_FILE/v1\0")
    .update(contents)
    .digest("hex");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function readReleaseSourceFile(path, { maximumBytes = MAX_FILE_BYTES, _afterOpen } = {}) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) {
    throw new Error("release source reading requires no-follow nonblocking file support");
  }
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size < 0 || opened.size > maximumBytes) {
      throw new Error("release source is not a bounded regular file");
    }
    if (_afterOpen !== undefined) _afterOpen(path);
    const contents = Buffer.alloc(opened.size); let offset = 0;
    while (offset < contents.length) {
      const length = readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (length === 0) throw new Error("release source changed during read");
      offset += length;
    }
    const after = fstatSync(descriptor); const linked = lstatSync(path);
    if (!sameIdentity(opened, after) || !sameIdentity(opened, linked) || linked.isSymbolicLink() ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs || opened.mode !== after.mode) {
      throw new Error("release source changed during read");
    }
    return { contents, metadata: opened };
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function manifestPayload(manifest) {
  if (manifest?.format !== "nir-source-release-v1" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(manifest.sourceRevision ?? "") ||
      typeof manifest.releaseVersion !== "string" ||
      !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(manifest.releaseVersion) ||
      !Array.isArray(manifest.files) || manifest.files.length < 1 ||
      manifest.files.length > MAX_FILES) {
    throw new Error("release manifest header is invalid");
  }
  let totalBytes = 0;
  const seen = new Set();
  const files = manifest.files.map((entry) => {
    const path = normalizedPath(entry?.path);
    if (seen.has(path) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        entry.size > MAX_FILE_BYTES || typeof entry.executable !== "boolean" ||
        !/^[0-9a-f]{64}$/.test(entry.sha3_256 ?? "")) {
      throw new Error("release manifest file entry is invalid");
    }
    seen.add(path);
    totalBytes += entry.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("release manifest is too large");
    return { executable: entry.executable, path, sha3_256: entry.sha3_256, size: entry.size };
  }).sort((left, right) => comparePaths(left.path, right.path));
  if (files.some((entry, index) => entry.path !== manifest.files[index]?.path)) {
    throw new Error("release manifest files are not canonically ordered");
  }
  return {
    files,
    format: "nir-source-release-v1",
    releaseVersion: manifest.releaseVersion,
    sourceRevision: manifest.sourceRevision,
  };
}

export function createReleaseManifest(root, paths, { releaseVersion, sourceRevision } = {}) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_FILES) {
    throw new Error("release file list is invalid");
  }
  const base = resolve(root);
  const unique = [...new Set(paths.map(normalizedPath))].sort(comparePaths);
  if (unique.length !== paths.length) throw new Error("release file list contains duplicates");
  let totalBytes = 0;
  const files = unique.map((path) => {
    const absolute = resolve(base, ...path.split("/"));
    if (absolute !== base && !absolute.startsWith(`${base}${sep}`)) {
      throw new Error("release file escapes the source root");
    }
    let source;
    try { source = readReleaseSourceFile(absolute); }
    catch { throw new Error(`release source is not a stable bounded regular file: ${path}`); }
    const { contents, metadata } = source;
    totalBytes += metadata.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("release sources are too large");
    return {
      executable: (metadata.mode & 0o111) !== 0,
      path,
      sha3_256: fileDigest(contents),
      size: metadata.size,
    };
  });
  const payload = manifestPayload({
    files, format: "nir-source-release-v1", releaseVersion, sourceRevision,
  });
  return { ...payload, manifestHash: hashObject(payload, "RELEASE_MANIFEST_HASH") };
}

export function verifyReleaseManifest(manifest) {
  const { manifestHash, ...unsigned } = manifest ?? {};
  const payload = manifestPayload(unsigned);
  if (manifestHash !== hashObject(payload, "RELEASE_MANIFEST_HASH")) {
    throw new Error("release manifest hash is invalid");
  }
  return { ...payload, manifestHash };
}

export function signReleaseManifest(manifest, wallet) {
  const verified = verifyReleaseManifest(manifest);
  return {
    manifest: verified,
    signature: signObject(verified, wallet, "RELEASE_APPROVAL"),
    signer: publicWallet(wallet),
  };
}

export function verifySignedRelease(envelope, { trustedAddress } = {}) {
  const manifest = verifyReleaseManifest(envelope?.manifest);
  const signer = envelope?.signer;
  if (signer?.algorithm !== SIGNATURE_ALGORITHM ||
      addressFromPublicKey(signer?.publicKey ?? "") !== signer?.address ||
      signer.address !== trustedAddress ||
      !verifyObject(manifest, envelope?.signature, signer.publicKey, "RELEASE_APPROVAL")) {
    throw new Error("release signature is not trusted");
  }
  return { manifest, signer: structuredClone(signer) };
}

export function verifyReleaseFiles(root, manifest, expectedPaths = null) {
  const verified = verifyReleaseManifest(manifest);
  if (expectedPaths !== null) {
    const normalized = [...new Set(expectedPaths.map(normalizedPath))].sort(comparePaths);
    if (normalized.length !== expectedPaths.length ||
        normalized.some((path, index) => path !== verified.files[index]?.path) ||
        normalized.length !== verified.files.length) {
      throw new Error("release file set does not match the manifest");
    }
  }
  const rebuilt = createReleaseManifest(root, verified.files.map(({ path }) => path), {
    releaseVersion: verified.releaseVersion,
    sourceRevision: verified.sourceRevision,
  });
  if (rebuilt.manifestHash !== verified.manifestHash) {
    throw new Error("release files do not match the signed manifest");
  }
  return rebuilt;
}

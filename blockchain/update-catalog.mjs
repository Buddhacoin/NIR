// Platform-neutral verification of release metadata. This module deliberately
// does not fetch, install or establish a release signer trust anchor.
import { createHash } from "node:crypto";
import { addressFromPublicKey, verifyObject } from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";

const verifiedCatalogs = new WeakSet();
const githubVerifiedCatalogs = new WeakSet();
const HEX = /^[0-9a-f]{64}$/;
const VERSION = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TARGET = /^[a-z][a-z0-9-]{1,31}$/;
const RELEASE_TAG = /^nir-v((?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5}))$/;

function exact(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");
}

function validatedCatalog(catalog) {
  if (!exact(catalog, ["artifacts", "format", "releaseTag", "sourceRevision"]) ||
      catalog.format !== "nir-update-catalog-v1" ||
      !RELEASE_TAG.test(catalog.releaseTag ?? "") ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(catalog.sourceRevision ?? "") ||
      !Array.isArray(catalog.artifacts) || catalog.artifacts.length < 1 ||
      catalog.artifacts.length > 32) throw new Error("update catalog header is invalid");
  const seen = new Set();
  const filenames = new Set();
  let previous = "";
  const artifacts = catalog.artifacts.map((entry) => {
    if (!exact(entry, ["bytes", "filename", "product", "sequence", "sha256",
      "target", "version"]) ||
        !["wallet", "model-lab"].includes(entry.product) ||
        !TARGET.test(entry.target ?? "") || !NAME.test(entry.filename ?? "") ||
        !VERSION.test(entry.version ?? "") ||
        entry.version !== RELEASE_TAG.exec(catalog.releaseTag)[1] ||
        !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 ||
        entry.bytes > 512 * 1024 * 1024 || !HEX.test(entry.sha256 ?? "")) {
      throw new Error("update catalog artifact is invalid (including filename)");
    }
    const key = `${entry.product}/${entry.target}`;
    if (seen.has(key)) throw new Error("duplicate update target");
    if (filenames.has(entry.filename)) throw new Error("duplicate update filename");
    if (key < previous) throw new Error("update catalog targets are not ordered");
    previous = key;
    seen.add(key);
    filenames.add(entry.filename);
    return Object.freeze({ ...entry });
  });
  return Object.freeze({ artifacts: Object.freeze(artifacts), format: catalog.format,
    releaseTag: catalog.releaseTag, sourceRevision: catalog.sourceRevision });
}

export function verifyGithubUpdateRelease(release, envelope, { trustedAddress } = {}) {
  const catalog = verifySignedUpdateCatalog(envelope, {
    trustedAddress, releaseTag: release?.tag_name,
  });
  const tag = catalog.releaseTag;
  if (release?.draft !== false || release.prerelease !== false ||
      release.html_url !== `https://github.com/Buddhacoin/NIR/releases/tag/${tag}` ||
      !Array.isArray(release.assets) || release.assets.length > 64) {
    throw new Error("GitHub update release identity is invalid");
  }
  const assets = new Map();
  for (const asset of release.assets) {
    if (typeof asset?.name !== "string" || assets.has(asset.name)) {
      throw new Error("GitHub update release assets contain duplicates");
    }
    assets.set(asset.name, asset);
  }
  for (const artifact of catalog.artifacts) {
    const asset = assets.get(artifact.filename);
    if (!asset || asset.state !== "uploaded" || asset.size !== artifact.bytes ||
        asset.digest !== `sha256:${artifact.sha256}` ||
        asset.browser_download_url !==
          `https://github.com/Buddhacoin/NIR/releases/download/${tag}/${artifact.filename}`) {
      throw new Error("GitHub update release asset differs from signed catalog");
    }
  }
  githubVerifiedCatalogs.add(catalog);
  return catalog;
}

export function verifyDownloadedUpdateBytes(catalog, installedIdentity, bytes) {
  if (!githubVerifiedCatalogs.has(catalog)) {
    throw new Error("GitHub release and signed catalog were not jointly verified");
  }
  const artifact = selectVerifiedUpdate(catalog, installedIdentity);
  if (!artifact) throw new Error("update artifact was not selected for this installation");
  if (!Buffer.isBuffer(bytes) || bytes.length !== artifact.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw new Error("downloaded update bytes differ from the signed catalog");
  }
  return artifact;
}

export function verifySignedUpdateCatalog(envelope, { trustedAddress, releaseTag } = {}) {
  if (!exact(envelope, ["catalog", "signature", "signer"]) ||
      !exact(envelope.signer, ["address", "algorithm", "publicKey"]) ||
      typeof trustedAddress !== "string" || !/^nir1[0-9a-f]{64}$/.test(trustedAddress) ||
      envelope.signer.algorithm !== SIGNATURE_ALGORITHM ||
      envelope.signer.address !== trustedAddress ||
      addressFromPublicKey(envelope.signer.publicKey) !== trustedAddress) {
    throw new Error("update signer is not trusted");
  }
  const catalog = validatedCatalog(envelope.catalog);
  if (catalog.releaseTag !== releaseTag) throw new Error("update release tag differs");
  if (!verifyObject(catalog, envelope.signature, envelope.signer.publicKey,
    "NIR_UPDATE_CATALOG")) throw new Error("update catalog signature is invalid");
  verifiedCatalogs.add(catalog);
  return catalog;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function selectVerifiedUpdate(catalog, { product, target, installedSequence,
  installedVersion } = {}) {
  if (!verifiedCatalogs.has(catalog)) throw new Error("update catalog was not verified");
  if (!Number.isSafeInteger(installedSequence) || installedSequence < 0 ||
      !VERSION.test(installedVersion ?? "") ||
      !["wallet", "model-lab"].includes(product) || !TARGET.test(target ?? "")) {
    throw new Error("installed update identity is invalid");
  }
  return catalog.artifacts.find((entry) => entry.product === product &&
    entry.target === target && entry.sequence > installedSequence &&
    compareVersions(entry.version, installedVersion) >= 0) ?? null;
}

// Owner-signed source releases (docs/app-updates.md). A release names one git
// commit of this repository; the apps rebuild themselves from exactly that
// commit, and only when the release is signed by the key pinned in the
// installed app (blockchain/update-trust-anchor.mjs).
import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import { addressFromPublicKey, signObject, verifyObject } from "./crypto.mjs";

export const SOURCE_RELEASE_FORMAT = "nir-source-release-v1";
export const SOURCE_RELEASE_PATH = "releases/source-release.json";
const DOMAIN = "NIR_SOURCE_RELEASE_V1";
const VERSION = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;

function exact(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");
}

function validatedRelease(release) {
  if (!exact(release, ["format", "sequence", "sourceRevision", "version"]) ||
      release.format !== SOURCE_RELEASE_FORMAT ||
      !Number.isSafeInteger(release.sequence) || release.sequence < 1 ||
      !REVISION.test(release.sourceRevision ?? "") || !VERSION.test(release.version ?? "")) {
    throw new Error("source release is invalid");
  }
  return Object.freeze({ format: release.format, sequence: release.sequence,
    sourceRevision: release.sourceRevision, version: release.version });
}

export function createSourceRelease({ wallet, sequence, sourceRevision, version }) {
  const release = validatedRelease({ format: SOURCE_RELEASE_FORMAT, sequence, sourceRevision, version });
  return { release: { ...release }, signature: signObject(release, wallet, DOMAIN),
    signer: { address: wallet.address, algorithm: wallet.algorithm, publicKey: wallet.publicKey } };
}

// Returns the release only when `trustedAddress` signed it.
export function verifySourceRelease(envelope, { trustedAddress }) {
  if (typeof trustedAddress !== "string" || !ADDRESS.test(trustedAddress)) {
    throw new Error("no release signer is pinned in this app");
  }
  if (!exact(envelope, ["release", "signature", "signer"]) ||
      !exact(envelope.signer, ["address", "algorithm", "publicKey"]) ||
      envelope.signer.algorithm !== SIGNATURE_ALGORITHM ||
      envelope.signer.address !== trustedAddress ||
      typeof envelope.signer.publicKey !== "string" ||
      addressFromPublicKey(envelope.signer.publicKey) !== trustedAddress) {
    throw new Error("source release signer is not trusted");
  }
  const release = validatedRelease(envelope.release);
  if (typeof envelope.signature !== "string" ||
      !verifyObject(release, envelope.signature, envelope.signer.publicKey, DOMAIN)) {
    throw new Error("source release signature is invalid");
  }
  return release;
}

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { canonicalJson } from "./crypto.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";

const FORMAT = "nir-transaction-ingress-operator-config-v1";
const MAX_BYTES = 16 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const PATH_FIELDS = ["registryDirectory", "ceremonyAnchorPath", "checkpointPackagePath",
  "certificateDirectory", "certificateHeadAnchorPath", "floorDirectory"];
const FIELDS = ["certificateDirectory", "certificateHeadAnchorPath", "ceremonyAnchorPath",
  "checkpointPackagePath", "expectedGenesisHash", "expectedNetworkId",
  "expectedPolicyId", "expectedTlsCertificateSha256", "expectedUpstreamOrigin",
  "floorDirectory", "format", "listenHost", "listenPort", "maxWitnessAgeMs",
  "registryDirectory", "trustedReleaseSignerAddress", "validatorAddress", "version",
  "walletOrigin"];

function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }

export function assertPrivateTransactionIngressConfigParent(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") ||
      !Number.isInteger(constants.O_NOFOLLOW) || !constants.O_NOFOLLOW ||
      !Number.isInteger(constants.O_DIRECTORY) || !constants.O_DIRECTORY) {
    throw new Error("transaction ingress operator config parent is invalid");
  }
  const parent = dirname(path);
  const linked = lstatSync(parent);
  if (!linked.isDirectory() || linked.isSymbolicLink() ||
      (linked.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && linked.uid !== process.getuid())) {
    throw new Error("transaction ingress operator config parent is unsafe");
  }
  const descriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY |
    constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory() || !same(linked, opened) ||
        (opened.mode & 0o077) !== 0 || opened.uid !== linked.uid) {
      throw new Error("transaction ingress operator config parent changed");
    }
  } finally { closeSync(descriptor); }
}

export function validateTransactionIngressOperatorConfig(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...FIELDS].sort().join("\0") ||
      value.format !== FORMAT || value.version !== 1 ||
      !PATH_FIELDS.every((field) => typeof value[field] === "string" &&
        isAbsolute(value[field]) && !value[field].includes("\0")) ||
      !HASH.test(value.expectedGenesisHash ?? "") ||
      !HASH.test(value.expectedTlsCertificateSha256 ?? "") ||
      !TAGGED_HASH.test(value.expectedPolicyId ?? "") ||
      !ADDRESS.test(value.validatorAddress ?? "") ||
      !ADDRESS.test(value.trustedReleaseSignerAddress ?? "") ||
      typeof value.expectedNetworkId !== "string" ||
      value.expectedNetworkId.length < 3 || value.expectedNetworkId.length > 128 ||
      typeof value.expectedUpstreamOrigin !== "string" ||
      !["127.0.0.1", "::1"].includes(value.listenHost) ||
      !Number.isSafeInteger(value.listenPort) || value.listenPort < 1 ||
      value.listenPort > 65535 ||
      !Number.isSafeInteger(value.maxWitnessAgeMs) ||
      value.maxWitnessAgeMs < 1 || value.maxWitnessAgeMs > 120_000 ||
      (value.walletOrigin !== null && typeof value.walletOrigin !== "string")) {
    throw new Error("transaction ingress operator config schema or pins are invalid");
  }
  return structuredClone(value);
}

/** A locally trusted, owned and canonical file: it cannot create its own trust anchor. */
export function readTransactionIngressOperatorConfig(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") ||
      !Number.isInteger(constants.O_NOFOLLOW) || !constants.O_NOFOLLOW ||
      !Number.isInteger(constants.O_NONBLOCK) || !constants.O_NONBLOCK) {
    throw new Error("transaction ingress operator config path is invalid");
  }
  assertPrivateTransactionIngressConfigParent(path);
  const linked = lstatSync(path);
  if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1 ||
      linked.size < 2 || linked.size > MAX_BYTES || (linked.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && linked.uid !== process.getuid())) {
    throw new Error("transaction ingress operator config file is unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    constants.O_NONBLOCK);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !same(linked, opened) || opened.nlink !== 1 ||
        opened.size !== linked.size || (opened.mode & 0o077) !== 0 ||
        opened.uid !== linked.uid) {
      throw new Error("transaction ingress operator config changed during open");
    }
    const bytes = Buffer.alloc(opened.size); let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("transaction ingress operator config was truncated");
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(descriptor, extra, 0, 1, bytes.length) !== 0) {
      throw new Error("transaction ingress operator config expanded during read");
    }
    const after = fstatSync(descriptor); const finalLink = lstatSync(path);
    if (!same(opened, after) || !same(opened, finalLink) ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs || after.uid !== opened.uid ||
        finalLink.uid !== opened.uid || (after.mode & 0o077) !== 0 ||
        (finalLink.mode & 0o077) !== 0) {
      throw new Error("transaction ingress operator config changed during read");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = parseConsensusJson(text);
    if (text !== `${canonicalJson(value)}\n`) {
      throw new Error("transaction ingress operator config must be canonical JSON");
    }
    assertPrivateTransactionIngressConfigParent(path);
    return validateTransactionIngressOperatorConfig(value);
  } finally { closeSync(descriptor); }
}

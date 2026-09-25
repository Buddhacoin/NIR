import {
  canonicalJson, hashObject, signObject, verifyObject,
} from "./crypto.mjs";
import {
  validateReleaseAuthorizationEntry,
  validateReleaseTransparencyAnchor,
} from "./offline-release-governance.mjs";

const FORMAT = "nir-protocol-upgrade-authorization-v1";
const HASH = /^sha3-256:[0-9a-f]{64}$/;
const RAW_HASH = /^[0-9a-f]{64}$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function canonicalBase64(value, maximum, label) {
  if (typeof value !== "string" || value.length > maximum * 2 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 1 || decoded.length > maximum || decoded.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
}

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

export function validateProtocolUpgradeReleaseAnchor(value, networkId) {
  const anchor = validateReleaseTransparencyAnchor(value);
  if (anchor.networkId !== networkId) throw new Error("release anchor belongs to another network");
  return anchor;
}

export function validateProtocolReleaseHead(value, anchorValue) {
  const anchor = validateReleaseTransparencyAnchor(anchorValue);
  exact(value, ["activeSetId", "entryHash", "lastBundleHash", "sequence"], "protocol release head");
  if (value.activeSetId !== anchor.initialSet.setId || !HASH.test(value.entryHash ?? "") ||
      !(value.lastBundleHash === null || HASH.test(value.lastBundleHash ?? "")) ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      (value.sequence === 0 && (value.entryHash !== anchor.anchorHash || value.lastBundleHash !== null))) {
    throw new Error("protocol release head is invalid");
  }
  return structuredClone(value);
}

function payload(value) {
  exact(value, [
    "activationHeight", "authoritySetId", "baseHeight", "baseTipHash", "bundleHash",
    "chainIdentityGenesisHash", "currentVersion", "entryHash", "format", "manifestHash",
    "networkId", "releaseVersion", "sourceRevision", "targetVersion", "version",
  ], "protocol upgrade authorization payload");
  if (value.format !== FORMAT || value.version !== 1 ||
      !Number.isSafeInteger(value.activationHeight) || value.activationHeight < 1 ||
      !Number.isSafeInteger(value.baseHeight) || value.baseHeight < 0 ||
      !Number.isSafeInteger(value.currentVersion) || value.currentVersion < 1 ||
      !Number.isSafeInteger(value.targetVersion) || value.targetVersion !== value.currentVersion + 1 ||
      typeof value.networkId !== "string" || value.networkId.length < 1 ||
      Buffer.byteLength(value.networkId) > 64 || !RAW_HASH.test(value.baseTipHash ?? "") ||
      !RAW_HASH.test(value.chainIdentityGenesisHash ?? "") || !HASH.test(value.authoritySetId ?? "") ||
      !HASH.test(value.entryHash ?? "") || !HASH.test(value.bundleHash ?? "") ||
      !HASH.test(value.manifestHash ?? "") || !REVISION.test(value.sourceRevision ?? "") ||
      typeof value.releaseVersion !== "string" || value.releaseVersion.length < 1 ||
      value.releaseVersion.length > 64) {
    throw new Error("protocol upgrade authorization payload is invalid");
  }
  return structuredClone(value);
}

function approvalPayload(value) {
  return { authorizationHash: value.authorizationHash };
}

export function createProtocolUpgradeAuthorizationPayload(input) {
  const normalized = payload({ ...input, format: FORMAT, version: 1 });
  return {
    ...normalized,
    authorizationHash: `sha3-256:${hashObject(normalized, "PROTOCOL_UPGRADE_AUTHORIZATION_V1")}`,
  };
}

function normalizedAuthorizationPayload(value) {
  if (value?.authorizationHash === undefined) return createProtocolUpgradeAuthorizationPayload(value);
  const { authorizationHash, ...unsigned } = value;
  const normalized = payload(unsigned);
  if (authorizationHash !== `sha3-256:${hashObject(normalized,
    "PROTOCOL_UPGRADE_AUTHORIZATION_V1")}`) {
    throw new Error("protocol upgrade authorization hash is invalid");
  }
  return { ...normalized, authorizationHash };
}

export function approveProtocolUpgradeAuthorization(payloadValue, authoritySet, {
  operatorId, wallet,
}) {
  const normalized = normalizedAuthorizationPayload(payloadValue);
  const member = authoritySet?.authorities?.find((candidate) => candidate.operatorId === operatorId);
  if (!member || wallet?.address !== member.address || wallet?.publicKey !== member.publicKey) {
    throw new Error("protocol upgrade approval signer is not a release authority");
  }
  return {
    address: member.address,
    operatorId,
    signature: signObject(approvalPayload(normalized), wallet, "PROTOCOL_UPGRADE_APPROVAL_V1"),
  };
}

export function assembleProtocolUpgradeAuthorization(payloadValue, releaseEntry, approvals) {
  const normalized = normalizedAuthorizationPayload(payloadValue);
  return { ...normalized, approvals: structuredClone(approvals), releaseEntry: structuredClone(releaseEntry) };
}

export function validateProtocolUpgradeAuthorization(value, {
  activationHeight,
  anchor: anchorValue,
  baseHeight,
  baseTipHash,
  chainIdentityGenesisHash,
  currentVersion,
  head,
  networkId,
  targetVersion,
} = {}) {
  exact(value, [
    "activationHeight", "approvals", "authoritySetId", "authorizationHash", "baseHeight",
    "baseTipHash", "bundleHash", "chainIdentityGenesisHash", "currentVersion", "entryHash",
    "format", "manifestHash", "networkId", "releaseEntry", "releaseVersion", "sourceRevision",
    "targetVersion", "version",
  ], "protocol upgrade authorization");
  const { approvals, authorizationHash, releaseEntry, ...unsigned } = value;
  const normalized = payload(unsigned);
  const expectedHash = `sha3-256:${hashObject(normalized, "PROTOCOL_UPGRADE_AUTHORIZATION_V1")}`;
  if (authorizationHash !== expectedHash || normalized.activationHeight !== activationHeight ||
      normalized.baseHeight !== baseHeight || normalized.baseTipHash !== baseTipHash ||
      normalized.chainIdentityGenesisHash !== chainIdentityGenesisHash ||
      normalized.currentVersion !== currentVersion || normalized.targetVersion !== targetVersion ||
      normalized.networkId !== networkId) {
    throw new Error("protocol upgrade authorization does not match the chain transition");
  }
  const anchor = validateProtocolUpgradeReleaseAnchor(anchorValue, networkId);
  const trustedHead = validateProtocolReleaseHead(head, anchor);
  if (
      normalized.authoritySetId !== anchor.initialSet.setId) {
    throw new Error("protocol upgrade release governance head is invalid");
  }
  const release = validateReleaseAuthorizationEntry(releaseEntry, {
    authoritySet: anchor.initialSet,
    entryHash: trustedHead.entryHash,
    lastBundleHash: trustedHead.lastBundleHash,
    logId: anchor.logId,
    networkId,
    sequence: trustedHead.sequence,
  });
  if (release.head.entryHash !== normalized.entryHash ||
      release.release.bundleHash !== normalized.bundleHash ||
      release.release.manifestHash !== normalized.manifestHash ||
      release.release.sourceRevision !== normalized.sourceRevision ||
      release.release.releaseVersion !== normalized.releaseVersion ||
      release.release.protocolVersion !== targetVersion) {
    throw new Error("protocol upgrade authorization does not match its authorized release");
  }
  if (!Array.isArray(approvals) || approvals.length < anchor.initialSet.threshold ||
      approvals.length > anchor.initialSet.authorities.length) {
    throw new Error("protocol upgrade authorization quorum is missing");
  }
  const seen = new Set();
  const ordered = approvals.map((approval) => {
    exact(approval, ["address", "operatorId", "signature"], "protocol upgrade approval");
    canonicalBase64(approval.signature, 16 * 1024,
      "protocol upgrade authorization approval signature");
    const member = anchor.initialSet.authorities.find(({ operatorId }) => operatorId === approval.operatorId);
    if (!member || member.address !== approval.address || seen.has(approval.operatorId) ||
        !verifyObject(approvalPayload({ authorizationHash }), approval.signature, member.publicKey,
          "PROTOCOL_UPGRADE_APPROVAL_V1")) {
      throw new Error("protocol upgrade authorization approval is invalid or duplicate");
    }
    seen.add(approval.operatorId);
    return structuredClone(approval);
  }).sort((left, right) => left.operatorId.localeCompare(right.operatorId));
  if (canonicalJson(ordered) !== canonicalJson(approvals)) {
    throw new Error("protocol upgrade authorization approvals are not canonically ordered");
  }
  return {
    authorization: { ...normalized, approvals: ordered, authorizationHash, releaseEntry: release.entry },
    nextHead: release.head,
  };
}

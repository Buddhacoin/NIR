import {
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./constants.mjs";

const FORMAT = "nir-protocol-upgrade-v1";
const MAX_VERSION = 2_147_483_647;

export function normalizeSupportedProtocolVersions(
  versions = SUPPORTED_PROTOCOL_VERSIONS,
) {
  if (!Array.isArray(versions) || versions.length < 1 ||
      versions.some((version) => !Number.isSafeInteger(version) || version < PROTOCOL_VERSION ||
        version > MAX_VERSION) || new Set(versions).size !== versions.length) {
    throw new Error("supported protocol versions are invalid");
  }
  const ordered = [...versions].sort((left, right) => left - right);
  if (ordered.some((version, index) => version !== PROTOCOL_VERSION + index)) {
    throw new Error("supported protocol versions must be contiguous from genesis");
  }
  return ordered;
}

export function normalizeProtocolUpgrade(value, {
  currentHeight,
  currentVersion,
  pendingUpgrade = null,
} = {}) {
  if (pendingUpgrade !== null) throw new Error("a protocol upgrade is already pending");
  if (!value || Object.keys(value).sort().join(",") !== "activationHeight,format,version" ||
      value.format !== FORMAT || !Number.isSafeInteger(currentHeight) || currentHeight < 1 ||
      !Number.isSafeInteger(currentVersion) || currentVersion < PROTOCOL_VERSION ||
      !Number.isSafeInteger(value.version) || value.version !== currentVersion + 1 ||
      value.version > MAX_VERSION || !Number.isSafeInteger(value.activationHeight) ||
      value.activationHeight < currentHeight + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS) {
    throw new Error("protocol upgrade schedule is invalid");
  }
  return {
    activationHeight: value.activationHeight,
    format: FORMAT,
    version: value.version,
  };
}

export function normalizePendingProtocolUpgrade(value, { currentHeight, currentVersion } = {}) {
  if (value === null) return null;
  if (!value || Object.keys(value).sort().join(",") !== "activationHeight,format,version" ||
      value.format !== FORMAT || !Number.isSafeInteger(currentHeight) || currentHeight < 0 ||
      !Number.isSafeInteger(currentVersion) || currentVersion < PROTOCOL_VERSION ||
      !Number.isSafeInteger(value.version) || value.version !== currentVersion + 1 ||
      value.version > MAX_VERSION || !Number.isSafeInteger(value.activationHeight) ||
      value.activationHeight <= currentHeight) {
    throw new Error("pending protocol upgrade is invalid");
  }
  return structuredClone(value);
}

export function protocolTransition({
  blockVersion,
  currentHeight,
  currentVersion,
  pendingUpgrade = null,
  proposedUpgrade = null,
  supportedVersions = SUPPORTED_PROTOCOL_VERSIONS,
} = {}) {
  const supported = normalizeSupportedProtocolVersions(supportedVersions);
  if (!Number.isSafeInteger(currentHeight) || currentHeight < 1 ||
      !Number.isSafeInteger(currentVersion) || currentVersion < PROTOCOL_VERSION) {
    throw new Error("protocol transition state is invalid");
  }
  let activeVersion = currentVersion;
  let pendingAfter = normalizePendingProtocolUpgrade(pendingUpgrade, {
    currentHeight: currentHeight - 1,
    currentVersion,
  });
  if (pendingAfter && currentHeight === pendingAfter.activationHeight) {
    activeVersion = pendingAfter.version;
    pendingAfter = null;
  }
  if (!supported.includes(activeVersion)) {
    throw new Error(`unsupported protocol version ${activeVersion} at height ${currentHeight}`);
  }
  if (blockVersion !== activeVersion) {
    throw new Error("block protocol version does not match its activation height");
  }
  if (proposedUpgrade !== null) {
    pendingAfter = normalizeProtocolUpgrade(proposedUpgrade, {
      currentHeight,
      currentVersion: activeVersion,
      pendingUpgrade: pendingAfter,
    });
  }
  return {
    pendingUpgrade: pendingAfter,
    protocolVersion: activeVersion,
  };
}

export function protocolVersionAtNextHeight({
  currentHeight,
  currentVersion,
  pendingUpgrade = null,
  supportedVersions = SUPPORTED_PROTOCOL_VERSIONS,
} = {}) {
  return protocolTransition({
    blockVersion: pendingUpgrade?.activationHeight === currentHeight + 1
      ? pendingUpgrade.version : currentVersion,
    currentHeight: currentHeight + 1,
    currentVersion,
    pendingUpgrade,
    supportedVersions,
  }).protocolVersion;
}

import {
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./constants.mjs";
import { validateProtocolUpgradeAuthorization } from "./protocol-upgrade-authorization.mjs";

const LEGACY_FORMAT = "nir-protocol-upgrade-v1";
const AUTHORIZED_FORMAT = "nir-protocol-upgrade-v2";
export const AUTHORIZED_PROTOCOL_UPGRADE_VERSION = 29;
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

function normalizeProtocolUpgradeWithContext(value, {
  currentHeight,
  currentVersion,
  pendingUpgrade = null,
  authorizationContext = null,
} = {}) {
  if (pendingUpgrade !== null) throw new Error("a protocol upgrade is already pending");
  const authorized = value?.version >= AUTHORIZED_PROTOCOL_UPGRADE_VERSION;
  const keys = authorized ? "activationHeight,authorization,format,version" :
    "activationHeight,format,version";
  if (!value || Object.keys(value).sort().join(",") !== keys ||
      value.format !== (authorized ? AUTHORIZED_FORMAT : LEGACY_FORMAT) ||
      !Number.isSafeInteger(currentHeight) || currentHeight < 1 ||
      !Number.isSafeInteger(currentVersion) || currentVersion < PROTOCOL_VERSION ||
      !Number.isSafeInteger(value.version) || value.version !== currentVersion + 1 ||
      value.version > MAX_VERSION || !Number.isSafeInteger(value.activationHeight) ||
      value.activationHeight < currentHeight + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS) {
    throw new Error("protocol upgrade schedule is invalid");
  }
  let nextReleaseHead = authorizationContext?.head ?? null;
  let authorization;
  if (authorized) {
    if (!authorizationContext) throw new Error("protocol upgrade authorization context is required");
    const verified = validateProtocolUpgradeAuthorization(value.authorization, {
      ...authorizationContext,
      activationHeight: value.activationHeight,
      currentVersion,
      targetVersion: value.version,
    });
    authorization = verified.authorization;
    nextReleaseHead = verified.nextHead;
  }
  return { schedule: {
    activationHeight: value.activationHeight,
    ...(authorized ? { authorization } : {}),
    format: authorized ? AUTHORIZED_FORMAT : LEGACY_FORMAT,
    version: value.version,
  }, nextReleaseHead };
}

export function normalizeProtocolUpgrade(value, options = {}) {
  return normalizeProtocolUpgradeWithContext(value, options).schedule;
}

export function normalizePendingProtocolUpgrade(value, { currentHeight, currentVersion } = {}) {
  if (value === null) return null;
  const authorized = value?.version >= AUTHORIZED_PROTOCOL_UPGRADE_VERSION;
  const keys = authorized ? "activationHeight,authorization,format,version" :
    "activationHeight,format,version";
  if (!value || Object.keys(value).sort().join(",") !== keys ||
      value.format !== (authorized ? AUTHORIZED_FORMAT : LEGACY_FORMAT) ||
      !Number.isSafeInteger(currentHeight) || currentHeight < 0 ||
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
  authorizationContext = null,
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
    const normalized = normalizeProtocolUpgradeWithContext(proposedUpgrade, {
      authorizationContext,
      currentHeight,
      currentVersion: activeVersion,
      pendingUpgrade: pendingAfter,
    });
    pendingAfter = normalized.schedule;
    authorizationContext = authorizationContext === null ? null : {
      ...authorizationContext, head: normalized.nextReleaseHead,
    };
  }
  return {
    pendingUpgrade: pendingAfter,
    protocolVersion: activeVersion,
    protocolReleaseHead: authorizationContext?.head ?? null,
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

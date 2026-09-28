import { randomBytes } from "node:crypto";

import { canonicalJson, hashObject, signObject, verifyObject } from "./crypto.mjs";
import {
  createValidatorReadinessRolePackage,
  verifyValidatorReadinessRolePackage,
} from "./validator-readiness-session.mjs";
import { encryptedVaultPublicCommitment } from "./vault.mjs";

const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const SIGNER_ROLES = new Set(["consensus", "transport"]);
const BOOTSTRAP_FORMATS = Object.freeze({
  consensus: "nir-validator-readiness-consensus-process-bootstrap-v1",
  gateway: "nir-validator-readiness-gateway-process-bootstrap-v1",
  transport: "nir-validator-readiness-transport-process-bootstrap-v1",
});
const HEIGHT_FORMATS = Object.freeze({
  consensus: "nir-validator-readiness-consensus-height-update-v1",
  transport: "nir-validator-readiness-transport-height-update-v1",
});
const READY_FORMATS = Object.freeze({
  consensus: "nir-validator-readiness-consensus-process-ready-v1",
  transport: "nir-validator-readiness-transport-process-ready-v1",
});
export const VALIDATOR_READINESS_CONSENSUS_PROCESS_READY_SIGNATURE_DOMAIN =
  "VR_CONS_PROCESS_READY_SIG_V1";
export const VALIDATOR_READINESS_TRANSPORT_PROCESS_READY_SIGNATURE_DOMAIN =
  "VR_TRANS_PROCESS_READY_SIG_V1";
// The conventional name lets the conformance inventory enumerate fixed domains used via role maps.
const domains = {
  bootstrap: {
    consensus: "VR_CONS_PROCESS_BOOTSTRAP_V1",
    gateway: "VR_GATE_PROCESS_BOOTSTRAP_V1",
    transport: "VR_TRANS_PROCESS_BOOTSTRAP_V1",
  },
  height: {
    consensus: "VR_CONS_HEIGHT_UPDATE_V1",
    transport: "VR_TRANS_HEIGHT_UPDATE_V1",
  },
  readyHash: {
    consensus: "VR_CONS_PROCESS_READY_HASH_V1",
    transport: "VR_TRANS_PROCESS_READY_HASH_V1",
  },
  readySignature: {
    consensus: VALIDATOR_READINESS_CONSENSUS_PROCESS_READY_SIGNATURE_DOMAIN,
    transport: VALIDATOR_READINESS_TRANSPORT_PROCESS_READY_SIGNATURE_DOMAIN,
  },
};
const LIMIT_FIELDS = Object.freeze([
  "bodyIdleTimeoutMs", "burst", "maxActive", "maxActivePerAddress",
  "maxCompletedChallenges", "maxConnections", "requestTimeoutMs", "requestsPerMinute",
  "responseTimeoutMs",
]);
const DEFAULT_LIMITS = Object.freeze({
  bodyIdleTimeoutMs: 5_000,
  burst: 32,
  maxActive: 32,
  maxActivePerAddress: 8,
  maxCompletedChallenges: 65_536,
  maxConnections: 32,
  requestTimeoutMs: 10_000,
  requestsPerMinute: 120,
  responseTimeoutMs: 5_000,
});

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function clone(value) { return JSON.parse(canonicalJson(value)); }
function tagged(value, domain) { return `sha3-256:${hashObject(value, domain)}`; }

function nonce(value, label) {
  if (!HASH.test(value ?? "")) throw new Error(`${label} is invalid`);
  return value;
}

function signerIdentity(session, role) {
  const identity = role === "transport" ? session.context.transport : session.context.candidate;
  return { address: identity.address, algorithm: identity.algorithm, publicKey: identity.publicKey };
}

function same(left, right) { return canonicalJson(left) === canonicalJson(right); }

function verifyLocalLaunchBinding(bootstrap, {
  expectedLauncherNonce, expectedReleaseProvenanceHash, expectedSessionHash,
} = {}, label = "validator readiness process") {
  nonce(expectedLauncherNonce, `${label} expected launcher nonce`);
  if (!TAGGED_HASH.test(expectedReleaseProvenanceHash ?? "") ||
      !TAGGED_HASH.test(expectedSessionHash ?? "") ||
      bootstrap.launcherNonce !== expectedLauncherNonce ||
      bootstrap.releaseProvenanceHash !== expectedReleaseProvenanceHash ||
      bootstrap.sessionHash !== expectedSessionHash) {
    throw new Error(`${label} local launch binding is invalid`);
  }
}

function height(value, session, label) {
  if (!Number.isSafeInteger(value) || value < session.context.checkpoint.height ||
      value >= session.expiresAtHeight) {
    throw new Error(`${label} is invalid or expired`);
  }
  return value;
}

function role(value) {
  if (!SIGNER_ROLES.has(value)) throw new Error("validator readiness process signer role is invalid");
  return value;
}

function limits(value = {}) {
  exact(value, LIMIT_FIELDS, "validator readiness gateway process limits");
  const ranges = {
    bodyIdleTimeoutMs: [10, 60_000], burst: [1, 100_000], maxActive: [1, 100_000],
    maxActivePerAddress: [1, 10_000], maxCompletedChallenges: [1, 1_000_000],
    maxConnections: [1, 100_000], requestTimeoutMs: [100, 300_000],
    requestsPerMinute: [1, 1_000_000], responseTimeoutMs: [1, 60_000],
  };
  for (const field of LIMIT_FIELDS) {
    const [minimum, maximum] = ranges[field];
    if (!Number.isSafeInteger(value[field]) || value[field] < minimum || value[field] > maximum) {
      throw new Error(`validator readiness gateway process ${field} is invalid`);
    }
  }
  if (value.maxActivePerAddress > value.maxActive) {
    throw new Error("validator readiness gateway per-address limit exceeds the global limit");
  }
  return clone(value);
}

function signerBootstrapPayload(value, expectedRole, now) {
  role(expectedRole);
  exact(value, ["format", "initialHeight", "launcherNonce", "releaseProvenanceHash", "role",
    "rolePackage", "rolePackageHash", "sessionHash", "vaultCommitment", "version"],
  `validator readiness ${expectedRole} process bootstrap payload`);
  const rolePackage = verifyValidatorReadinessRolePackage(value.rolePackage,
    { expectedRole, now });
  exact(value.vaultCommitment, ["address", "algorithm", "publicKey", "vaultHash"],
    "validator readiness process vault commitment");
  const expectedIdentity = signerIdentity(rolePackage.session, expectedRole);
  if (value.format !== BOOTSTRAP_FORMATS[expectedRole] || value.version !== 1 ||
      value.role !== expectedRole || value.rolePackageHash !== rolePackage.rolePackageHash ||
      value.sessionHash !== rolePackage.session.sessionHash ||
      value.releaseProvenanceHash !== rolePackage.session.releaseProvenanceHash ||
      !TAGGED_HASH.test(value.vaultCommitment.vaultHash ?? "") ||
      !same(expectedIdentity, { address: value.vaultCommitment.address,
        algorithm: value.vaultCommitment.algorithm, publicKey: value.vaultCommitment.publicKey })) {
    throw new Error(`validator readiness ${expectedRole} process bootstrap binding is invalid`);
  }
  nonce(value.launcherNonce, "validator readiness launcher nonce");
  height(value.initialHeight, rolePackage.session,
    `validator readiness ${expectedRole} process initial height`);
  return { format: value.format, initialHeight: value.initialHeight,
    launcherNonce: value.launcherNonce, releaseProvenanceHash: value.releaseProvenanceHash,
    role: expectedRole, rolePackage, rolePackageHash: value.rolePackageHash,
    sessionHash: value.sessionHash, vaultCommitment: clone(value.vaultCommitment), version: 1 };
}

function verifySignerBootstrapEnvelope(value, expectedRole, now) {
  exact(value, ["bootstrapHash", "format", "initialHeight", "launcherNonce",
    "releaseProvenanceHash", "role", "rolePackage", "rolePackageHash", "sessionHash",
    "vaultCommitment", "version"], `validator readiness ${expectedRole} process bootstrap`);
  const { bootstrapHash, ...unsigned } = value;
  const payload = signerBootstrapPayload(unsigned, expectedRole, now);
  if (!TAGGED_HASH.test(bootstrapHash ?? "") ||
      bootstrapHash !== tagged(payload, domains.bootstrap[expectedRole])) {
    throw new Error(`validator readiness ${expectedRole} process bootstrap hash is invalid`);
  }
  return { ...payload, bootstrapHash };
}

function createSignerBootstrap({ encryptedVault, initialHeight, launcherNonce, rolePackage },
  expectedRole, now) {
  const verifiedRole = verifyValidatorReadinessRolePackage(rolePackage,
    { expectedRole, now });
  const payload = signerBootstrapPayload({ format: BOOTSTRAP_FORMATS[expectedRole],
    initialHeight, launcherNonce,
    releaseProvenanceHash: verifiedRole.session.releaseProvenanceHash,
    role: expectedRole, rolePackage: verifiedRole, rolePackageHash: verifiedRole.rolePackageHash,
    sessionHash: verifiedRole.session.sessionHash,
    vaultCommitment: encryptedVaultPublicCommitment(encryptedVault), version: 1 }, expectedRole, now);
  return { ...payload, bootstrapHash: tagged(payload, domains.bootstrap[expectedRole]) };
}

function gatewayBootstrapPayload(value, { consensusSignerBootstrap,
  transportSignerBootstrap }, now) {
  exact(value, ["consensusSignerBootstrapHash", "format", "initialHeight", "launcherNonce",
    "limits", "releaseProvenanceHash", "role", "rolePackage", "rolePackageHash", "sessionHash",
    "tlsCertificateSha256", "transportSignerBootstrapHash", "version"],
  "validator readiness gateway process bootstrap payload");
  const rolePackage = verifyValidatorReadinessRolePackage(value.rolePackage,
    { expectedRole: "gateway", now });
  const consensus = verifySignerBootstrapEnvelope(consensusSignerBootstrap, "consensus", now);
  const transport = verifySignerBootstrapEnvelope(transportSignerBootstrap, "transport", now);
  nonce(value.launcherNonce, "validator readiness launcher nonce");
  const common = [consensus, transport];
  if (value.format !== BOOTSTRAP_FORMATS.gateway || value.version !== 1 ||
      value.role !== "gateway" || value.rolePackageHash !== rolePackage.rolePackageHash ||
      value.sessionHash !== rolePackage.session.sessionHash ||
      value.releaseProvenanceHash !== rolePackage.session.releaseProvenanceHash ||
      value.tlsCertificateSha256 !== rolePackage.session.context.tlsCertificateSha256 ||
      value.consensusSignerBootstrapHash !== consensus.bootstrapHash ||
      value.transportSignerBootstrapHash !== transport.bootstrapHash ||
      common.some((item) => item.launcherNonce !== value.launcherNonce ||
        item.sessionHash !== value.sessionHash || item.releaseProvenanceHash !== value.releaseProvenanceHash ||
        item.initialHeight !== value.initialHeight) ||
      !HASH.test(value.tlsCertificateSha256 ?? "")) {
    throw new Error("validator readiness gateway process bootstrap binding is invalid");
  }
  height(value.initialHeight, rolePackage.session, "validator readiness gateway process initial height");
  return { consensusSignerBootstrapHash: value.consensusSignerBootstrapHash,
    format: value.format, initialHeight: value.initialHeight, launcherNonce: value.launcherNonce,
    limits: limits(value.limits), releaseProvenanceHash: value.releaseProvenanceHash,
    role: "gateway", rolePackage, rolePackageHash: value.rolePackageHash,
    sessionHash: value.sessionHash, tlsCertificateSha256: value.tlsCertificateSha256,
    transportSignerBootstrapHash: value.transportSignerBootstrapHash, version: 1 };
}

export function createValidatorReadinessProcessBootstrapSet({ consensusVault,
  gatewayLimits = DEFAULT_LIMITS, gatewayRolePackage, initialHeight, tlsCertificateSha256,
  transportVault } = {}, { now = Date.now() } = {}) {
  const gateway = verifyValidatorReadinessRolePackage(gatewayRolePackage,
    { expectedRole: "gateway", now });
  const launcherNonce = randomBytes(32).toString("hex");
  const consensusRolePackage = createValidatorReadinessRolePackage(gateway.session, "consensus",
    { now });
  const transportRolePackage = createValidatorReadinessRolePackage(gateway.session, "transport",
    { now });
  const consensusSignerBootstrap = createSignerBootstrap({ encryptedVault: consensusVault,
    initialHeight, launcherNonce, rolePackage: consensusRolePackage }, "consensus", now);
  const transportSignerBootstrap = createSignerBootstrap({ encryptedVault: transportVault,
    initialHeight, launcherNonce, rolePackage: transportRolePackage }, "transport", now);
  const gatewayPayload = gatewayBootstrapPayload({
    consensusSignerBootstrapHash: consensusSignerBootstrap.bootstrapHash,
    format: BOOTSTRAP_FORMATS.gateway, initialHeight, launcherNonce,
    limits: { ...gatewayLimits }, releaseProvenanceHash: gateway.session.releaseProvenanceHash,
    role: "gateway", rolePackage: gateway, rolePackageHash: gateway.rolePackageHash,
    sessionHash: gateway.session.sessionHash, tlsCertificateSha256,
    transportSignerBootstrapHash: transportSignerBootstrap.bootstrapHash, version: 1,
  }, { consensusSignerBootstrap, transportSignerBootstrap }, now);
  const gatewayBootstrap = { ...gatewayPayload,
    bootstrapHash: tagged(gatewayPayload, domains.bootstrap.gateway) };
  return { consensusSignerBootstrap, gatewayBootstrap, launcherNonce,
    transportSignerBootstrap };
}

export function verifyValidatorReadinessSignerProcessBootstrap(value, { encryptedVault,
  expectedLauncherNonce, expectedReleaseProvenanceHash, expectedRole, expectedSessionHash,
  now = Date.now(),
} = {}) {
  const bootstrap = verifySignerBootstrapEnvelope(value, expectedRole, now);
  verifyLocalLaunchBinding(bootstrap, { expectedLauncherNonce,
    expectedReleaseProvenanceHash, expectedSessionHash },
  `validator readiness ${expectedRole} process bootstrap`);
  const commitment = encryptedVaultPublicCommitment(encryptedVault);
  if (!same(commitment, bootstrap.vaultCommitment)) {
    throw new Error(`validator readiness ${expectedRole} process vault binding is invalid`);
  }
  return bootstrap;
}

export function verifyValidatorReadinessGatewayProcessBootstrap(value, {
  consensusSignerBootstrap, expectedLauncherNonce, expectedReleaseProvenanceHash,
  expectedSessionHash, now = Date.now(), transportSignerBootstrap,
} = {}) {
  exact(value, ["bootstrapHash", "consensusSignerBootstrapHash", "format", "initialHeight",
    "launcherNonce", "limits", "releaseProvenanceHash", "role", "rolePackage",
    "rolePackageHash", "sessionHash", "tlsCertificateSha256", "transportSignerBootstrapHash",
    "version"], "validator readiness gateway process bootstrap");
  const { bootstrapHash, ...unsigned } = value;
  const payload = gatewayBootstrapPayload(unsigned,
    { consensusSignerBootstrap, transportSignerBootstrap }, now);
  verifyLocalLaunchBinding(payload, { expectedLauncherNonce,
    expectedReleaseProvenanceHash, expectedSessionHash },
  "validator readiness gateway process bootstrap");
  if (!TAGGED_HASH.test(bootstrapHash ?? "") ||
      bootstrapHash !== tagged(payload, domains.bootstrap.gateway)) {
    throw new Error("validator readiness gateway process bootstrap hash is invalid");
  }
  return { ...payload, bootstrapHash };
}

function heightUpdatePayload(value, bootstrap, expectedRole, previousUpdate, now) {
  const pinned = verifySignerBootstrapEnvelope(bootstrap, expectedRole, now);
  exact(value, ["bootstrapHash", "format", "height", "launcherNonce", "predecessorHash",
    "releaseProvenanceHash", "role", "rolePackageHash", "sequence", "sessionHash", "version"],
  `validator readiness ${expectedRole} height update payload`);
  let predecessorHash = pinned.bootstrapHash; let minimumHeight = pinned.initialHeight;
  let sequence = 1;
  if (previousUpdate !== null) {
    const previous = verifyHeightUpdateStandalone(previousUpdate, pinned, expectedRole, now);
    predecessorHash = previous.updateHash; minimumHeight = previous.height;
    sequence = previous.sequence + 1;
  }
  if (value.format !== HEIGHT_FORMATS[expectedRole] || value.version !== 1 ||
      value.role !== expectedRole || value.bootstrapHash !== pinned.bootstrapHash ||
      value.launcherNonce !== pinned.launcherNonce || value.sessionHash !== pinned.sessionHash ||
      value.rolePackageHash !== pinned.rolePackageHash ||
      value.releaseProvenanceHash !== pinned.releaseProvenanceHash ||
      value.predecessorHash !== predecessorHash || value.sequence !== sequence ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !Number.isSafeInteger(value.height) || value.height < minimumHeight) {
    throw new Error(`validator readiness ${expectedRole} height update binding is invalid`);
  }
  height(value.height, pinned.rolePackage.session,
    `validator readiness ${expectedRole} height update`);
  return clone(value);
}

function verifyHeightUpdateStandalone(value, bootstrap, expectedRole, now) {
  const pinned = verifySignerBootstrapEnvelope(bootstrap, expectedRole, now);
  exact(value, ["bootstrapHash", "format", "height", "launcherNonce", "predecessorHash",
    "releaseProvenanceHash", "role", "rolePackageHash", "sequence", "sessionHash", "updateHash",
    "version"], `validator readiness ${expectedRole} previous height update`);
  const { updateHash, ...payload } = value;
  if (payload.format !== HEIGHT_FORMATS[expectedRole] || payload.version !== 1 ||
      payload.role !== expectedRole || payload.bootstrapHash !== pinned.bootstrapHash ||
      payload.launcherNonce !== pinned.launcherNonce || payload.sessionHash !== pinned.sessionHash ||
      payload.rolePackageHash !== pinned.rolePackageHash ||
      payload.releaseProvenanceHash !== pinned.releaseProvenanceHash ||
      !Number.isSafeInteger(payload.sequence) || payload.sequence < 1 ||
      !TAGGED_HASH.test(payload.predecessorHash ?? "") ||
      !TAGGED_HASH.test(updateHash ?? "") ||
      updateHash !== tagged(payload, domains.height[expectedRole])) {
    throw new Error(`validator readiness ${expectedRole} previous height update is invalid`);
  }
  height(payload.height, pinned.rolePackage.session,
    `validator readiness ${expectedRole} previous height update`);
  if (payload.sequence === 1 && payload.predecessorHash !== pinned.bootstrapHash) {
    throw new Error(`validator readiness ${expectedRole} previous height predecessor is invalid`);
  }
  return { ...clone(payload), updateHash };
}

function verifyHeightUpdateEnvelope(value, bootstrap, expectedRole, now,
  previousUpdate = undefined) {
  exact(value, ["bootstrapHash", "format", "height", "launcherNonce", "predecessorHash",
    "releaseProvenanceHash", "role", "rolePackageHash", "sequence", "sessionHash", "updateHash",
    "version"], `validator readiness ${expectedRole} height update`);
  const { updateHash, ...unsigned } = value;
  const payload = heightUpdatePayload(unsigned, bootstrap, expectedRole,
    previousUpdate === undefined ? null : previousUpdate, now);
  if (!TAGGED_HASH.test(updateHash ?? "") ||
      updateHash !== tagged(payload, domains.height[expectedRole])) {
    throw new Error(`validator readiness ${expectedRole} height update hash is invalid`);
  }
  return { ...payload, updateHash };
}

export function createValidatorReadinessHeightUpdate({ bootstrap, height: currentHeight,
  previousUpdate = null } = {}, { now = Date.now() } = {}) {
  const expectedRole = role(bootstrap?.role);
  const pinned = verifySignerBootstrapEnvelope(bootstrap, expectedRole, now);
  const previous = previousUpdate === null ? null
    : verifyHeightUpdateStandalone(previousUpdate, pinned, expectedRole, now);
  const payload = heightUpdatePayload({ bootstrapHash: pinned.bootstrapHash,
    format: HEIGHT_FORMATS[expectedRole], height: currentHeight,
    launcherNonce: pinned.launcherNonce,
    predecessorHash: previous?.updateHash ?? pinned.bootstrapHash,
    releaseProvenanceHash: pinned.releaseProvenanceHash, role: expectedRole,
    rolePackageHash: pinned.rolePackageHash, sequence: (previous?.sequence ?? 0) + 1,
    sessionHash: pinned.sessionHash, version: 1 }, pinned, expectedRole, previous, now);
  return { ...payload, updateHash: tagged(payload, domains.height[expectedRole]) };
}

export function verifyValidatorReadinessHeightUpdate(value, { bootstrap, expectedRole,
  expectedLauncherNonce, expectedReleaseProvenanceHash, expectedSessionHash,
  now = Date.now(), previousUpdate = null,
} = {}) {
  role(expectedRole);
  const pinned = verifySignerBootstrapEnvelope(bootstrap, expectedRole, now);
  verifyLocalLaunchBinding(pinned, { expectedLauncherNonce,
    expectedReleaseProvenanceHash, expectedSessionHash },
  `validator readiness ${expectedRole} height update`);
  return verifyHeightUpdateEnvelope(value, bootstrap, expectedRole, now,
    previousUpdate === null ? undefined : previousUpdate);
}

function readyPayload(value, bootstrap, expectedRole, now) {
  const pinned = verifySignerBootstrapEnvelope(bootstrap, expectedRole, now);
  exact(value, ["address", "bootstrapHash", "format", "launcherNonce", "pid", "processNonce",
    "releaseProvenanceHash", "role", "rolePackageHash", "sessionHash", "vaultHash", "version"],
  `validator readiness ${expectedRole} process ready payload`);
  const identity = signerIdentity(pinned.rolePackage.session, expectedRole);
  if (value.format !== READY_FORMATS[expectedRole] || value.version !== 1 ||
      value.role !== expectedRole || value.address !== identity.address ||
      value.bootstrapHash !== pinned.bootstrapHash || value.launcherNonce !== pinned.launcherNonce ||
      value.rolePackageHash !== pinned.rolePackageHash || value.sessionHash !== pinned.sessionHash ||
      value.releaseProvenanceHash !== pinned.releaseProvenanceHash ||
      value.vaultHash !== pinned.vaultCommitment.vaultHash ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0x7fff_ffff) {
    throw new Error(`validator readiness ${expectedRole} process ready binding is invalid`);
  }
  nonce(value.processNonce, `validator readiness ${expectedRole} process nonce`);
  return clone(value);
}

export function createValidatorReadinessSignerReady({ bootstrap, pid, wallet } = {},
  { now = Date.now() } = {}) {
  const expectedRole = role(bootstrap?.role);
  const pinned = verifySignerBootstrapEnvelope(bootstrap, expectedRole, now);
  const identity = signerIdentity(pinned.rolePackage.session, expectedRole);
  if (!wallet || !same(identity, { address: wallet.address, algorithm: wallet.algorithm,
    publicKey: wallet.publicKey })) {
    throw new Error(`validator readiness ${expectedRole} ready signer is invalid`);
  }
  const payload = readyPayload({ address: identity.address, bootstrapHash: pinned.bootstrapHash,
    format: READY_FORMATS[expectedRole], launcherNonce: pinned.launcherNonce, pid,
    processNonce: randomBytes(32).toString("hex"),
    releaseProvenanceHash: pinned.releaseProvenanceHash, role: expectedRole,
    rolePackageHash: pinned.rolePackageHash, sessionHash: pinned.sessionHash,
    vaultHash: pinned.vaultCommitment.vaultHash, version: 1 }, pinned, expectedRole, now);
  const readyHash = tagged(payload, domains.readyHash[expectedRole]);
  return { ...payload, readyHash, signature: signObject({ ...payload, readyHash }, wallet,
    domains.readySignature[expectedRole]) };
}

export function createValidatorReadinessSignerReadyWithCapability({ bootstrap, pid, signer } = {},
  { now = Date.now() } = {}) {
  const expectedRole = role(bootstrap?.role);
  const pinned = verifySignerBootstrapEnvelope(bootstrap, expectedRole, now);
  const identity = signerIdentity(pinned.rolePackage.session, expectedRole);
  const operationMethod = expectedRole === "transport" ? "signReadinessTransportInput"
    : "signReadinessConsensusInput";
  const capabilityFields = ["address", "algorithm", "publicKey", operationMethod,
    "signValidatorReadinessReadyInput"].sort();
  const descriptors = signer && Object.getOwnPropertyDescriptors(signer);
  const publicDescriptorsAreData = ["address", "algorithm", "publicKey"].every((field) =>
    descriptors?.[field] && Object.hasOwn(descriptors[field], "value") &&
    descriptors[field].enumerable === true && descriptors[field].writable === false &&
    descriptors[field].configurable === false);
  const methodDescriptorsAreData = [operationMethod, "signValidatorReadinessReadyInput"]
    .every((field) => descriptors?.[field] && Object.hasOwn(descriptors[field], "value") &&
      descriptors[field].enumerable === false && descriptors[field].writable === false &&
      descriptors[field].configurable === false);
  if (!signer || Object.getPrototypeOf(signer) !== null || !Object.isFrozen(signer) ||
      Reflect.ownKeys(signer).some((key) => typeof key !== "string") ||
      Reflect.ownKeys(signer).sort().join("\0") !== capabilityFields.join("\0") ||
      !publicDescriptorsAreData || !methodDescriptorsAreData ||
      !same(identity, { address: signer.address, algorithm: signer.algorithm,
        publicKey: signer.publicKey }) || typeof signer[operationMethod] !== "function" ||
      typeof signer.signValidatorReadinessReadyInput !== "function") {
    throw new Error(`validator readiness ${expectedRole} ready signer capability is invalid`);
  }
  const payload = readyPayload({ address: identity.address, bootstrapHash: pinned.bootstrapHash,
    format: READY_FORMATS[expectedRole], launcherNonce: pinned.launcherNonce, pid,
    processNonce: randomBytes(32).toString("hex"),
    releaseProvenanceHash: pinned.releaseProvenanceHash, role: expectedRole,
    rolePackageHash: pinned.rolePackageHash, sessionHash: pinned.sessionHash,
    vaultHash: pinned.vaultCommitment.vaultHash, version: 1 }, pinned, expectedRole, now);
  const readyHash = tagged(payload, domains.readyHash[expectedRole]);
  const signature = signer.signValidatorReadinessReadyInput({ ...payload, readyHash });
  if (typeof signature !== "string" || !verifyObject({ ...payload, readyHash }, signature,
    identity.publicKey, domains.readySignature[expectedRole])) {
    throw new Error(`validator readiness ${expectedRole} ready signer capability failed`);
  }
  return { ...payload, readyHash, signature };
}

export function verifyValidatorReadinessSignerReady(value, { bootstrap, expectedRole,
  expectedLauncherNonce, expectedPid, expectedReleaseProvenanceHash, expectedSessionHash,
  now = Date.now(),
} = {}) {
  role(expectedRole);
  exact(value, ["address", "bootstrapHash", "format", "launcherNonce", "pid", "processNonce",
    "readyHash", "releaseProvenanceHash", "role", "rolePackageHash", "sessionHash", "signature",
    "vaultHash", "version"], `validator readiness ${expectedRole} process ready`);
  const { readyHash, signature, ...unsigned } = value;
  const payload = readyPayload(unsigned, bootstrap, expectedRole, now);
  const pinned = verifySignerBootstrapEnvelope(bootstrap, expectedRole, now);
  verifyLocalLaunchBinding(pinned, { expectedLauncherNonce,
    expectedReleaseProvenanceHash, expectedSessionHash },
  `validator readiness ${expectedRole} process ready`);
  if (!Number.isSafeInteger(expectedPid) || expectedPid < 1 || expectedPid > 0x7fff_ffff ||
      payload.pid !== expectedPid) {
    throw new Error(`validator readiness ${expectedRole} process ready PID binding is invalid`);
  }
  const expectedHash = tagged(payload, domains.readyHash[expectedRole]);
  const identity = signerIdentity(pinned.rolePackage.session, expectedRole);
  if (readyHash !== expectedHash || !TAGGED_HASH.test(readyHash ?? "") ||
      !verifyObject({ ...payload, readyHash }, signature, identity.publicKey,
        domains.readySignature[expectedRole])) {
    throw new Error(`validator readiness ${expectedRole} process ready proof is invalid`);
  }
  return { ...payload, readyHash, signature };
}

export const VALIDATOR_READINESS_GATEWAY_PROCESS_DEFAULT_LIMITS = DEFAULT_LIMITS;

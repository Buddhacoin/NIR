import { randomBytes } from "node:crypto";

import { createCanonicalIpcFrameDecoder, encodeCanonicalIpcFrame }
  from "./canonical-ipc-framing.mjs";
import { canonicalJson, hashObject } from "./crypto.mjs";
import {
  verifyValidatorReadinessGatewayProcessBootstrap,
  verifyValidatorReadinessSignerProcessBootstrap,
} from "./validator-readiness-process-protocol.mjs";

const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const ROLES = new Set(["consensus", "gateway", "transport"]);
const SIGNER_ROLES = new Set(["consensus", "transport"]);
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const FORMATS = Object.freeze({
  activation: Object.freeze({
    consensus: "nir-validator-readiness-consensus-launch-activation-v1",
    gateway: "nir-validator-readiness-gateway-launch-activation-v1",
    transport: "nir-validator-readiness-transport-launch-activation-v1",
  }),
  anchor: Object.freeze({
    consensus: "nir-validator-readiness-consensus-launch-anchor-v1",
    gateway: "nir-validator-readiness-gateway-launch-anchor-v1",
    transport: "nir-validator-readiness-transport-launch-anchor-v1",
  }),
  fatal: Object.freeze({
    consensus: "nir-validator-readiness-consensus-fatal-status-v1",
    gateway: "nir-validator-readiness-gateway-fatal-status-v1",
    transport: "nir-validator-readiness-transport-fatal-status-v1",
  }),
  heightAck: Object.freeze({
    consensus: "nir-validator-readiness-consensus-height-ack-v1",
    transport: "nir-validator-readiness-transport-height-ack-v1",
  }),
  launch: Object.freeze({
    consensus: "nir-validator-readiness-consensus-runtime-launch-v1",
    gateway: "nir-validator-readiness-gateway-runtime-launch-v1",
    transport: "nir-validator-readiness-transport-runtime-launch-v1",
  }),
  ready: "nir-validator-readiness-gateway-runtime-ready-v1",
});
// Conventional name: protocol-conformance enumerates these fixed domains.
const domains = {
  activation: {
    consensus: "VR_CONS_RUNTIME_ACTIVATION_V1",
    gateway: "VR_GATE_RUNTIME_ACTIVATION_V1",
    transport: "VR_TRANS_RUNTIME_ACTIVATION_V1",
  },
  fatal: {
    consensus: "VR_CONS_RUNTIME_FATAL_V1",
    gateway: "VR_GATE_RUNTIME_FATAL_V1",
    transport: "VR_TRANS_RUNTIME_FATAL_V1",
  },
  heightAck: {
    consensus: "VR_CONS_RUNTIME_HEIGHT_ACK_V1",
    transport: "VR_TRANS_RUNTIME_HEIGHT_ACK_V1",
  },
  launch: {
    consensus: "VR_CONS_RUNTIME_LAUNCH_V1",
    gateway: "VR_GATE_RUNTIME_LAUNCH_V1",
    transport: "VR_TRANS_RUNTIME_LAUNCH_V1",
  },
  ready: "VR_GATE_RUNTIME_READY_V1",
};
const FATAL_CODES = new Set([
  "bootstrap-invalid", "channel-failed", "height-invalid", "internal-failure",
  "listener-failed", "password-invalid", "session-expired", "shutdown", "signer-unavailable", "tls-invalid",
  "vault-invalid",
]);
const BOOTSTRAP_FIELDS = Object.freeze({
  consensus: Object.freeze(["bootstrapHash", "format", "initialHeight", "launcherNonce",
    "releaseProvenanceHash", "role", "rolePackage", "rolePackageHash", "sessionHash",
    "vaultCommitment", "version"]),
  gateway: Object.freeze(["bootstrapHash", "consensusSignerBootstrapHash", "format",
    "initialHeight", "launcherNonce", "limits", "releaseProvenanceHash", "role", "rolePackage",
    "rolePackageHash", "sessionHash", "tlsCertificateSha256", "transportSignerBootstrapHash",
    "version"]),
  transport: Object.freeze(["bootstrapHash", "format", "initialHeight", "launcherNonce",
    "releaseProvenanceHash", "role", "rolePackage", "rolePackageHash", "sessionHash",
    "vaultCommitment", "version"]),
});

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}
function clone(value) { return JSON.parse(canonicalJson(value)); }
function tagged(value, domain) { return `sha3-256:${hashObject(value, domain)}`; }
function role(value, signer = false) {
  if (!(signer ? SIGNER_ROLES : ROLES).has(value)) {
    throw new Error("validator readiness runtime role is invalid");
  }
  return value;
}
function nonce(value, label) {
  if (!HASH.test(value ?? "")) throw new Error(`${label} is invalid`);
  return value;
}
function hash(value, label) {
  if (!TAGGED_HASH.test(value ?? "")) throw new Error(`${label} is invalid`);
  return value;
}
function pid(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fff_ffff) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
function port(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("validator readiness gateway runtime port is invalid");
  }
  return value;
}
function host(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 ||
      /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error("validator readiness gateway runtime host is invalid");
  }
  return value;
}
function processNonce(value, label) { return nonce(value, label); }

function expectedPins(value = {}, expectedRole) {
  exact(value, ["expectedBootstrapHash", "expectedLauncherNonce",
    "expectedReleaseProvenanceHash", "expectedRole", "expectedSessionHash"],
  "validator readiness runtime expected launch pins");
  role(expectedRole);
  if (value.expectedRole !== expectedRole) {
    throw new Error("validator readiness runtime expected role pin is invalid");
  }
  return { bootstrapHash: hash(value.expectedBootstrapHash,
    "validator readiness runtime expected bootstrap hash"),
  launcherNonce: nonce(value.expectedLauncherNonce,
    "validator readiness runtime expected launcher nonce"),
  releaseProvenanceHash: hash(value.expectedReleaseProvenanceHash,
    "validator readiness runtime expected release provenance hash"),
  role: expectedRole, sessionHash: hash(value.expectedSessionHash,
    "validator readiness runtime expected session hash") };
}

function bootstrapCore(bootstrap, expectedRole) {
  if (!bootstrap || Object.getPrototypeOf(bootstrap) !== Object.prototype) {
    throw new Error("validator readiness runtime bootstrap is invalid");
  }
  const result = clone(bootstrap);
  role(expectedRole);
  exact(result, BOOTSTRAP_FIELDS[expectedRole],
    `validator readiness ${expectedRole} runtime bootstrap`);
  if (result.role !== expectedRole || !TAGGED_HASH.test(result.bootstrapHash ?? "") ||
      !HASH.test(result.launcherNonce ?? "") || !TAGGED_HASH.test(result.sessionHash ?? "") ||
      !TAGGED_HASH.test(result.releaseProvenanceHash ?? "")) {
    throw new Error(`validator readiness ${expectedRole} runtime bootstrap binding is invalid`);
  }
  return result;
}

function verifiedProcessBootstrap(bootstrap, expectedRole, pins, {
  consensusSignerBootstrap, encryptedVault, now = Date.now(), transportSignerBootstrap,
} = {}) {
  const common = { expectedLauncherNonce: pins.launcherNonce,
    expectedReleaseProvenanceHash: pins.releaseProvenanceHash,
    expectedSessionHash: pins.sessionHash, now };
  return expectedRole === "gateway"
    ? verifyValidatorReadinessGatewayProcessBootstrap(bootstrap, {
      ...common, consensusSignerBootstrap, transportSignerBootstrap,
    })
    : verifyValidatorReadinessSignerProcessBootstrap(bootstrap, {
      ...common, encryptedVault, expectedRole,
    });
}

function launchAnchor(value, expectedRole, pins) {
  exact(value, ["bootstrapHash", "format", "launcherNonce", "releaseProvenanceHash", "role",
    "sessionHash", "version"], `validator readiness ${expectedRole} launch anchor`);
  if (value.format !== FORMATS.anchor[expectedRole] || value.version !== 1 ||
      value.role !== expectedRole || value.bootstrapHash !== pins.bootstrapHash ||
      value.launcherNonce !== pins.launcherNonce || value.sessionHash !== pins.sessionHash ||
      value.releaseProvenanceHash !== pins.releaseProvenanceHash) {
    throw new Error(`validator readiness ${expectedRole} launch anchor binding is invalid`);
  }
  return clone(value);
}

function launchPayload(value, expectedRole, pins, runtimeOptions) {
  const gateway = expectedRole === "gateway";
  const fields = ["anchor", "bootstrap", "format", "messageType", "role", "version"];
  if (gateway) fields.push("consensusSignerBootstrap", "transportSignerBootstrap");
  exact(value, fields, `validator readiness ${expectedRole} runtime launch payload`);
  const bootstrap = bootstrapCore(verifiedProcessBootstrap(value.bootstrap, expectedRole, pins, {
    ...runtimeOptions, consensusSignerBootstrap: value.consensusSignerBootstrap,
    transportSignerBootstrap: value.transportSignerBootstrap,
  }), expectedRole);
  const anchor = launchAnchor(value.anchor, expectedRole, pins);
  if (value.format !== FORMATS.launch[expectedRole] || value.messageType !== "launch" ||
      value.role !== expectedRole || value.version !== 1 ||
      bootstrap.bootstrapHash !== anchor.bootstrapHash ||
      bootstrap.launcherNonce !== anchor.launcherNonce ||
      bootstrap.sessionHash !== anchor.sessionHash ||
      bootstrap.releaseProvenanceHash !== anchor.releaseProvenanceHash) {
    throw new Error(`validator readiness ${expectedRole} runtime launch binding is invalid`);
  }
  const result = { anchor, bootstrap, format: value.format, messageType: "launch",
    role: expectedRole, version: 1 };
  if (gateway) {
    const consensus = bootstrapCore(value.consensusSignerBootstrap, "consensus");
    const transport = bootstrapCore(value.transportSignerBootstrap, "transport");
    if (bootstrap.consensusSignerBootstrapHash !== consensus.bootstrapHash ||
        bootstrap.transportSignerBootstrapHash !== transport.bootstrapHash ||
        [consensus, transport].some((item) => item.launcherNonce !== pins.launcherNonce ||
          item.sessionHash !== pins.sessionHash ||
          item.releaseProvenanceHash !== pins.releaseProvenanceHash)) {
      throw new Error("validator readiness gateway runtime signer bootstrap binding is invalid");
    }
    result.consensusSignerBootstrap = consensus;
    result.transportSignerBootstrap = transport;
  }
  return result;
}

export function createValidatorReadinessRuntimeLaunchEnvelope({ bootstrap,
  consensusSignerBootstrap, transportSignerBootstrap } = {}, pins = {}, runtimeOptions = {}) {
  const expectedRole = role(pins.expectedRole);
  const verifiedPins = expectedPins(pins, expectedRole);
  const anchor = { bootstrapHash: verifiedPins.bootstrapHash,
    format: FORMATS.anchor[expectedRole], launcherNonce: verifiedPins.launcherNonce,
    releaseProvenanceHash: verifiedPins.releaseProvenanceHash, role: expectedRole,
    sessionHash: verifiedPins.sessionHash, version: 1 };
  const input = { anchor, bootstrap, format: FORMATS.launch[expectedRole], messageType: "launch",
    role: expectedRole, version: 1 };
  if (expectedRole === "gateway") Object.assign(input,
    { consensusSignerBootstrap, transportSignerBootstrap });
  const payload = launchPayload(input, expectedRole, verifiedPins, runtimeOptions);
  return { ...payload, envelopeHash: tagged(payload, domains.launch[expectedRole]) };
}

export function verifyValidatorReadinessRuntimeLaunchEnvelope(value, pins = {}, runtimeOptions = {}) {
  const expectedRole = role(pins.expectedRole);
  exact(value, expectedRole === "gateway"
    ? ["anchor", "bootstrap", "consensusSignerBootstrap", "envelopeHash", "format",
      "messageType", "role", "transportSignerBootstrap", "version"]
    : ["anchor", "bootstrap", "envelopeHash", "format", "messageType", "role", "version"],
  `validator readiness ${expectedRole} runtime launch`);
  const { envelopeHash, ...unsigned } = value;
  const payload = launchPayload(unsigned, expectedRole, expectedPins(pins, expectedRole),
    runtimeOptions);
  if (!TAGGED_HASH.test(envelopeHash ?? "") ||
      envelopeHash !== tagged(payload, domains.launch[expectedRole])) {
    throw new Error(`validator readiness ${expectedRole} runtime launch hash is invalid`);
  }
  return { ...payload, envelopeHash };
}

function gatewayReadyPayload(value, pins, expectedPid, expectedBoundHost, expectedBoundPort) {
  exact(value, ["bootstrapHash", "boundHost", "boundPort", "format", "launcherNonce",
    "messageType", "pid", "processNonce", "releaseProvenanceHash", "role", "sessionHash",
    "tlsCertificateSha256", "version"], "validator readiness gateway runtime ready payload");
  const certificate = value.tlsCertificateSha256;
  if (value.format !== FORMATS.ready || value.messageType !== "ready" || value.version !== 1 ||
      value.role !== "gateway" || value.bootstrapHash !== pins.bootstrapHash ||
      value.launcherNonce !== pins.launcherNonce || value.sessionHash !== pins.sessionHash ||
      value.releaseProvenanceHash !== pins.releaseProvenanceHash || value.pid !== expectedPid ||
      value.boundHost !== expectedBoundHost || value.boundPort !== expectedBoundPort ||
      !HASH.test(certificate ?? "")) {
    throw new Error("validator readiness gateway runtime ready binding is invalid");
  }
  pid(value.pid, "validator readiness gateway runtime ready PID");
  host(value.boundHost); port(value.boundPort);
  processNonce(value.processNonce, "validator readiness gateway runtime process nonce");
  return clone(value);
}

export function createValidatorReadinessGatewayRuntimeReady({ boundHost, boundPort,
  bootstrap, pid: processId, processNonce: suppliedNonce = randomBytes(32).toString("hex") } = {},
  pins = {}) {
  const verifiedPins = expectedPins(pins, "gateway");
  const pinned = bootstrapCore(bootstrap, "gateway");
  if (pinned.bootstrapHash !== verifiedPins.bootstrapHash ||
      pinned.launcherNonce !== verifiedPins.launcherNonce ||
      pinned.sessionHash !== verifiedPins.sessionHash ||
      pinned.releaseProvenanceHash !== verifiedPins.releaseProvenanceHash) {
    throw new Error("validator readiness gateway runtime ready bootstrap is invalid");
  }
  const payload = gatewayReadyPayload({ bootstrapHash: pinned.bootstrapHash, boundHost, boundPort,
    format: FORMATS.ready, launcherNonce: pinned.launcherNonce, messageType: "ready", pid: processId,
    processNonce: suppliedNonce, releaseProvenanceHash: pinned.releaseProvenanceHash,
    role: "gateway", sessionHash: pinned.sessionHash,
    tlsCertificateSha256: pinned.tlsCertificateSha256, version: 1 }, verifiedPins, processId,
  boundHost, boundPort);
  return { ...payload, readyHash: tagged(payload, domains.ready) };
}

export function verifyValidatorReadinessGatewayRuntimeReady(value, { expectedBoundHost,
  expectedBoundPort, expectedPid, expectedTlsCertificateSha256, ...pins } = {}) {
  exact(value, ["bootstrapHash", "boundHost", "boundPort", "format", "launcherNonce",
    "messageType", "pid", "processNonce", "readyHash", "releaseProvenanceHash", "role",
    "sessionHash", "tlsCertificateSha256", "version"],
  "validator readiness gateway runtime ready");
  const { readyHash, ...unsigned } = value;
  const payload = gatewayReadyPayload(unsigned, expectedPins(pins, "gateway"),
    pid(expectedPid, "validator readiness gateway expected PID"), host(expectedBoundHost),
    port(expectedBoundPort));
  if (!HASH.test(expectedTlsCertificateSha256 ?? "") ||
      payload.tlsCertificateSha256 !== expectedTlsCertificateSha256) {
    throw new Error("validator readiness gateway runtime ready certificate pin is invalid");
  }
  if (!TAGGED_HASH.test(readyHash ?? "") || readyHash !== tagged(payload, domains.ready)) {
    throw new Error("validator readiness gateway runtime ready hash is invalid");
  }
  return { ...payload, readyHash };
}

function statusPins(value = {}, expectedRole) {
  exact(value, ["expectedBootstrapHash", "expectedLauncherNonce", "expectedPid",
    "expectedProcessNonce", "expectedReleaseProvenanceHash", "expectedRole",
    "expectedSessionHash"], "validator readiness runtime expected status pins");
  const common = expectedPins({ expectedBootstrapHash: value.expectedBootstrapHash,
    expectedLauncherNonce: value.expectedLauncherNonce,
    expectedReleaseProvenanceHash: value.expectedReleaseProvenanceHash,
    expectedRole: value.expectedRole, expectedSessionHash: value.expectedSessionHash }, expectedRole);
  return { ...common, pid: pid(value.expectedPid, "validator readiness runtime expected PID"),
    processNonce: processNonce(value.expectedProcessNonce,
      "validator readiness runtime expected process nonce") };
}

function readinessEntry(value, expectedRole, pins) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || value.role !== expectedRole ||
      !TAGGED_HASH.test(value.bootstrapHash ?? "") || value.launcherNonce !== pins.launcherNonce ||
      value.sessionHash !== pins.sessionHash ||
      value.releaseProvenanceHash !== pins.releaseProvenanceHash ||
      !TAGGED_HASH.test(value.readyHash ?? "")) {
    throw new Error(`validator readiness ${expectedRole} activation readiness is invalid`);
  }
  return { bootstrapHash: value.bootstrapHash,
    pid: pid(value.pid, `validator readiness ${expectedRole} activation PID`),
    processNonce: processNonce(value.processNonce,
      `validator readiness ${expectedRole} activation process nonce`),
    readyHash: value.readyHash };
}

function activationCohort(readiness, pins) {
  exact(readiness, ["consensus", "gateway", "transport"],
    "validator readiness activation cohort input");
  return { consensus: readinessEntry(readiness.consensus, "consensus", pins),
    gateway: readinessEntry(readiness.gateway, "gateway", pins),
    transport: readinessEntry(readiness.transport, "transport", pins) };
}

function activationPayload(value, pins, expectedReadiness) {
  const expectedRole = role(pins.role);
  exact(value, ["bootstrapHash", "cohort", "format", "launcherNonce", "messageType", "pid",
    "processNonce", "releaseProvenanceHash", "role", "sessionHash", "version"],
  `validator readiness ${expectedRole} launch activation payload`);
  exact(value.cohort, ["consensus", "gateway", "transport"],
    "validator readiness launch activation cohort");
  for (const memberRole of ROLES) exact(value.cohort[memberRole],
    ["bootstrapHash", "pid", "processNonce", "readyHash"],
    `validator readiness ${memberRole} launch activation member`);
  const cohort = activationCohort(expectedReadiness, pins);
  const target = cohort[expectedRole];
  if (value.format !== FORMATS.activation[expectedRole] || value.messageType !== "activate" ||
      value.version !== 1 || value.role !== expectedRole ||
      value.bootstrapHash !== pins.bootstrapHash || value.pid !== pins.pid ||
      value.processNonce !== pins.processNonce || value.launcherNonce !== pins.launcherNonce ||
      value.sessionHash !== pins.sessionHash ||
      value.releaseProvenanceHash !== pins.releaseProvenanceHash ||
      target.bootstrapHash !== pins.bootstrapHash || target.pid !== pins.pid ||
      target.processNonce !== pins.processNonce || !same(value.cohort, cohort)) {
    throw new Error(`validator readiness ${expectedRole} launch activation binding is invalid`);
  }
  return clone(value);
}

function same(left, right) { return canonicalJson(left) === canonicalJson(right); }

export function createValidatorReadinessLaunchActivation({ readiness } = {}, pins = {}) {
  const expectedRole = role(pins.expectedRole);
  const verifiedPins = statusPins(pins, expectedRole);
  const cohort = activationCohort(readiness, verifiedPins);
  const payload = activationPayload({ bootstrapHash: verifiedPins.bootstrapHash, cohort,
    format: FORMATS.activation[expectedRole], launcherNonce: verifiedPins.launcherNonce,
    messageType: "activate", pid: verifiedPins.pid, processNonce: verifiedPins.processNonce,
    releaseProvenanceHash: verifiedPins.releaseProvenanceHash, role: expectedRole,
    sessionHash: verifiedPins.sessionHash, version: 1 }, verifiedPins, readiness);
  return { ...payload, activationHash: tagged(payload, domains.activation[expectedRole]) };
}

export function verifyValidatorReadinessLaunchActivation(value,
  { expectedReadiness, ...pins } = {}) {
  const expectedRole = role(pins.expectedRole);
  exact(value, ["activationHash", "bootstrapHash", "cohort", "format", "launcherNonce",
    "messageType", "pid", "processNonce", "releaseProvenanceHash", "role", "sessionHash",
    "version"], `validator readiness ${expectedRole} launch activation`);
  const { activationHash, ...unsigned } = value;
  const payload = activationPayload(unsigned, statusPins(pins, expectedRole), expectedReadiness);
  if (!TAGGED_HASH.test(activationHash ?? "") ||
      activationHash !== tagged(payload, domains.activation[expectedRole])) {
    throw new Error(`validator readiness ${expectedRole} launch activation hash is invalid`);
  }
  return { ...payload, activationHash };
}

function heightAckPayload(value, pins, update) {
  const expectedRole = role(pins.role, true);
  exact(value, ["bootstrapHash", "format", "height", "launcherNonce", "messageType", "pid",
    "processNonce", "releaseProvenanceHash", "role", "sequence", "sessionHash", "updateHash",
    "version"], `validator readiness ${expectedRole} height acknowledgement payload`);
  if (!update || Object.getPrototypeOf(update) !== Object.prototype ||
      value.format !== FORMATS.heightAck[expectedRole] || value.messageType !== "height-ack" ||
      value.version !== 1 || value.role !== expectedRole || value.bootstrapHash !== pins.bootstrapHash ||
      value.launcherNonce !== pins.launcherNonce || value.sessionHash !== pins.sessionHash ||
      value.releaseProvenanceHash !== pins.releaseProvenanceHash || value.pid !== pins.pid ||
      value.processNonce !== pins.processNonce || value.updateHash !== update.updateHash ||
      value.sequence !== update.sequence || value.height !== update.height ||
      update.role !== expectedRole || update.bootstrapHash !== pins.bootstrapHash ||
      update.launcherNonce !== pins.launcherNonce || update.sessionHash !== pins.sessionHash ||
      update.releaseProvenanceHash !== pins.releaseProvenanceHash ||
      !TAGGED_HASH.test(value.updateHash ?? "") || !Number.isSafeInteger(value.sequence) ||
      value.sequence < 1 || !Number.isSafeInteger(value.height) || value.height < 0) {
    throw new Error(`validator readiness ${expectedRole} height acknowledgement binding is invalid`);
  }
  return clone(value);
}

export function createValidatorReadinessHeightAcknowledgement({ heightUpdate } = {}, pins = {}) {
  const expectedRole = role(pins.expectedRole, true);
  const verifiedPins = statusPins(pins, expectedRole);
  const payload = heightAckPayload({ bootstrapHash: verifiedPins.bootstrapHash,
    format: FORMATS.heightAck[expectedRole], height: heightUpdate?.height,
    launcherNonce: verifiedPins.launcherNonce, messageType: "height-ack", pid: verifiedPins.pid,
    processNonce: verifiedPins.processNonce,
    releaseProvenanceHash: verifiedPins.releaseProvenanceHash, role: expectedRole,
    sequence: heightUpdate?.sequence, sessionHash: verifiedPins.sessionHash,
    updateHash: heightUpdate?.updateHash, version: 1 }, verifiedPins, heightUpdate);
  return { ...payload, acknowledgementHash: tagged(payload, domains.heightAck[expectedRole]) };
}

export function verifyValidatorReadinessHeightAcknowledgement(value,
  { expectedHeightUpdate, ...pins } = {}) {
  const expectedRole = role(pins.expectedRole, true);
  exact(value, ["acknowledgementHash", "bootstrapHash", "format", "height", "launcherNonce",
    "messageType", "pid", "processNonce", "releaseProvenanceHash", "role", "sequence",
    "sessionHash", "updateHash", "version"],
  `validator readiness ${expectedRole} height acknowledgement`);
  const { acknowledgementHash, ...unsigned } = value;
  const payload = heightAckPayload(unsigned, statusPins(pins, expectedRole), expectedHeightUpdate);
  if (!TAGGED_HASH.test(acknowledgementHash ?? "") ||
      acknowledgementHash !== tagged(payload, domains.heightAck[expectedRole])) {
    throw new Error(`validator readiness ${expectedRole} height acknowledgement hash is invalid`);
  }
  return { ...payload, acknowledgementHash };
}

function fatalPayload(value, pins, expectedCode = undefined) {
  const expectedRole = role(pins.role);
  exact(value, ["bootstrapHash", "code", "format", "launcherNonce", "messageType", "pid",
    "processNonce", "releaseProvenanceHash", "role", "sessionHash", "version"],
  `validator readiness ${expectedRole} fatal status payload`);
  if (!FATAL_CODES.has(value.code) ||
      (expectedCode !== undefined && value.code !== expectedCode) ||
      value.format !== FORMATS.fatal[expectedRole] || value.messageType !== "fatal" ||
      value.version !== 1 || value.role !== expectedRole || value.bootstrapHash !== pins.bootstrapHash ||
      value.launcherNonce !== pins.launcherNonce || value.sessionHash !== pins.sessionHash ||
      value.releaseProvenanceHash !== pins.releaseProvenanceHash || value.pid !== pins.pid ||
      value.processNonce !== pins.processNonce) {
    throw new Error(`validator readiness ${expectedRole} fatal status binding is invalid`);
  }
  return clone(value);
}

export function createValidatorReadinessFatalStatus({ code } = {}, pins = {}) {
  const expectedRole = role(pins.expectedRole);
  const verifiedPins = statusPins(pins, expectedRole);
  const payload = fatalPayload({ bootstrapHash: verifiedPins.bootstrapHash, code,
    format: FORMATS.fatal[expectedRole], launcherNonce: verifiedPins.launcherNonce,
    messageType: "fatal", pid: verifiedPins.pid, processNonce: verifiedPins.processNonce,
    releaseProvenanceHash: verifiedPins.releaseProvenanceHash, role: expectedRole,
    sessionHash: verifiedPins.sessionHash, version: 1 }, verifiedPins);
  return { ...payload, statusHash: tagged(payload, domains.fatal[expectedRole]) };
}

export function verifyValidatorReadinessFatalStatus(value, { expectedCode, ...pins } = {}) {
  const expectedRole = role(pins.expectedRole);
  exact(value, ["bootstrapHash", "code", "format", "launcherNonce", "messageType", "pid",
    "processNonce", "releaseProvenanceHash", "role", "sessionHash", "statusHash", "version"],
  `validator readiness ${expectedRole} fatal status`);
  const { statusHash, ...unsigned } = value;
  const payload = fatalPayload(unsigned, statusPins(pins, expectedRole), expectedCode);
  if (!TAGGED_HASH.test(statusHash ?? "") ||
      statusHash !== tagged(payload, domains.fatal[expectedRole])) {
    throw new Error(`validator readiness ${expectedRole} fatal status hash is invalid`);
  }
  return { ...payload, statusHash };
}

export function encodeValidatorReadinessRuntimeFrame(value) {
  return encodeCanonicalIpcFrame(value,
    { label: "validator readiness runtime frame", maximumBytes: MAX_FRAME_BYTES });
}
export function createValidatorReadinessRuntimeFrameDecoder() {
  return createCanonicalIpcFrameDecoder(
    { label: "validator readiness runtime frame", maximumBytes: MAX_FRAME_BYTES });
}
export const VALIDATOR_READINESS_RUNTIME_FATAL_CODES = Object.freeze([...FATAL_CODES].sort());
export const VALIDATOR_READINESS_RUNTIME_MAX_FRAME_BYTES = MAX_FRAME_BYTES;

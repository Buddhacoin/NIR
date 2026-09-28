import { createCanonicalIpcFrameDecoder, encodeCanonicalIpcFrame }
  from "./canonical-ipc-framing.mjs";
import { canonicalJson, hashObject } from "./crypto.mjs";
import {
  verifyValidatorReadinessGatewayProcessBootstrap,
  verifyValidatorReadinessSignerReady,
} from "./validator-readiness-process-protocol.mjs";
import {
  verifyValidatorReadinessGatewayRuntimeReady,
  verifyValidatorReadinessLaunchActivation,
  verifyValidatorReadinessRuntimeLaunchEnvelope,
} from "./validator-readiness-runtime-protocol.mjs";
import { encryptedVaultPublicCommitment } from "./vault.mjs";

const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const SIGNER_ROLES = new Set(["consensus", "transport"]);
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const FORMATS = Object.freeze({
  acknowledgement: Object.freeze({
    consensus: "nir-validator-readiness-consensus-activation-ack-v1",
    transport: "nir-validator-readiness-transport-activation-ack-v1",
  }),
  activationCommand: Object.freeze({
    consensus: "nir-validator-readiness-consensus-activation-command-v1",
    transport: "nir-validator-readiness-transport-activation-command-v1",
  }),
  input: Object.freeze({
    consensus: "nir-validator-readiness-consensus-signer-child-input-v1",
    transport: "nir-validator-readiness-transport-signer-child-input-v1",
  }),
});
// Conventional name lets the conformance inventory enumerate role-separated domains.
const domains = {
  acknowledgement: {
    consensus: "VR_CONS_SIGNER_CHILD_ACTIVATION_ACK_V1",
    transport: "VR_TRANS_SIGNER_CHILD_ACTIVATION_ACK_V1",
  },
  activationCommand: {
    consensus: "VR_CONS_SIGNER_CHILD_ACTIVATE_CMD_V1",
    transport: "VR_TRANS_SIGNER_CHILD_ACTIVATE_CMD_V1",
  },
  input: {
    consensus: "VR_CONS_SIGNER_CHILD_INPUT_V1",
    transport: "VR_TRANS_SIGNER_CHILD_INPUT_V1",
  },
};

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}
function clone(value) { return JSON.parse(canonicalJson(value)); }
function same(left, right) { return canonicalJson(left) === canonicalJson(right); }
function tagged(value, domain) { return `sha3-256:${hashObject(value, domain)}`; }
function role(value) {
  if (!SIGNER_ROLES.has(value)) throw new Error("validator readiness signer child role is invalid");
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

function inputPins(value, expectedRole) {
  role(expectedRole);
  if (value.role !== expectedRole) throw new Error("validator readiness signer child role pin is invalid");
  return { expectedBootstrapHash: hash(value.expectedBootstrapHash,
    "validator readiness signer child expected bootstrap hash"),
  expectedLauncherNonce: nonce(value.expectedLauncherNonce,
    "validator readiness signer child expected launcher nonce"),
  expectedReleaseProvenanceHash: hash(value.expectedReleaseProvenanceHash,
    "validator readiness signer child expected release provenance hash"),
  expectedRole, expectedSessionHash: hash(value.expectedSessionHash,
    "validator readiness signer child expected session hash") };
}

function cohortBootstraps(value) {
  exact(value, ["consensus", "gateway", "transport"],
    "validator readiness signer child cohort bootstraps");
  for (const memberRole of ["consensus", "gateway", "transport"]) {
    if (!value[memberRole] || Object.getPrototypeOf(value[memberRole]) !== Object.prototype ||
        value[memberRole].role !== memberRole ||
        !TAGGED_HASH.test(value[memberRole].bootstrapHash ?? "")) {
      throw new Error(`validator readiness ${memberRole} cohort bootstrap is invalid`);
    }
  }
  return clone(value);
}

function signerInputPayload(value, expectedRole, now) {
  exact(value, ["cohortBootstraps", "encryptedVault", "expectedBootstrapHash", "expectedLauncherNonce",
    "expectedReleaseProvenanceHash", "expectedSessionHash", "format", "launchEnvelope",
    "messageType", "role", "version"], `validator readiness ${expectedRole} signer child input payload`);
  const pins = inputPins(value, expectedRole);
  const cohort = cohortBootstraps(value.cohortBootstraps);
  const launchEnvelope = verifyValidatorReadinessRuntimeLaunchEnvelope(value.launchEnvelope, pins,
    { encryptedVault: value.encryptedVault, now });
  if (value.format !== FORMATS.input[expectedRole] || value.messageType !== "signer-bootstrap" ||
      value.version !== 1 || !same(launchEnvelope.bootstrap, cohort[expectedRole])) {
    throw new Error(`validator readiness ${expectedRole} signer child input binding is invalid`);
  }
  verifyValidatorReadinessGatewayProcessBootstrap(cohort.gateway, {
    consensusSignerBootstrap: cohort.consensus,
    expectedLauncherNonce: pins.expectedLauncherNonce,
    expectedReleaseProvenanceHash: pins.expectedReleaseProvenanceHash,
    expectedSessionHash: pins.expectedSessionHash, now,
    transportSignerBootstrap: cohort.transport,
  });
  // This also enforces the full encrypted-vault schema and makes the public commitment explicit.
  const vaultCommitment = encryptedVaultPublicCommitment(value.encryptedVault);
  if (!same(vaultCommitment, launchEnvelope.bootstrap.vaultCommitment)) {
    throw new Error(`validator readiness ${expectedRole} signer child vault binding is invalid`);
  }
  return { cohortBootstraps: cohort, encryptedVault: clone(value.encryptedVault),
    expectedBootstrapHash: pins.expectedBootstrapHash,
    expectedLauncherNonce: pins.expectedLauncherNonce,
    expectedReleaseProvenanceHash: pins.expectedReleaseProvenanceHash,
    expectedSessionHash: pins.expectedSessionHash, format: value.format, launchEnvelope,
    messageType: "signer-bootstrap", role: expectedRole, version: 1 };
}

export function createValidatorReadinessSignerChildInput({ cohortBootstraps: cohort,
  encryptedVault, launchEnvelope } = {}, pins = {}, { now = Date.now() } = {}) {
  const expectedRole = role(pins.expectedRole);
  exact(pins, ["expectedBootstrapHash", "expectedLauncherNonce",
    "expectedReleaseProvenanceHash", "expectedRole", "expectedSessionHash"],
  "validator readiness signer child input pins");
  const payload = signerInputPayload({ cohortBootstraps: cohort, encryptedVault,
    expectedBootstrapHash: pins.expectedBootstrapHash,
    expectedLauncherNonce: pins.expectedLauncherNonce,
    expectedReleaseProvenanceHash: pins.expectedReleaseProvenanceHash,
    expectedSessionHash: pins.expectedSessionHash, format: FORMATS.input[expectedRole],
    launchEnvelope, messageType: "signer-bootstrap", role: expectedRole, version: 1 },
  expectedRole, now);
  return { ...payload, inputHash: tagged(payload, domains.input[expectedRole]) };
}

export function verifyValidatorReadinessSignerChildInput(value,
  { expectedRole, now = Date.now() } = {}) {
  expectedRole = role(expectedRole);
  exact(value, ["cohortBootstraps", "encryptedVault", "expectedBootstrapHash",
    "expectedLauncherNonce", "expectedReleaseProvenanceHash", "expectedSessionHash", "format",
    "inputHash", "launchEnvelope", "messageType", "role", "version"],
  `validator readiness ${expectedRole} signer child input`);
  const { inputHash, ...unsigned } = value;
  const payload = signerInputPayload(unsigned, expectedRole, now);
  if (!TAGGED_HASH.test(inputHash ?? "") ||
      inputHash !== tagged(payload, domains.input[expectedRole])) {
    throw new Error(`validator readiness ${expectedRole} signer child input hash is invalid`);
  }
  return { ...payload, inputHash };
}

function endpointFromInput(input) {
  const endpoint = input.launchEnvelope.bootstrap.rolePackage.session.context.endpoint;
  let parsed;
  try { parsed = new URL(endpoint); } catch {
    throw new Error("validator readiness signer child gateway endpoint is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
      parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("validator readiness signer child gateway endpoint is invalid");
  }
  const port = parsed.port === "" ? 443 : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("validator readiness signer child gateway endpoint port is invalid");
  }
  return { host: parsed.hostname, port };
}

function normalizeReadiness(readiness, input, now) {
  exact(readiness, ["consensus", "gateway", "transport"],
    "validator readiness signer child readiness set");
  const cohort = input.cohortBootstraps;
  const common = { expectedLauncherNonce: input.expectedLauncherNonce,
    expectedReleaseProvenanceHash: input.expectedReleaseProvenanceHash,
    expectedSessionHash: input.expectedSessionHash, now };
  const consensus = verifyValidatorReadinessSignerReady(readiness.consensus, {
    ...common, bootstrap: cohort.consensus, expectedPid: readiness.consensus?.pid,
    expectedRole: "consensus",
  });
  const transport = verifyValidatorReadinessSignerReady(readiness.transport, {
    ...common, bootstrap: cohort.transport, expectedPid: readiness.transport?.pid,
    expectedRole: "transport",
  });
  const endpoint = endpointFromInput(input);
  const gateway = verifyValidatorReadinessGatewayRuntimeReady(readiness.gateway, {
    expectedBootstrapHash: cohort.gateway.bootstrapHash, expectedBoundHost: endpoint.host,
    expectedBoundPort: endpoint.port, expectedLauncherNonce: input.expectedLauncherNonce,
    expectedPid: readiness.gateway?.pid,
    expectedReleaseProvenanceHash: input.expectedReleaseProvenanceHash,
    expectedRole: "gateway", expectedSessionHash: input.expectedSessionHash,
    expectedTlsCertificateSha256: cohort.gateway.tlsCertificateSha256,
  });
  return { consensus, gateway, transport };
}

function ownStatusPins(input, ownReady) {
  return { expectedBootstrapHash: input.expectedBootstrapHash,
    expectedLauncherNonce: input.expectedLauncherNonce,
    expectedPid: pid(ownReady?.pid, "validator readiness signer child expected PID"),
    expectedProcessNonce: nonce(ownReady?.processNonce,
      "validator readiness signer child expected process nonce"),
    expectedReleaseProvenanceHash: input.expectedReleaseProvenanceHash,
    expectedRole: input.role, expectedSessionHash: input.expectedSessionHash };
}

function activationCommandPayload(value, input, expectedOwnReady, now) {
  const expectedRole = input.role;
  exact(value, ["activation", "format", "messageType", "readiness", "role", "version"],
    `validator readiness ${expectedRole} signer child activation command payload`);
  const readiness = normalizeReadiness(value.readiness, input, now);
  if (!same(readiness[expectedRole], expectedOwnReady)) {
    throw new Error(`validator readiness ${expectedRole} signer child own readiness is invalid`);
  }
  const activation = verifyValidatorReadinessLaunchActivation(value.activation, {
    ...ownStatusPins(input, expectedOwnReady), expectedReadiness: readiness,
  });
  if (value.format !== FORMATS.activationCommand[expectedRole] ||
      value.messageType !== "activate-command" || value.role !== expectedRole || value.version !== 1) {
    throw new Error(`validator readiness ${expectedRole} signer child activation command binding is invalid`);
  }
  return { activation, format: value.format, messageType: "activate-command", readiness,
    role: expectedRole, version: 1 };
}

export function createValidatorReadinessSignerActivationCommand({ activation, readiness } = {},
  { expectedRole, signerInput, now = Date.now() } = {}) {
  expectedRole = role(expectedRole);
  const input = verifyValidatorReadinessSignerChildInput(signerInput,
    { expectedRole, now });
  const normalized = normalizeReadiness(readiness, input, now);
  const expectedOwnReady = normalized[input.role];
  const payload = activationCommandPayload({ activation,
    format: FORMATS.activationCommand[input.role], messageType: "activate-command",
    readiness: normalized, role: input.role, version: 1 }, input, expectedOwnReady, now);
  return { ...payload, commandHash: tagged(payload, domains.activationCommand[input.role]) };
}

export function verifyValidatorReadinessSignerActivationCommand(value, {
  expectedOwnReady, expectedRole, now = Date.now(), signerInput,
} = {}) {
  expectedRole = role(expectedRole);
  const input = verifyValidatorReadinessSignerChildInput(signerInput, { expectedRole, now });
  exact(value, ["activation", "commandHash", "format", "messageType", "readiness", "role",
    "version"], `validator readiness ${expectedRole} signer child activation command`);
  const { commandHash, ...unsigned } = value;
  const payload = activationCommandPayload(unsigned, input, expectedOwnReady, now);
  if (!TAGGED_HASH.test(commandHash ?? "") ||
      commandHash !== tagged(payload, domains.activationCommand[expectedRole])) {
    throw new Error(`validator readiness ${expectedRole} signer child activation command hash is invalid`);
  }
  return { ...payload, commandHash };
}

function acknowledgementPayload(value, activation, pins) {
  const expectedRole = role(pins.expectedRole);
  hash(pins.expectedBootstrapHash, "validator readiness activation expected bootstrap hash");
  nonce(pins.expectedLauncherNonce, "validator readiness activation expected launcher nonce");
  hash(pins.expectedReleaseProvenanceHash,
    "validator readiness activation expected release provenance hash");
  hash(pins.expectedSessionHash, "validator readiness activation expected session hash");
  pid(pins.expectedPid, "validator readiness activation expected PID");
  nonce(pins.expectedProcessNonce, "validator readiness activation expected process nonce");
  exact(value, ["activationHash", "bootstrapHash", "format", "launcherNonce", "messageType",
    "pid", "processNonce", "releaseProvenanceHash", "role", "sessionHash", "version"],
  `validator readiness ${expectedRole} activation acknowledgement payload`);
  if (!activation || Object.getPrototypeOf(activation) !== Object.prototype ||
      !TAGGED_HASH.test(activation.activationHash ?? "") ||
      value.activationHash !== activation.activationHash ||
      value.format !== FORMATS.acknowledgement[expectedRole] ||
      value.messageType !== "activation-ack" || value.role !== expectedRole || value.version !== 1 ||
      value.bootstrapHash !== pins.expectedBootstrapHash ||
      value.launcherNonce !== pins.expectedLauncherNonce ||
      value.releaseProvenanceHash !== pins.expectedReleaseProvenanceHash ||
      value.sessionHash !== pins.expectedSessionHash || value.pid !== pins.expectedPid ||
      value.processNonce !== pins.expectedProcessNonce || activation.role !== expectedRole ||
      activation.bootstrapHash !== pins.expectedBootstrapHash ||
      activation.launcherNonce !== pins.expectedLauncherNonce ||
      activation.releaseProvenanceHash !== pins.expectedReleaseProvenanceHash ||
      activation.sessionHash !== pins.expectedSessionHash || activation.pid !== pins.expectedPid ||
      activation.processNonce !== pins.expectedProcessNonce) {
    throw new Error(`validator readiness ${expectedRole} activation acknowledgement binding is invalid`);
  }
  return clone(value);
}

export function createValidatorReadinessSignerActivationAcknowledgement({ activation } = {},
  pins = {}) {
  const expectedRole = role(pins.expectedRole);
  const payload = acknowledgementPayload({ activationHash: activation?.activationHash,
    bootstrapHash: pins.expectedBootstrapHash, format: FORMATS.acknowledgement[expectedRole],
    launcherNonce: pins.expectedLauncherNonce, messageType: "activation-ack",
    pid: pins.expectedPid, processNonce: pins.expectedProcessNonce,
    releaseProvenanceHash: pins.expectedReleaseProvenanceHash, role: expectedRole,
    sessionHash: pins.expectedSessionHash, version: 1 }, activation, pins);
  return { ...payload,
    acknowledgementHash: tagged(payload, domains.acknowledgement[expectedRole]) };
}

export function verifyValidatorReadinessSignerActivationAcknowledgement(value, {
  expectedActivation, ...pins
} = {}) {
  const expectedRole = role(pins.expectedRole);
  exact(value, ["acknowledgementHash", "activationHash", "bootstrapHash", "format",
    "launcherNonce", "messageType", "pid", "processNonce", "releaseProvenanceHash", "role",
    "sessionHash", "version"],
  `validator readiness ${expectedRole} activation acknowledgement`);
  const { acknowledgementHash, ...unsigned } = value;
  const payload = acknowledgementPayload(unsigned, expectedActivation, pins);
  if (!TAGGED_HASH.test(acknowledgementHash ?? "") ||
      acknowledgementHash !== tagged(payload, domains.acknowledgement[expectedRole])) {
    throw new Error(`validator readiness ${expectedRole} activation acknowledgement hash is invalid`);
  }
  return { ...payload, acknowledgementHash };
}

export function encodeValidatorReadinessSignerChildFrame(value) {
  return encodeCanonicalIpcFrame(value,
    { label: "validator readiness signer child frame", maximumBytes: MAX_FRAME_BYTES });
}
export function createValidatorReadinessSignerChildFrameDecoder() {
  return createCanonicalIpcFrameDecoder(
    { label: "validator readiness signer child frame", maximumBytes: MAX_FRAME_BYTES });
}
export const VALIDATOR_READINESS_SIGNER_CHILD_MAX_FRAME_BYTES = MAX_FRAME_BYTES;

import { createCanonicalIpcFrameDecoder, encodeCanonicalIpcFrame }
  from "./canonical-ipc-framing.mjs";
import { canonicalJson, hashObject } from "./crypto.mjs";
import {
  verifyValidatorReadinessGatewayProcessBootstrap,
  verifyValidatorReadinessSignerReady,
} from "./validator-readiness-process-protocol.mjs";
import {
  createValidatorReadinessLaunchActivation,
  verifyValidatorReadinessGatewayRuntimeReady,
  verifyValidatorReadinessLaunchActivation,
  verifyValidatorReadinessRuntimeLaunchEnvelope,
} from "./validator-readiness-runtime-protocol.mjs";
import { verifyValidatorReadinessSignerActivationAcknowledgement }
  from "./validator-readiness-signer-child-protocol.mjs";

const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const ROLES = Object.freeze(["consensus", "gateway", "transport"]);
const SIGNER_ROLES = Object.freeze(["consensus", "transport"]);
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const FORMATS = Object.freeze({
  commitAck: "nir-validator-readiness-gateway-commit-ack-v1",
  commitCommand: "nir-validator-readiness-gateway-commit-command-v1",
  input: "nir-validator-readiness-gateway-child-input-v1",
  prepareAck: "nir-validator-readiness-gateway-prepare-ack-v1",
  prepareCommand: "nir-validator-readiness-gateway-prepare-command-v1",
});
const domains = Object.freeze({
  commitAck: "VR_GATE_CHILD_COMMIT_ACK_V1",
  commitCommand: "VR_GATE_CHILD_COMMIT_CMD_V1",
  input: "VR_GATE_CHILD_INPUT_V1",
  prepareAck: "VR_GATE_CHILD_PREPARE_ACK_V1",
  prepareCommand: "VR_GATE_CHILD_PREPARE_CMD_V1",
  readiness: "VR_GATE_CHILD_READINESS_V1",
});

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}
function clone(value) { return JSON.parse(canonicalJson(value)); }
function same(left, right) { return canonicalJson(left) === canonicalJson(right); }
function tagged(value, domain) { return `sha3-256:${hashObject(value, domain)}`; }
function hash(value, label) {
  if (!TAGGED_HASH.test(value ?? "")) throw new Error(`${label} is invalid`);
  return value;
}
function nonce(value, label) {
  if (!HASH.test(value ?? "")) throw new Error(`${label} is invalid`);
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
    throw new Error("validator readiness gateway child bound port is invalid");
  }
  return value;
}
function host(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 ||
      /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error("validator readiness gateway child bound host is invalid");
  }
  return value;
}

function inputPins(value = {}) {
  exact(value, ["expectedBootstrapHash", "expectedBoundHost", "expectedBoundPort",
    "expectedLauncherNonce", "expectedReleaseProvenanceHash", "expectedSessionHash"],
  "validator readiness gateway child local pins");
  return { expectedBootstrapHash: hash(value.expectedBootstrapHash,
    "validator readiness gateway child expected bootstrap hash"),
  expectedBoundHost: host(value.expectedBoundHost),
  expectedBoundPort: port(value.expectedBoundPort),
  expectedLauncherNonce: nonce(value.expectedLauncherNonce,
    "validator readiness gateway child expected launcher nonce"),
  expectedReleaseProvenanceHash: hash(value.expectedReleaseProvenanceHash,
    "validator readiness gateway child expected release provenance hash"),
  expectedSessionHash: hash(value.expectedSessionHash,
    "validator readiness gateway child expected session hash") };
}

function cohortBootstraps(value) {
  exact(value, ROLES, "validator readiness gateway child cohort bootstraps");
  for (const role of ROLES) {
    if (!value[role] || Object.getPrototypeOf(value[role]) !== Object.prototype ||
        value[role].role !== role || !TAGGED_HASH.test(value[role].bootstrapHash ?? "")) {
      throw new Error(`validator readiness ${role} gateway child bootstrap is invalid`);
    }
  }
  return clone(value);
}

function gatewayInputPayload(value, pins, now) {
  exact(value, ["cohortBootstraps", "expectedBootstrapHash", "expectedBoundHost",
    "expectedBoundPort", "expectedLauncherNonce", "expectedReleaseProvenanceHash",
    "expectedSessionHash", "format", "launchEnvelope", "messageType", "role", "version"],
  "validator readiness gateway child input payload");
  const cohort = cohortBootstraps(value.cohortBootstraps);
  const launchEnvelope = verifyValidatorReadinessRuntimeLaunchEnvelope(value.launchEnvelope, {
    expectedBootstrapHash: pins.expectedBootstrapHash,
    expectedLauncherNonce: pins.expectedLauncherNonce,
    expectedReleaseProvenanceHash: pins.expectedReleaseProvenanceHash,
    expectedRole: "gateway", expectedSessionHash: pins.expectedSessionHash,
  }, { now });
  const bootstrap = verifyValidatorReadinessGatewayProcessBootstrap(cohort.gateway, {
    consensusSignerBootstrap: cohort.consensus,
    expectedLauncherNonce: pins.expectedLauncherNonce,
    expectedReleaseProvenanceHash: pins.expectedReleaseProvenanceHash,
    expectedSessionHash: pins.expectedSessionHash, now,
    transportSignerBootstrap: cohort.transport,
  });
  if (value.format !== FORMATS.input || value.messageType !== "gateway-bootstrap" ||
      value.role !== "gateway" || value.version !== 1 ||
      value.expectedBootstrapHash !== pins.expectedBootstrapHash ||
      value.expectedBoundHost !== pins.expectedBoundHost ||
      value.expectedBoundPort !== pins.expectedBoundPort ||
      value.expectedLauncherNonce !== pins.expectedLauncherNonce ||
      value.expectedReleaseProvenanceHash !== pins.expectedReleaseProvenanceHash ||
      value.expectedSessionHash !== pins.expectedSessionHash ||
      !same(launchEnvelope.bootstrap, bootstrap) ||
      !same(launchEnvelope.consensusSignerBootstrap, cohort.consensus) ||
      !same(launchEnvelope.transportSignerBootstrap, cohort.transport)) {
    throw new Error("validator readiness gateway child input binding is invalid");
  }
  return { cohortBootstraps: cohort, expectedBootstrapHash: pins.expectedBootstrapHash,
    expectedBoundHost: pins.expectedBoundHost, expectedBoundPort: pins.expectedBoundPort,
    expectedLauncherNonce: pins.expectedLauncherNonce,
    expectedReleaseProvenanceHash: pins.expectedReleaseProvenanceHash,
    expectedSessionHash: pins.expectedSessionHash, format: FORMATS.input, launchEnvelope,
    messageType: "gateway-bootstrap", role: "gateway", version: 1 };
}

export function createValidatorReadinessGatewayChildInput({ cohortBootstraps: cohort,
  launchEnvelope } = {}, pins = {}, { now = Date.now() } = {}) {
  const trusted = inputPins(pins);
  const payload = gatewayInputPayload({ cohortBootstraps: cohort,
    expectedBootstrapHash: trusted.expectedBootstrapHash,
    expectedBoundHost: trusted.expectedBoundHost, expectedBoundPort: trusted.expectedBoundPort,
    expectedLauncherNonce: trusted.expectedLauncherNonce,
    expectedReleaseProvenanceHash: trusted.expectedReleaseProvenanceHash,
    expectedSessionHash: trusted.expectedSessionHash, format: FORMATS.input, launchEnvelope,
    messageType: "gateway-bootstrap", role: "gateway", version: 1 }, trusted, now);
  return { ...payload, inputHash: tagged(payload, domains.input) };
}

export function verifyValidatorReadinessGatewayChildInput(value, pins = {},
  { now = Date.now() } = {}) {
  const trusted = inputPins(pins);
  exact(value, ["cohortBootstraps", "expectedBootstrapHash", "expectedBoundHost",
    "expectedBoundPort", "expectedLauncherNonce", "expectedReleaseProvenanceHash",
    "expectedSessionHash", "format", "inputHash", "launchEnvelope", "messageType", "role",
    "version"], "validator readiness gateway child input");
  const { inputHash, ...unsigned } = value;
  const payload = gatewayInputPayload(unsigned, trusted, now);
  if (!TAGGED_HASH.test(inputHash ?? "") || inputHash !== tagged(payload, domains.input)) {
    throw new Error("validator readiness gateway child input hash is invalid");
  }
  return { ...payload, inputHash };
}

function protocolContext(gatewayInputValue, expectedGatewayReady, pins, now) {
  const input = verifyValidatorReadinessGatewayChildInput(gatewayInputValue, {
    expectedBootstrapHash: pins.expectedBootstrapHash,
    expectedBoundHost: pins.expectedBoundHost, expectedBoundPort: pins.expectedBoundPort,
    expectedLauncherNonce: pins.expectedLauncherNonce,
    expectedReleaseProvenanceHash: pins.expectedReleaseProvenanceHash,
    expectedSessionHash: pins.expectedSessionHash,
  }, { now });
  const gatewayReady = verifyValidatorReadinessGatewayRuntimeReady(expectedGatewayReady, {
    expectedBootstrapHash: input.expectedBootstrapHash,
    expectedBoundHost: input.expectedBoundHost, expectedBoundPort: input.expectedBoundPort,
    expectedLauncherNonce: input.expectedLauncherNonce,
    expectedPid: pid(pins.expectedGatewayPid,
      "validator readiness gateway child expected gateway PID"),
    expectedReleaseProvenanceHash: input.expectedReleaseProvenanceHash,
    expectedRole: "gateway", expectedSessionHash: input.expectedSessionHash,
    expectedTlsCertificateSha256: input.cohortBootstraps.gateway.tlsCertificateSha256,
  });
  return { gatewayReady, input };
}

function protocolPins(value = {}) {
  exact(value, ["expectedBootstrapHash", "expectedBoundHost", "expectedBoundPort",
    "expectedConsensusPid", "expectedGatewayPid", "expectedLauncherNonce",
    "expectedReleaseProvenanceHash", "expectedSessionHash", "expectedTransportPid"],
  "validator readiness gateway activation local pins");
  return { ...inputPins({ expectedBootstrapHash: value.expectedBootstrapHash,
    expectedBoundHost: value.expectedBoundHost, expectedBoundPort: value.expectedBoundPort,
    expectedLauncherNonce: value.expectedLauncherNonce,
    expectedReleaseProvenanceHash: value.expectedReleaseProvenanceHash,
    expectedSessionHash: value.expectedSessionHash }),
  expectedConsensusPid: pid(value.expectedConsensusPid,
    "validator readiness gateway expected consensus PID"),
  expectedGatewayPid: pid(value.expectedGatewayPid,
    "validator readiness gateway expected gateway PID"),
  expectedTransportPid: pid(value.expectedTransportPid,
    "validator readiness gateway expected transport PID") };
}

function normalizeReadiness(value, context, pins, now) {
  exact(value, ROLES, "validator readiness gateway child readiness cohort");
  const common = { expectedLauncherNonce: context.input.expectedLauncherNonce,
    expectedReleaseProvenanceHash: context.input.expectedReleaseProvenanceHash,
    expectedSessionHash: context.input.expectedSessionHash, now };
  const consensus = verifyValidatorReadinessSignerReady(value.consensus, {
    ...common, bootstrap: context.input.cohortBootstraps.consensus,
    expectedPid: pins.expectedConsensusPid, expectedRole: "consensus",
  });
  const transport = verifyValidatorReadinessSignerReady(value.transport, {
    ...common, bootstrap: context.input.cohortBootstraps.transport,
    expectedPid: pins.expectedTransportPid, expectedRole: "transport",
  });
  const gateway = verifyValidatorReadinessGatewayRuntimeReady(value.gateway, {
    expectedBootstrapHash: context.input.expectedBootstrapHash,
    expectedBoundHost: context.input.expectedBoundHost,
    expectedBoundPort: context.input.expectedBoundPort,
    expectedLauncherNonce: context.input.expectedLauncherNonce,
    expectedPid: pins.expectedGatewayPid,
    expectedReleaseProvenanceHash: context.input.expectedReleaseProvenanceHash,
    expectedRole: "gateway", expectedSessionHash: context.input.expectedSessionHash,
    expectedTlsCertificateSha256: context.input.cohortBootstraps.gateway.tlsCertificateSha256,
  });
  if (!same(gateway, context.gatewayReady)) {
    throw new Error("validator readiness gateway child own readiness is invalid");
  }
  return { consensus, gateway, transport };
}

function statusPins(context, readiness, role) {
  return { expectedBootstrapHash: context.input.cohortBootstraps[role].bootstrapHash,
    expectedLauncherNonce: context.input.expectedLauncherNonce,
    expectedPid: readiness[role].pid, expectedProcessNonce: readiness[role].processNonce,
    expectedReleaseProvenanceHash: context.input.expectedReleaseProvenanceHash,
    expectedRole: role, expectedSessionHash: context.input.expectedSessionHash };
}

function activationSet(value, readiness, context) {
  exact(value, ROLES, "validator readiness gateway child activation set");
  const result = {};
  for (const role of ROLES) result[role] = verifyValidatorReadinessLaunchActivation(value[role], {
    ...statusPins(context, readiness, role), expectedReadiness: readiness,
  });
  return result;
}

function createActivationSet(readiness, context) {
  return Object.fromEntries(ROLES.map((role) => [role,
    createValidatorReadinessLaunchActivation({ readiness }, statusPins(context, readiness, role))]));
}

function activationHashes(activations) {
  return Object.fromEntries(ROLES.map((role) => [role,
    hash(activations[role]?.activationHash,
      `validator readiness ${role} gateway child activation hash`)]));
}

function preparePayload(value, context, pins, now) {
  exact(value, ["activationHashes", "activations", "format", "gatewayInputHash",
    "gatewayReadyHash", "messageType", "readiness", "readinessHash", "role", "sessionHash",
    "version"], "validator readiness gateway prepare payload");
  const readiness = normalizeReadiness(value.readiness, context, pins, now);
  const activations = activationSet(value.activations, readiness, context);
  const hashes = activationHashes(activations);
  const readinessHash = tagged(readiness, domains.readiness);
  if (value.format !== FORMATS.prepareCommand || value.messageType !== "prepare" ||
      value.role !== "gateway" || value.version !== 1 ||
      value.gatewayInputHash !== context.input.inputHash ||
      value.gatewayReadyHash !== context.gatewayReady.readyHash ||
      value.sessionHash !== context.input.expectedSessionHash ||
      value.readinessHash !== readinessHash || !same(value.activationHashes, hashes)) {
    throw new Error("validator readiness gateway prepare binding is invalid");
  }
  return { activationHashes: hashes, activations, format: FORMATS.prepareCommand,
    gatewayInputHash: context.input.inputHash, gatewayReadyHash: context.gatewayReady.readyHash,
    messageType: "prepare", readiness, readinessHash, role: "gateway",
    sessionHash: context.input.expectedSessionHash, version: 1 };
}

export function createValidatorReadinessGatewayPrepareCommand({ gatewayInput, gatewayReady,
  readiness } = {}, pins = {}, { now = Date.now() } = {}) {
  const trusted = protocolPins(pins);
  const context = protocolContext(gatewayInput, gatewayReady, trusted, now);
  const normalized = normalizeReadiness(readiness, context, trusted, now);
  const activations = createActivationSet(normalized, context);
  const payload = preparePayload({ activationHashes: activationHashes(activations), activations,
    format: FORMATS.prepareCommand, gatewayInputHash: context.input.inputHash,
    gatewayReadyHash: context.gatewayReady.readyHash, messageType: "prepare",
    readiness: normalized, readinessHash: tagged(normalized, domains.readiness), role: "gateway",
    sessionHash: context.input.expectedSessionHash, version: 1 }, context, trusted, now);
  return { ...payload, prepareHash: tagged(payload, domains.prepareCommand) };
}

export function verifyValidatorReadinessGatewayPrepareCommand(value, { gatewayInput,
  gatewayReady, ...pins } = {}, { now = Date.now() } = {}) {
  const trusted = protocolPins(pins);
  const context = protocolContext(gatewayInput, gatewayReady, trusted, now);
  exact(value, ["activationHashes", "activations", "format", "gatewayInputHash",
    "gatewayReadyHash", "messageType", "prepareHash", "readiness", "readinessHash", "role",
    "sessionHash", "version"], "validator readiness gateway prepare command");
  const { prepareHash, ...unsigned } = value;
  const payload = preparePayload(unsigned, context, trusted, now);
  if (!TAGGED_HASH.test(prepareHash ?? "") ||
      prepareHash !== tagged(payload, domains.prepareCommand)) {
    throw new Error("validator readiness gateway prepare hash is invalid");
  }
  return { ...payload, prepareHash };
}

function prepareAckPayload(value, prepare, context) {
  exact(value, ["bootstrapHash", "format", "gatewayReadyHash", "launcherNonce", "messageType",
    "pid", "prepareHash", "processNonce", "role", "sessionHash", "version"],
  "validator readiness gateway prepare acknowledgement payload");
  if (value.format !== FORMATS.prepareAck || value.messageType !== "prepare-ack" ||
      value.role !== "gateway" || value.version !== 1 ||
      value.bootstrapHash !== context.input.expectedBootstrapHash ||
      value.gatewayReadyHash !== context.gatewayReady.readyHash ||
      value.launcherNonce !== context.input.expectedLauncherNonce ||
      value.pid !== context.gatewayReady.pid ||
      value.processNonce !== context.gatewayReady.processNonce ||
      value.prepareHash !== prepare.prepareHash ||
      value.sessionHash !== context.input.expectedSessionHash) {
    throw new Error("validator readiness gateway prepare acknowledgement binding is invalid");
  }
  return clone(value);
}

export function createValidatorReadinessGatewayPrepareAcknowledgement({ prepare } = {},
  { gatewayInput, gatewayReady, ...pins } = {}, { now = Date.now() } = {}) {
  const trusted = protocolPins(pins);
  const context = protocolContext(gatewayInput, gatewayReady, trusted, now);
  const verified = verifyValidatorReadinessGatewayPrepareCommand(prepare,
    { gatewayInput, gatewayReady, ...trusted }, { now });
  const payload = prepareAckPayload({ bootstrapHash: context.input.expectedBootstrapHash,
    format: FORMATS.prepareAck, gatewayReadyHash: context.gatewayReady.readyHash,
    launcherNonce: context.input.expectedLauncherNonce, messageType: "prepare-ack",
    pid: context.gatewayReady.pid, prepareHash: verified.prepareHash,
    processNonce: context.gatewayReady.processNonce, role: "gateway",
    sessionHash: context.input.expectedSessionHash, version: 1 }, verified, context);
  return { ...payload, acknowledgementHash: tagged(payload, domains.prepareAck) };
}

export function verifyValidatorReadinessGatewayPrepareAcknowledgement(value, {
  expectedPrepare, gatewayInput, gatewayReady, ...pins
} = {}, { now = Date.now() } = {}) {
  const trusted = protocolPins(pins);
  const context = protocolContext(gatewayInput, gatewayReady, trusted, now);
  const prepare = verifyValidatorReadinessGatewayPrepareCommand(expectedPrepare,
    { gatewayInput, gatewayReady, ...trusted }, { now });
  exact(value, ["acknowledgementHash", "bootstrapHash", "format", "gatewayReadyHash",
    "launcherNonce", "messageType", "pid", "prepareHash", "processNonce", "role",
    "sessionHash", "version"], "validator readiness gateway prepare acknowledgement");
  const { acknowledgementHash, ...unsigned } = value;
  const payload = prepareAckPayload(unsigned, prepare, context);
  if (!TAGGED_HASH.test(acknowledgementHash ?? "") ||
      acknowledgementHash !== tagged(payload, domains.prepareAck)) {
    throw new Error("validator readiness gateway prepare acknowledgement hash is invalid");
  }
  return { ...payload, acknowledgementHash };
}

function signerAcknowledgements(value, prepare, context) {
  exact(value, SIGNER_ROLES, "validator readiness gateway signer acknowledgements");
  const result = {};
  for (const role of SIGNER_ROLES) result[role] =
    verifyValidatorReadinessSignerActivationAcknowledgement(value[role], {
      ...statusPins(context, prepare.readiness, role),
      expectedActivation: prepare.activations[role],
    });
  return result;
}

function signerAcknowledgementHashes(value) {
  return { consensus: hash(value.consensus?.acknowledgementHash,
    "validator readiness consensus activation acknowledgement hash"),
  transport: hash(value.transport?.acknowledgementHash,
    "validator readiness transport activation acknowledgement hash") };
}

function commitPayload(value, prepare, prepareAck, context) {
  exact(value, ["activationHashes", "format", "gatewayInputHash", "gatewayReadyHash",
    "messageType", "prepareAcknowledgementHash", "prepareHash", "readiness",
    "readinessHash", "role", "sessionHash", "signerAcknowledgementHashes",
    "signerAcknowledgements", "version"], "validator readiness gateway commit payload");
  const acknowledgements = signerAcknowledgements(value.signerAcknowledgements, prepare, context);
  const acknowledgementHashes = signerAcknowledgementHashes(acknowledgements);
  if (value.format !== FORMATS.commitCommand || value.messageType !== "commit" ||
      value.role !== "gateway" || value.version !== 1 ||
      value.gatewayInputHash !== context.input.inputHash ||
      value.gatewayReadyHash !== context.gatewayReady.readyHash ||
      value.prepareHash !== prepare.prepareHash ||
      value.prepareAcknowledgementHash !== prepareAck.acknowledgementHash ||
      value.readinessHash !== prepare.readinessHash ||
      value.sessionHash !== context.input.expectedSessionHash ||
      !same(value.readiness, prepare.readiness) ||
      !same(value.activationHashes, prepare.activationHashes) ||
      !same(value.signerAcknowledgementHashes, acknowledgementHashes)) {
    throw new Error("validator readiness gateway commit binding is invalid");
  }
  return { activationHashes: clone(prepare.activationHashes), format: FORMATS.commitCommand,
    gatewayInputHash: context.input.inputHash, gatewayReadyHash: context.gatewayReady.readyHash,
    messageType: "commit", prepareAcknowledgementHash: prepareAck.acknowledgementHash,
    prepareHash: prepare.prepareHash, readiness: clone(prepare.readiness),
    readinessHash: prepare.readinessHash, role: "gateway",
    sessionHash: context.input.expectedSessionHash,
    signerAcknowledgementHashes: acknowledgementHashes,
    signerAcknowledgements: acknowledgements, version: 1 };
}

export function createValidatorReadinessGatewayCommitCommand({ gatewayInput, gatewayReady,
  prepare, prepareAcknowledgement, signerAcknowledgements: acknowledgements } = {}, pins = {},
  { now = Date.now() } = {}) {
  const trusted = protocolPins(pins);
  const context = protocolContext(gatewayInput, gatewayReady, trusted, now);
  const verifiedPrepare = verifyValidatorReadinessGatewayPrepareCommand(prepare,
    { gatewayInput, gatewayReady, ...trusted }, { now });
  const verifiedPrepareAck = verifyValidatorReadinessGatewayPrepareAcknowledgement(
    prepareAcknowledgement, { expectedPrepare: verifiedPrepare, gatewayInput, gatewayReady,
      ...trusted }, { now });
  const verifiedAcks = signerAcknowledgements(acknowledgements, verifiedPrepare, context);
  const payload = commitPayload({ activationHashes: verifiedPrepare.activationHashes,
    format: FORMATS.commitCommand, gatewayInputHash: context.input.inputHash,
    gatewayReadyHash: context.gatewayReady.readyHash, messageType: "commit",
    prepareAcknowledgementHash: verifiedPrepareAck.acknowledgementHash,
    prepareHash: verifiedPrepare.prepareHash, readiness: verifiedPrepare.readiness,
    readinessHash: verifiedPrepare.readinessHash, role: "gateway",
    sessionHash: context.input.expectedSessionHash,
    signerAcknowledgementHashes: signerAcknowledgementHashes(verifiedAcks),
    signerAcknowledgements: verifiedAcks, version: 1 }, verifiedPrepare, verifiedPrepareAck, context);
  return { ...payload, commitHash: tagged(payload, domains.commitCommand) };
}

export function verifyValidatorReadinessGatewayCommitCommand(value, { expectedPrepare,
  expectedPrepareAcknowledgement, gatewayInput, gatewayReady, ...pins
} = {}, { now = Date.now() } = {}) {
  const trusted = protocolPins(pins);
  const context = protocolContext(gatewayInput, gatewayReady, trusted, now);
  const prepare = verifyValidatorReadinessGatewayPrepareCommand(expectedPrepare,
    { gatewayInput, gatewayReady, ...trusted }, { now });
  const prepareAck = verifyValidatorReadinessGatewayPrepareAcknowledgement(
    expectedPrepareAcknowledgement, { expectedPrepare: prepare, gatewayInput, gatewayReady,
      ...trusted }, { now });
  exact(value, ["activationHashes", "commitHash", "format", "gatewayInputHash",
    "gatewayReadyHash", "messageType", "prepareAcknowledgementHash", "prepareHash",
    "readiness", "readinessHash", "role", "sessionHash", "signerAcknowledgementHashes",
    "signerAcknowledgements", "version"], "validator readiness gateway commit command");
  const { commitHash, ...unsigned } = value;
  const payload = commitPayload(unsigned, prepare, prepareAck, context);
  if (!TAGGED_HASH.test(commitHash ?? "") ||
      commitHash !== tagged(payload, domains.commitCommand)) {
    throw new Error("validator readiness gateway commit hash is invalid");
  }
  return { ...payload, commitHash };
}

function commitAckPayload(value, commit, context) {
  exact(value, ["activationHash", "bootstrapHash", "commitHash", "format", "gatewayReadyHash",
    "launcherNonce", "messageType", "pid", "processNonce", "role", "sessionHash", "version"],
  "validator readiness gateway commit acknowledgement payload");
  if (value.format !== FORMATS.commitAck || value.messageType !== "commit-ack" ||
      value.role !== "gateway" || value.version !== 1 ||
      value.activationHash !== commit.activationHashes.gateway ||
      value.bootstrapHash !== context.input.expectedBootstrapHash ||
      value.commitHash !== commit.commitHash ||
      value.gatewayReadyHash !== context.gatewayReady.readyHash ||
      value.launcherNonce !== context.input.expectedLauncherNonce ||
      value.pid !== context.gatewayReady.pid ||
      value.processNonce !== context.gatewayReady.processNonce ||
      value.sessionHash !== context.input.expectedSessionHash) {
    throw new Error("validator readiness gateway commit acknowledgement binding is invalid");
  }
  return clone(value);
}

export function createValidatorReadinessGatewayCommitAcknowledgement({ commit } = {}, {
  expectedPrepare, expectedPrepareAcknowledgement, gatewayInput, gatewayReady, ...pins
} = {}, { now = Date.now() } = {}) {
  const trusted = protocolPins(pins);
  const context = protocolContext(gatewayInput, gatewayReady, trusted, now);
  const verified = verifyValidatorReadinessGatewayCommitCommand(commit, {
    expectedPrepare, expectedPrepareAcknowledgement, gatewayInput, gatewayReady, ...trusted,
  }, { now });
  const payload = commitAckPayload({ activationHash: verified.activationHashes.gateway,
    bootstrapHash: context.input.expectedBootstrapHash, commitHash: verified.commitHash,
    format: FORMATS.commitAck, gatewayReadyHash: context.gatewayReady.readyHash,
    launcherNonce: context.input.expectedLauncherNonce, messageType: "commit-ack",
    pid: context.gatewayReady.pid, processNonce: context.gatewayReady.processNonce,
    role: "gateway", sessionHash: context.input.expectedSessionHash, version: 1 },
  verified, context);
  return { ...payload, acknowledgementHash: tagged(payload, domains.commitAck) };
}

export function verifyValidatorReadinessGatewayCommitAcknowledgement(value, { expectedCommit,
  expectedPrepare, expectedPrepareAcknowledgement, gatewayInput, gatewayReady, ...pins
} = {}, { now = Date.now() } = {}) {
  const trusted = protocolPins(pins);
  const context = protocolContext(gatewayInput, gatewayReady, trusted, now);
  const commit = verifyValidatorReadinessGatewayCommitCommand(expectedCommit, {
    expectedPrepare, expectedPrepareAcknowledgement, gatewayInput, gatewayReady, ...trusted,
  }, { now });
  exact(value, ["acknowledgementHash", "activationHash", "bootstrapHash", "commitHash",
    "format", "gatewayReadyHash", "launcherNonce", "messageType", "pid", "processNonce",
    "role", "sessionHash", "version"], "validator readiness gateway commit acknowledgement");
  const { acknowledgementHash, ...unsigned } = value;
  const payload = commitAckPayload(unsigned, commit, context);
  if (!TAGGED_HASH.test(acknowledgementHash ?? "") ||
      acknowledgementHash !== tagged(payload, domains.commitAck)) {
    throw new Error("validator readiness gateway commit acknowledgement hash is invalid");
  }
  return { ...payload, acknowledgementHash };
}

export function createValidatorReadinessGatewayActivationController({ gatewayInput,
  gatewayReady } = {}, pins = {}, { now = () => Date.now() } = {}) {
  if (typeof now !== "function") throw new Error("validator readiness gateway clock is invalid");
  const trusted = protocolPins(pins);
  protocolContext(gatewayInput, gatewayReady, trusted, now());
  let phase = "waiting-prepare";
  let prepared = null;
  let prepareAcknowledgement = null;
  let commitAcknowledgement = null;
  const poison = () => {
    phase = "closed"; prepared = null; prepareAcknowledgement = null;
    commitAcknowledgement = null;
  };
  return Object.freeze({
    close() { poison(); },
    commit(command) {
      try {
        if (phase !== "prepared") {
          throw new Error("validator readiness gateway commit is out of order");
        }
        const verified = verifyValidatorReadinessGatewayCommitCommand(command, {
          expectedPrepare: prepared, expectedPrepareAcknowledgement: prepareAcknowledgement,
          gatewayInput, gatewayReady, ...trusted,
        }, { now: now() });
        commitAcknowledgement = createValidatorReadinessGatewayCommitAcknowledgement(
          { commit: verified }, { expectedPrepare: prepared,
            expectedPrepareAcknowledgement: prepareAcknowledgement,
            gatewayInput, gatewayReady, ...trusted }, { now: now() });
        phase = "commit-ack-pending";
        return commitAcknowledgement;
      } catch (error) { poison(); throw error; }
    },
    commitAcknowledgementFlushed(value) {
      try {
        if (phase !== "commit-ack-pending" || !same(value, commitAcknowledgement)) {
          throw new Error("validator readiness gateway commit acknowledgement flush is out of order");
        }
        phase = "committed";
        return true;
      } catch (error) { poison(); throw error; }
    },
    phase() { return phase; },
    prepare(command) {
      try {
        if (phase !== "waiting-prepare") {
          throw new Error("validator readiness gateway prepare is out of order");
        }
        prepared = verifyValidatorReadinessGatewayPrepareCommand(command,
          { gatewayInput, gatewayReady, ...trusted }, { now: now() });
        prepareAcknowledgement = createValidatorReadinessGatewayPrepareAcknowledgement(
          { prepare: prepared }, { gatewayInput, gatewayReady, ...trusted }, { now: now() });
        phase = "prepare-ack-pending";
        return prepareAcknowledgement;
      } catch (error) { poison(); throw error; }
    },
    prepareAcknowledgementFlushed(value) {
      try {
        if (phase !== "prepare-ack-pending" || !same(value, prepareAcknowledgement)) {
          throw new Error("validator readiness gateway prepare acknowledgement flush is out of order");
        }
        phase = "prepared";
        return true;
      } catch (error) { poison(); throw error; }
    },
  });
}

export function encodeValidatorReadinessGatewayChildFrame(value) {
  return encodeCanonicalIpcFrame(value,
    { label: "validator readiness gateway child frame", maximumBytes: MAX_FRAME_BYTES });
}
export function createValidatorReadinessGatewayChildFrameDecoder() {
  return createCanonicalIpcFrameDecoder(
    { label: "validator readiness gateway child frame", maximumBytes: MAX_FRAME_BYTES });
}
export const VALIDATOR_READINESS_GATEWAY_CHILD_MAX_FRAME_BYTES = MAX_FRAME_BYTES;

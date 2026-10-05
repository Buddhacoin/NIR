import { randomBytes } from "node:crypto";

import { canonicalJson, hashObject, verifyObject } from "./crypto.mjs";
import {
  createCanonicalIpcFrameDecoder,
  encodeCanonicalIpcFrame,
} from "./canonical-ipc-framing.mjs";
import {
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN,
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN,
  validatorAdmissionReadinessConsensusSigningInput,
  validatorAdmissionReadinessTransportSigningInput,
  verifyValidatorAdmissionReadinessCandidateResponse,
  verifyValidatorAdmissionReadinessCandidateTransportResponse,
} from "./validator-admission-readiness-auth.mjs";
import {
  createValidatorReadinessRolePackage,
  verifyValidatorReadinessRolePackage,
} from "./validator-readiness-session.mjs";
import { verifyValidatorReadinessSignerReady }
  from "./validator-readiness-process-protocol.mjs";

export const VALIDATOR_READINESS_SIGNER_MAX_FRAME_BYTES = 512 * 1024;
export const VALIDATOR_READINESS_SIGNER_MAX_TIMEOUT_MS = 60_000;

const REQUEST_ID = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const FORMATS = Object.freeze({
  consensusRequest: "nir-validator-readiness-consensus-sign-request-v2",
  consensusResponse: "nir-validator-readiness-consensus-sign-response-v2",
  transportRequest: "nir-validator-readiness-transport-sign-request-v2",
  transportResponse: "nir-validator-readiness-transport-sign-response-v2",
});

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function requestId() { return randomBytes(32).toString("hex"); }

function channelEpoch(value) {
  if (!TAGGED_HASH.test(value ?? "")) {
    throw new Error("validator readiness signer channel epoch is invalid");
  }
  return value;
}

export function createValidatorReadinessSignerChannelEpoch(value = {}, {
  expectedRole, now = Date.now(),
} = {}) {
  exact(value, ["bootstrap", "expectedLauncherNonce", "expectedPid",
    "expectedReleaseProvenanceHash", "expectedSessionHash", "signerReady"],
  "validator readiness signer channel binding");
  if (!new Set(["consensus", "transport"]).has(expectedRole)) {
    throw new Error("validator readiness signer channel role is invalid");
  }
  const ready = verifyValidatorReadinessSignerReady(value.signerReady, {
    bootstrap: value.bootstrap, expectedLauncherNonce: value.expectedLauncherNonce,
    expectedPid: value.expectedPid,
    expectedReleaseProvenanceHash: value.expectedReleaseProvenanceHash,
    expectedRole, expectedSessionHash: value.expectedSessionHash, now,
  });
  const anchors = { bootstrapHash: ready.bootstrapHash, launcherNonce: ready.launcherNonce,
    pid: ready.pid, processNonce: ready.processNonce, readyHash: ready.readyHash,
    role: expectedRole, sessionHash: ready.sessionHash };
  const digest = expectedRole === "transport"
    ? hashObject(anchors, "VR_TRANS_SIGNER_CHANNEL_EPOCH_V1")
    : hashObject(anchors, "VR_CONS_SIGNER_CHANNEL_EPOCH_V1");
  return `sha3-256:${digest}`;
}

function expectedEpoch(binding, expectedRole, now) {
  return createValidatorReadinessSignerChannelEpoch(binding, { expectedRole, now });
}

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("validator readiness signer timestamp is invalid");
  }
  return value;
}

function rolePair(gatewayValue, role, now) {
  timestamp(now);
  const gateway = verifyValidatorReadinessRolePackage(gatewayValue,
    { expectedRole: "gateway", now });
  const signer = createValidatorReadinessRolePackage(gateway.session, role, { now });
  return { gateway, signer };
}

function signerPair(signerValue, role, now) {
  timestamp(now);
  const signer = verifyValidatorReadinessRolePackage(signerValue, { expectedRole: role, now });
  const gateway = createValidatorReadinessRolePackage(signer.session, "gateway", { now });
  return { gateway, signer };
}

function commonRequest(value, format, pair, expectedChannelEpoch, label) {
  if (value.format !== format || value.version !== 2 ||
      !REQUEST_ID.test(value.requestId ?? "") || !TAGGED_HASH.test(value.sessionHash ?? "") ||
      value.channelEpoch !== channelEpoch(expectedChannelEpoch) ||
      value.gatewayRolePackageHash !== pair.gateway.rolePackageHash ||
      value.signerRolePackageHash !== pair.signer.rolePackageHash ||
      value.sessionHash !== pair.signer.session.sessionHash) {
    throw new Error(`${label} binding is invalid`);
  }
}

function commonResponse(value, verified, format, expectedChannelEpoch, responseHashDomain, label) {
  const request = verified.request;
  const { responseHash, ...payload } = value;
  if (value.format !== format || value.version !== 2 || value.requestId !== request.requestId ||
      value.channelEpoch !== channelEpoch(expectedChannelEpoch) ||
      value.channelEpoch !== request.channelEpoch ||
      value.gatewayRolePackageHash !== request.gatewayRolePackageHash ||
      value.signerRolePackageHash !== request.signerRolePackageHash ||
      value.sessionHash !== request.sessionHash || value.requestHash !== verified.requestHash ||
      value.operationHash !== verified.operationHash || !TAGGED_HASH.test(responseHash ?? "") ||
      responseHash !== `sha3-256:${hashObject(payload, responseHashDomain)}`) {
    throw new Error(`${label} binding is invalid`);
  }
}

function clone(value) { return JSON.parse(canonicalJson(value)); }

export function encodeValidatorReadinessSignerFrame(value) {
  return encodeCanonicalIpcFrame(value, {
    label: "validator readiness signer frame",
    maximumBytes: VALIDATOR_READINESS_SIGNER_MAX_FRAME_BYTES,
  });
}

export function createValidatorReadinessSignerFrameDecoder() {
  return createCanonicalIpcFrameDecoder({
    label: "validator readiness signer frame",
    maximumBytes: VALIDATOR_READINESS_SIGNER_MAX_FRAME_BYTES,
  });
}

export function createValidatorReadinessTransportSignRequest({ challenge,
  gatewayRolePackage } = {}, { channelBinding, now = Date.now() } = {}) {
  const expectedChannelEpoch = expectedEpoch(channelBinding, "transport", now);
  const pair = rolePair(gatewayRolePackage, "transport", now);
  const prepared = validatorAdmissionReadinessTransportSigningInput({ challenge,
    context: pair.gateway.session.context, validators: pair.gateway.session.validators });
  return { challenge: prepared.challenge, channelEpoch: channelEpoch(expectedChannelEpoch),
    format: FORMATS.transportRequest,
    gatewayRolePackageHash: pair.gateway.rolePackageHash, requestId: requestId(),
    sessionHash: pair.gateway.session.sessionHash,
    signerRolePackageHash: pair.signer.rolePackageHash, version: 2 };
}

export function verifyValidatorReadinessTransportSignRequest(value,
  { channelBinding, rolePackage, now = Date.now() } = {}) {
  const expectedChannelEpoch = expectedEpoch(channelBinding, "transport", now);
  exact(value, ["challenge", "channelEpoch", "format", "gatewayRolePackageHash", "requestId", "sessionHash",
    "signerRolePackageHash", "version"], "validator readiness transport sign request");
  const pair = signerPair(rolePackage, "transport", now);
  commonRequest(value, FORMATS.transportRequest, pair, expectedChannelEpoch,
    "validator readiness transport sign request");
  const prepared = validatorAdmissionReadinessTransportSigningInput({ challenge: value.challenge,
    context: pair.signer.session.context, validators: pair.signer.session.validators });
  const request = clone(value);
  return { operationHash: `sha3-256:${hashObject({
    challengeHash: prepared.challenge.challengeHash, channelEpoch: value.channelEpoch,
    sessionHash: value.sessionHash,
    signerRolePackageHash: value.signerRolePackageHash,
  }, "VALIDATOR_READY_TRANSPORT_OPERATION_V2")}`,
  request, requestHash: `sha3-256:${hashObject(request,
    "VR_TRANS_SIGN_REQUEST_V2")}`,
  signingInput: prepared.signingInput };
}

export function createValidatorReadinessTransportSignResponse({ request, rolePackage,
  signature } = {}, { channelBinding, now = Date.now() } = {}) {
  const expectedChannelEpoch = expectedEpoch(channelBinding, "transport", now);
  const verified = verifyValidatorReadinessTransportSignRequest(request,
    { channelBinding, rolePackage, now });
  const session = signerPair(rolePackage, "transport", now).signer.session;
  if (!verifyObject(verified.signingInput, signature, session.context.transport.publicKey,
    VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN)) {
    throw new Error("validator readiness transport signer signature is invalid");
  }
  const transportResponse = verifyValidatorAdmissionReadinessCandidateTransportResponse({
    challenge: verified.request.challenge, context: session.context, ...verified.signingInput,
    transportSignature: signature,
  }, { validators: session.validators });
  const payload = { channelEpoch: verified.request.channelEpoch, format: FORMATS.transportResponse,
    gatewayRolePackageHash: verified.request.gatewayRolePackageHash,
    operationHash: verified.operationHash, requestHash: verified.requestHash,
    requestId: verified.request.requestId, sessionHash: verified.request.sessionHash,
    signerRolePackageHash: verified.request.signerRolePackageHash,
    transportResponse, version: 2 };
  return { ...payload, responseHash: `sha3-256:${hashObject(payload,
    "VR_TRANS_SIGN_RESPONSE_V2")}` };
}

export function verifyValidatorReadinessTransportSignResponse(value, { gatewayRolePackage,
  channelBinding, request, now = Date.now() } = {}) {
  const expectedChannelEpoch = expectedEpoch(channelBinding, "transport", now);
  exact(value, ["channelEpoch", "format", "gatewayRolePackageHash", "operationHash", "requestHash", "requestId",
    "responseHash", "sessionHash", "signerRolePackageHash", "transportResponse", "version"],
  "validator readiness transport sign response");
  const pair = rolePair(gatewayRolePackage, "transport", now);
  const expectedRequest = verifyValidatorReadinessTransportSignRequest(request,
    { channelBinding, rolePackage: pair.signer, now });
  commonResponse(value, expectedRequest, FORMATS.transportResponse, expectedChannelEpoch,
    "VR_TRANS_SIGN_RESPONSE_V2",
    "validator readiness transport sign response");
  const transportResponse = verifyValidatorAdmissionReadinessCandidateTransportResponse(
    value.transportResponse, { validators: pair.gateway.session.validators });
  if (canonicalJson(transportResponse.challenge) !==
      canonicalJson(expectedRequest.request.challenge) ||
      canonicalJson(transportResponse.context) !== canonicalJson(pair.gateway.session.context)) {
    throw new Error("validator readiness transport sign response operation is mismatched");
  }
  return clone(value);
}

export function createValidatorReadinessConsensusSignRequest({ gatewayRolePackage,
  transportResponse } = {}, { channelBinding, now = Date.now() } = {}) {
  const expectedChannelEpoch = expectedEpoch(channelBinding, "consensus", now);
  const pair = rolePair(gatewayRolePackage, "consensus", now);
  const prepared = validatorAdmissionReadinessConsensusSigningInput({ transportResponse,
    validators: pair.gateway.session.validators });
  if (canonicalJson(prepared.transportResponse.context) !==
      canonicalJson(pair.gateway.session.context)) {
    throw new Error("validator readiness consensus sign request context is mismatched");
  }
  return { channelEpoch: channelEpoch(expectedChannelEpoch), format: FORMATS.consensusRequest,
    gatewayRolePackageHash: pair.gateway.rolePackageHash, requestId: requestId(),
    sessionHash: pair.gateway.session.sessionHash,
    signerRolePackageHash: pair.signer.rolePackageHash,
    transportResponse: prepared.transportResponse, version: 2 };
}

export function verifyValidatorReadinessConsensusSignRequest(value,
  { channelBinding, rolePackage, now = Date.now() } = {}) {
  const expectedChannelEpoch = expectedEpoch(channelBinding, "consensus", now);
  exact(value, ["channelEpoch", "format", "gatewayRolePackageHash", "requestId", "sessionHash",
    "signerRolePackageHash", "transportResponse", "version"],
  "validator readiness consensus sign request");
  const pair = signerPair(rolePackage, "consensus", now);
  commonRequest(value, FORMATS.consensusRequest, pair, expectedChannelEpoch,
    "validator readiness consensus sign request");
  const prepared = validatorAdmissionReadinessConsensusSigningInput({
    transportResponse: value.transportResponse, validators: pair.signer.session.validators });
  if (canonicalJson(prepared.transportResponse.context) !==
      canonicalJson(pair.signer.session.context)) {
    throw new Error("validator readiness consensus sign request context is mismatched");
  }
  const request = clone(value);
  return { operationHash: `sha3-256:${hashObject({
    channelEpoch: value.channelEpoch, responseHash: prepared.transportResponse.responseHash,
    sessionHash: value.sessionHash,
    signerRolePackageHash: value.signerRolePackageHash,
    transportSignature: prepared.transportResponse.transportSignature,
  }, "VALIDATOR_READY_CONSENSUS_OPERATION_V2")}`,
  request, requestHash: `sha3-256:${hashObject(request,
    "VR_CONS_SIGN_REQUEST_V2")}`,
  signingInput: prepared.signingInput };
}

export function createValidatorReadinessConsensusSignResponse({ request, rolePackage,
  signature } = {}, { channelBinding, now = Date.now() } = {}) {
  const expectedChannelEpoch = expectedEpoch(channelBinding, "consensus", now);
  const verified = verifyValidatorReadinessConsensusSignRequest(request,
    { channelBinding, rolePackage, now });
  const session = signerPair(rolePackage, "consensus", now).signer.session;
  if (!verifyObject(verified.signingInput, signature, session.context.candidate.publicKey,
    VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN)) {
    throw new Error("validator readiness consensus signer signature is invalid");
  }
  const candidateResponse = verifyValidatorAdmissionReadinessCandidateResponse({
    ...verified.request.transportResponse, consensusSignature: signature,
  }, { validators: session.validators });
  const payload = { candidateResponse, channelEpoch: verified.request.channelEpoch,
    format: FORMATS.consensusResponse,
    gatewayRolePackageHash: verified.request.gatewayRolePackageHash,
    operationHash: verified.operationHash, requestHash: verified.requestHash,
    requestId: verified.request.requestId, sessionHash: verified.request.sessionHash,
    signerRolePackageHash: verified.request.signerRolePackageHash, version: 2 };
  return { ...payload, responseHash: `sha3-256:${hashObject(payload,
    "VR_CONS_SIGN_RESPONSE_V2")}` };
}

export function verifyValidatorReadinessConsensusSignResponse(value, { gatewayRolePackage,
  channelBinding, request, now = Date.now() } = {}) {
  const expectedChannelEpoch = expectedEpoch(channelBinding, "consensus", now);
  exact(value, ["candidateResponse", "channelEpoch", "format", "gatewayRolePackageHash", "operationHash",
    "requestHash", "requestId", "responseHash", "sessionHash", "signerRolePackageHash", "version"],
  "validator readiness consensus sign response");
  const pair = rolePair(gatewayRolePackage, "consensus", now);
  const expectedRequest = verifyValidatorReadinessConsensusSignRequest(request,
    { channelBinding, rolePackage: pair.signer, now });
  commonResponse(value, expectedRequest, FORMATS.consensusResponse, expectedChannelEpoch,
    "VR_CONS_SIGN_RESPONSE_V2",
    "validator readiness consensus sign response");
  const candidateResponse = verifyValidatorAdmissionReadinessCandidateResponse(
    value.candidateResponse, { validators: pair.gateway.session.validators });
  if (canonicalJson((({ consensusSignature: _signature, ...rest }) => rest)(candidateResponse)) !==
        canonicalJson(expectedRequest.request.transportResponse)) {
    throw new Error("validator readiness consensus sign response operation is mismatched");
  }
  return clone(value);
}

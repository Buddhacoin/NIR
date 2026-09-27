import {
  addressFromPublicKey, canonicalJson, hashObject, signObject, verifyObject,
} from "./crypto.mjs";
import { MAX_VALIDATORS, SIGNATURE_ALGORITHM } from "./constants.mjs";
import { validatorAdmissionObservationPayload } from "./validator-admission.mjs";
import { validatorSetId } from "./validator-rotation.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const OPERATOR = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const NONCE = /^[0-9a-f]{64}$/;
const SIGNATURE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const VALIDATOR_ADMISSION_READINESS_CHALLENGE_DOMAIN =
  "VALIDATOR_READY_CHALLENGE_V1";
export const VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN =
  "VALIDATOR_READY_CANDIDATE_TRANSPORT_V1";
export const VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN =
  "VALIDATOR_READY_CANDIDATE_CONSENSUS_V1";
export const VALIDATOR_ADMISSION_READINESS_OBSERVATION_DOMAIN =
  "VALIDATOR_ADMISSION_LIVE_OBSERVATION_V1";
export const VALIDATOR_ADMISSION_READINESS_OBSERVER_RESULT_DOMAIN =
  "VALIDATOR_READY_OBSERVER_RESULT_V1";

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function canonicalSignature(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 7_000 &&
    SIGNATURE.test(value) && Buffer.from(value, "base64").toString("base64") === value;
}

function identity(value, { operator = false } = {}) {
  exact(value, operator
    ? ["address", "algorithm", "operatorId", "publicKey"]
    : ["address", "algorithm", "publicKey"], operator ? "candidate identity" : "transport identity");
  if (value.algorithm !== SIGNATURE_ALGORITHM || !ADDRESS.test(value.address ?? "") ||
      addressFromPublicKey(value.publicKey) !== value.address ||
      (operator && !OPERATOR.test(value.operatorId ?? ""))) {
    throw new Error(`${operator ? "candidate" : "transport"} identity is invalid`);
  }
  return structuredClone(value);
}

function contextPayload({ admissionId, candidate, chainIdentityGenesisHash, checkpoint, endpoint,
  expiresAtHeight, networkId, nonce, tlsCertificateSha256, transport }) {
  const normalizedCandidate = identity(candidate, { operator: true });
  const normalizedTransport = identity(transport);
  exact(checkpoint, ["blockHash", "height", "stateRoot", "validatorSetId"],
    "validator admission readiness checkpoint");
  if (!HASH.test(checkpoint.blockHash ?? "") || !HASH.test(checkpoint.stateRoot ?? "") ||
      !HASH.test(checkpoint.validatorSetId ?? "") || !Number.isSafeInteger(checkpoint.height) ||
      checkpoint.height < 1) {
    throw new Error("validator admission readiness checkpoint is invalid");
  }
  const observation = validatorAdmissionObservationPayload({ admissionId,
    chainIdentityGenesisHash, endpoint, expiresAtHeight, networkId, nonce,
    observedHeight: checkpoint.height, tlsCertificateSha256,
    transportAddress: normalizedTransport.address, validatorSetId: checkpoint.validatorSetId });
  if (!HASH.test(observation.admissionId ?? "") ||
      !HASH.test(observation.chainIdentityGenesisHash ?? "") ||
      !HASH.test(observation.tlsCertificateSha256 ?? "") ||
      !HASH.test(observation.validatorSetId ?? "") ||
      typeof observation.networkId !== "string" || observation.networkId.length < 1 ||
      observation.networkId.length > 128 || !Number.isSafeInteger(observation.nonce) ||
      observation.nonce < 0 || !Number.isSafeInteger(observation.observedHeight) ||
      observation.observedHeight < 1 || !Number.isSafeInteger(observation.expiresAtHeight) ||
      observation.expiresAtHeight !== observation.observedHeight + 16 ||
      normalizedCandidate.address === normalizedTransport.address) {
    throw new Error("validator admission readiness context is invalid");
  }
  return { admissionId: observation.admissionId, candidate: normalizedCandidate,
    chainIdentityGenesisHash: observation.chainIdentityGenesisHash, endpoint: observation.endpoint,
    expiresAtHeight: observation.expiresAtHeight,
    checkpoint: structuredClone(checkpoint),
    format: "nir-validator-admission-readiness-context-v1", networkId: observation.networkId,
    nonce: observation.nonce,
    tlsCertificateSha256: observation.tlsCertificateSha256, transport: normalizedTransport,
    version: 1 };
}

export function createValidatorAdmissionReadinessContext({ admission, chainIdentityGenesisHash,
  checkpoint, expiresAtHeight, networkId, nonce } = {}) {
  const payload = contextPayload({ admissionId: admission?.admissionId,
    candidate: admission && { address: admission.address, algorithm: admission.algorithm,
      operatorId: admission.operatorId, publicKey: admission.publicKey },
    chainIdentityGenesisHash, checkpoint, endpoint: admission?.endpoint, expiresAtHeight,
    networkId, nonce, tlsCertificateSha256: admission?.tlsCertificateSha256,
    transport: admission?.transport });
  return { ...payload, contextHash: hashObject(payload, "VALIDATOR_READY_CONTEXT_V1") };
}

export function verifyValidatorAdmissionReadinessContext(value) {
  exact(value, ["admissionId", "candidate", "chainIdentityGenesisHash", "checkpoint",
    "contextHash", "endpoint", "expiresAtHeight", "format", "networkId", "nonce",
    "tlsCertificateSha256", "transport", "version"],
  "validator admission readiness context");
  const { contextHash, ...unsigned } = value;
  const payload = contextPayload(unsigned);
  if (value.format !== "nir-validator-admission-readiness-context-v1" || value.version !== 1 ||
      canonicalJson(unsigned) !== canonicalJson(payload) ||
      contextHash !== hashObject(payload, "VALIDATOR_READY_CONTEXT_V1")) {
    throw new Error("validator admission readiness context commitment is invalid");
  }
  return structuredClone(value);
}

export function validatorAdmissionReadinessObservationFromContext(value) {
  return observation(verifyValidatorAdmissionReadinessContext(value));
}

function activeValidators(validators, context) {
  if (!Array.isArray(validators) || validators.length < 4 || validators.length > MAX_VALIDATORS) {
    throw new Error("validator admission readiness observer set is invalid");
  }
  const members = validators.map((member) => identity(member, { operator: true }))
    .sort((left, right) => left.address.localeCompare(right.address));
  if (new Set(members.map(({ address }) => address)).size !== members.length) {
    throw new Error("validator admission readiness observer set is duplicated");
  }
  if (context !== undefined &&
      validatorSetId(members) !== context?.checkpoint?.validatorSetId) {
    throw new Error("validator admission readiness observer set commitment is invalid");
  }
  return members;
}

function challengePayload({ challengeNonce, contextHash, observer }) {
  if (!NONCE.test(challengeNonce ?? "") || !HASH.test(contextHash ?? "") ||
      !ADDRESS.test(observer ?? "")) {
    throw new Error("validator admission readiness challenge is invalid");
  }
  return { challengeNonce, contextHash,
    format: "nir-validator-admission-readiness-observer-challenge-v1", observer, version: 1 };
}

export function createValidatorAdmissionReadinessChallenge({ challengeNonce, context,
  observerWallet, validators } = {}) {
  const verifiedContext = verifyValidatorAdmissionReadinessContext(context);
  const members = activeValidators(validators, verifiedContext);
  const observer = members.find(({ address }) => address === observerWallet?.address);
  if (!observer || observer.publicKey !== observerWallet?.publicKey) {
    throw new Error("validator admission readiness challenge observer is not active");
  }
  const payload = challengePayload({ challengeNonce, contextHash: verifiedContext.contextHash,
    observer: observerWallet?.address });
  const challengeHash = hashObject(payload, "VALIDATOR_READY_CHALLENGE_HASH_V1");
  return { ...payload, challengeHash,
    signature: signObject({ ...payload, challengeHash }, observerWallet,
      VALIDATOR_ADMISSION_READINESS_CHALLENGE_DOMAIN) };
}

export function verifyValidatorAdmissionReadinessChallenge(value, { context, validators } = {}) {
  exact(value, ["challengeHash", "challengeNonce", "contextHash", "format", "observer",
    "signature", "version"], "validator admission readiness challenge");
  const verifiedContext = verifyValidatorAdmissionReadinessContext(context);
  const members = activeValidators(validators, verifiedContext);
  const observer = members.find(({ address }) => address === value.observer);
  const { challengeHash, signature, ...unsigned } = value;
  const payload = challengePayload(unsigned);
  if (!observer || value.contextHash !== verifiedContext.contextHash ||
      canonicalJson(unsigned) !== canonicalJson(payload) ||
      challengeHash !== hashObject(payload, "VALIDATOR_READY_CHALLENGE_HASH_V1") ||
      !canonicalSignature(signature) ||
      !verifyObject({ ...payload, challengeHash }, signature, observer.publicKey,
        VALIDATOR_ADMISSION_READINESS_CHALLENGE_DOMAIN)) {
    throw new Error("validator admission readiness challenge signature is invalid");
  }
  return structuredClone(value);
}

function candidateResponsePayload(context, challenge) {
  return { challengeHash: challenge.challengeHash, contextHash: context.contextHash,
    format: "nir-validator-admission-readiness-candidate-response-v1",
    observer: challenge.observer, transportAddress: context.transport.address, version: 1 };
}

export function validatorAdmissionReadinessTransportSigningInput({ challenge, context,
  validators } = {}) {
  const verifiedContext = verifyValidatorAdmissionReadinessContext(context);
  const verifiedChallenge = verifyValidatorAdmissionReadinessChallenge(challenge,
    { context: verifiedContext, validators });
  const signed = candidateResponsePayload(verifiedContext, verifiedChallenge);
  const responseHash = hashObject({ challenge: verifiedChallenge, context: verifiedContext,
    ...signed }, "VALIDATOR_READY_RESPONSE_HASH_V1");
  return { challenge: verifiedChallenge, context: verifiedContext, responseHash,
    signingInput: { ...signed, responseHash } };
}

export function validatorAdmissionReadinessConsensusSigningInput({ transportResponse,
  validators } = {}) {
  const verifiedTransportResponse = verifyValidatorAdmissionReadinessCandidateTransportResponse(
    transportResponse, { validators });
  const signed = candidateResponsePayload(verifiedTransportResponse.context,
    verifiedTransportResponse.challenge);
  return { signingInput: { ...signed, responseHash: verifiedTransportResponse.responseHash,
    transportSignature: verifiedTransportResponse.transportSignature },
  transportResponse: verifiedTransportResponse };
}

export function createValidatorAdmissionReadinessCandidateResponse({ challenge, context,
  candidateWallet, transportWallet, validators } = {}) {
  const prepared = validatorAdmissionReadinessTransportSigningInput({ challenge, context,
    validators });
  const verifiedContext = prepared.context;
  const verifiedChallenge = prepared.challenge;
  if (transportWallet?.address !== verifiedContext.transport.address ||
      transportWallet?.publicKey !== verifiedContext.transport.publicKey) {
    throw new Error("validator admission readiness transport wallet is mismatched");
  }
  if (candidateWallet?.address !== verifiedContext.candidate.address ||
      candidateWallet?.publicKey !== verifiedContext.candidate.publicKey) {
    throw new Error("validator admission readiness consensus wallet is mismatched");
  }
  const transportSignature = signObject(prepared.signingInput, transportWallet,
    VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN);
  const transportResponse = verifyValidatorAdmissionReadinessCandidateTransportResponse({
    challenge: verifiedChallenge, context: verifiedContext, ...prepared.signingInput,
    transportSignature,
  }, { validators });
  const consensus = validatorAdmissionReadinessConsensusSigningInput({ transportResponse,
    validators });
  return { ...transportResponse, consensusSignature: signObject(consensus.signingInput, candidateWallet,
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN) };
}

export function verifyValidatorAdmissionReadinessCandidateTransportResponse(value,
  { validators } = {}) {
  exact(value, ["challenge", "challengeHash", "context", "contextHash", "format", "observer",
    "responseHash", "transportAddress", "transportSignature", "version"],
  "validator admission readiness candidate transport response");
  const context = verifyValidatorAdmissionReadinessContext(value.context);
  const challenge = verifyValidatorAdmissionReadinessChallenge(value.challenge,
    { context, validators });
  const signed = candidateResponsePayload(context, challenge);
  const responseHash = hashObject({ challenge, context, ...signed },
    "VALIDATOR_READY_RESPONSE_HASH_V1");
  if (canonicalJson(Object.fromEntries(Object.keys(signed).map((key) => [key, value[key]]))) !==
        canonicalJson(signed) || value.challengeHash !== challenge.challengeHash ||
      value.contextHash !== context.contextHash || value.observer !== challenge.observer ||
      value.transportAddress !== context.transport.address || value.responseHash !== responseHash ||
      !canonicalSignature(value.transportSignature) ||
      !verifyObject({ ...signed, responseHash }, value.transportSignature,
        context.transport.publicKey, VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN)) {
    throw new Error("validator admission readiness candidate transport response is invalid");
  }
  return structuredClone(value);
}

export function verifyValidatorAdmissionReadinessCandidateResponse(value, { validators } = {}) {
  exact(value, ["challenge", "challengeHash", "consensusSignature", "context", "contextHash",
    "format", "observer", "responseHash", "transportAddress", "transportSignature", "version"],
  "validator admission readiness candidate response");
  const { consensusSignature, ...transportValue } = value;
  const transportResponse = verifyValidatorAdmissionReadinessCandidateTransportResponse(
    transportValue, { validators });
  const signed = candidateResponsePayload(transportResponse.context, transportResponse.challenge);
  if (!canonicalSignature(consensusSignature) ||
      !verifyObject({ ...signed, responseHash: transportResponse.responseHash,
        transportSignature: transportResponse.transportSignature },
        consensusSignature, transportResponse.context.candidate.publicKey,
        VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN)) {
    throw new Error("validator admission readiness candidate response is invalid");
  }
  return structuredClone(value);
}

function observation(context) {
  return validatorAdmissionObservationPayload({ admissionId: context.admissionId,
    chainIdentityGenesisHash: context.chainIdentityGenesisHash, endpoint: context.endpoint,
    expiresAtHeight: context.expiresAtHeight, networkId: context.networkId, nonce: context.nonce,
    observedHeight: context.checkpoint.height,
    tlsCertificateSha256: context.tlsCertificateSha256,
    transportAddress: context.transport.address,
    validatorSetId: context.checkpoint.validatorSetId });
}

function observerResultPayload(response, observationHash) {
  return { challengeHash: response.challengeHash, contextHash: response.contextHash,
    observationHash, responseHash: response.responseHash, validator: response.observer };
}

export function createValidatorAdmissionReadinessReceipt({ candidateResponse, observerWallet,
  validators } = {}) {
  const response = verifyValidatorAdmissionReadinessCandidateResponse(candidateResponse,
    { validators });
  if (response.observer !== observerWallet?.address) {
    throw new Error("validator admission readiness receipt observer is mismatched");
  }
  const observationAttestation = { signature: signObject(observation(response.context),
    observerWallet, VALIDATOR_ADMISSION_READINESS_OBSERVATION_DOMAIN),
  validator: observerWallet.address };
  const observationHash = hashObject(observation(response.context),
    "VALIDATOR_READY_OBSERVATION_HASH_V1");
  const resultSignature = signObject(observerResultPayload(response, observationHash),
    observerWallet, VALIDATOR_ADMISSION_READINESS_OBSERVER_RESULT_DOMAIN);
  const payload = { candidateResponse: response,
    format: "nir-validator-admission-readiness-receipt-v1", observationAttestation,
    resultSignature, status: "candidate-observed", version: 1 };
  return { ...payload, receiptHash: hashObject(payload, "VALIDATOR_READY_RECEIPT_V1") };
}

export function verifyValidatorAdmissionReadinessReceipt(value, { context = null,
  validators } = {}) {
  exact(value, ["candidateResponse", "format", "observationAttestation", "receiptHash",
    "resultSignature", "status", "version"], "validator admission readiness receipt");
  const response = verifyValidatorAdmissionReadinessCandidateResponse(value.candidateResponse,
    { validators });
  const verifiedContext = context === null ? response.context
    : verifyValidatorAdmissionReadinessContext(context);
  const members = activeValidators(validators, verifiedContext);
  exact(value.observationAttestation, ["signature", "validator"],
    "validator admission readiness observation attestation");
  const observer = members.find(({ address }) => address === value.observationAttestation.validator);
  const observationValue = observation(verifiedContext);
  const observationHash = hashObject(observationValue, "VALIDATOR_READY_OBSERVATION_HASH_V1");
  const { receiptHash, ...payload } = value;
  if (value.format !== "nir-validator-admission-readiness-receipt-v1" || value.version !== 1 ||
      value.status !== "candidate-observed" ||
      canonicalJson(response.context) !== canonicalJson(verifiedContext) ||
      response.observer !== value.observationAttestation.validator || !observer ||
      !canonicalSignature(value.observationAttestation.signature) ||
      !verifyObject(observationValue, value.observationAttestation.signature,
        observer.publicKey, VALIDATOR_ADMISSION_READINESS_OBSERVATION_DOMAIN) ||
      !canonicalSignature(value.resultSignature) ||
      !verifyObject(observerResultPayload(response, observationHash), value.resultSignature,
        observer.publicKey, VALIDATOR_ADMISSION_READINESS_OBSERVER_RESULT_DOMAIN) ||
      receiptHash !== hashObject(payload, "VALIDATOR_READY_RECEIPT_V1")) {
    throw new Error("validator admission readiness receipt is invalid");
  }
  return structuredClone(value);
}

export function createValidatorAdmissionReadinessCertificate({ context, receipts,
  validators } = {}) {
  const verifiedContext = verifyValidatorAdmissionReadinessContext(context);
  const members = activeValidators(validators, verifiedContext);
  const quorum = Math.floor(members.length * 2 / 3) + 1;
  if (!Array.isArray(receipts) || receipts.length !== quorum) {
    throw new Error("validator admission readiness certificate requires an exact quorum");
  }
  const verifiedReceipts = receipts.map((receipt) => verifyValidatorAdmissionReadinessReceipt(
    receipt, { context: verifiedContext, validators: members })).sort((left, right) =>
    left.observationAttestation.validator.localeCompare(right.observationAttestation.validator));
  if (new Set(verifiedReceipts.map(({ observationAttestation }) =>
    observationAttestation.validator)).size !== quorum) {
    throw new Error("validator admission readiness certificate observers are duplicated");
  }
  const readinessAttestations = verifiedReceipts.map(({ observationAttestation }) =>
    structuredClone(observationAttestation));
  const payload = { context: verifiedContext,
    format: "nir-validator-admission-readiness-certificate-v1", readinessAttestations,
    receipts: verifiedReceipts, status: "certificate-collected", version: 1 };
  return { ...payload, certificateHash: hashObject(payload,
    "VALIDATOR_READY_CERTIFICATE_V1") };
}

export function verifyValidatorAdmissionReadinessCertificate(value, { validators } = {}) {
  exact(value, ["certificateHash", "context", "format", "readinessAttestations", "receipts",
    "status", "version"], "validator admission readiness certificate");
  const expected = createValidatorAdmissionReadinessCertificate({ context: value.context,
    receipts: value.receipts, validators });
  if (value.format !== "nir-validator-admission-readiness-certificate-v1" || value.version !== 1 ||
      value.status !== "certificate-collected" || canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error("validator admission readiness certificate is invalid");
  }
  return structuredClone(value);
}

import { MAX_VALIDATORS, SIGNATURE_ALGORITHM, SUPPORTED_PROTOCOL_VERSIONS } from "./constants.mjs";
import { addressFromPublicKey, canonicalJson, hashObject, signObject, verifyObject } from "./crypto.mjs";
import {
  VALIDATOR_ADMISSION_DELAY_BLOCKS, VALIDATOR_ADMISSION_EXPIRY_BLOCKS,
  validatorAdmissionRank,
} from "./validator-admission.mjs";
import { validatorSetId } from "./validator-rotation.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const OPERATOR = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const MAX_BYTES = 128 * 1024;
export const MAX_VALIDATOR_CANDIDATE_QUORUM_PROOF_BYTES =
  MAX_BYTES + MAX_VALIDATORS * 12 * 1024;
const ADMISSION_FIELDS = ["address", "admissionId", "algorithm", "eligibleHeight", "endpoint",
  "expiryHeight", "legacy", "observedHeight", "operatorId", "publicKey", "rank", "readiness",
  "readinessCertificateHash", "readinessExpiresHeight", "readinessValidatorSetId",
  "submittedHeight", "tlsCertificateSha256", "transport"];

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}
function nullableHeight(value) { return value === null || Number.isSafeInteger(value) && value >= 0; }
function normalizeAdmission(value, networkId) {
  if (value === null) return null;
  exact(value, ADMISSION_FIELDS, "validator candidate admission");
  if (!ADDRESS.test(value.address ?? "") || !HASH.test(value.admissionId ?? "") ||
      value.algorithm !== SIGNATURE_ALGORITHM || addressFromPublicKey(value.publicKey) !== value.address ||
      !OPERATOR.test(value.operatorId ?? "") || !HASH.test(value.rank ?? "") ||
      !Number.isSafeInteger(value.submittedHeight) || value.submittedHeight < 1 ||
      value.eligibleHeight !== value.submittedHeight + VALIDATOR_ADMISSION_DELAY_BLOCKS ||
      value.expiryHeight !== value.eligibleHeight + VALIDATOR_ADMISSION_EXPIRY_BLOCKS ||
      typeof value.legacy !== "boolean" || typeof value.readiness !== "boolean" ||
      !nullableHeight(value.observedHeight) || !nullableHeight(value.readinessExpiresHeight) ||
      (value.readinessCertificateHash !== null && !HASH.test(value.readinessCertificateHash ?? "")) ||
      (value.readinessValidatorSetId !== null && !HASH.test(value.readinessValidatorSetId ?? "")) ||
      value.rank !== validatorAdmissionRank({ address: value.address, admissionId: value.admissionId,
        networkId, operatorId: value.operatorId, publicKey: value.publicKey,
        submittedHeight: value.submittedHeight })) {
    throw new Error("validator candidate admission is invalid");
  }
  if (value.endpoint !== null) {
    let endpoint;
    try { endpoint = new URL(value.endpoint); } catch { throw new Error("validator candidate endpoint is invalid"); }
    if (endpoint.protocol !== "https:" || endpoint.origin !== value.endpoint || endpoint.pathname !== "/" ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("validator candidate endpoint is invalid");
    }
  }
  if (value.tlsCertificateSha256 !== null && !HASH.test(value.tlsCertificateSha256 ?? "")) {
    throw new Error("validator candidate TLS pin is invalid");
  }
  if (value.transport !== null) {
    exact(value.transport, ["address", "algorithm", "publicKey"], "validator candidate transport");
    if (!ADDRESS.test(value.transport.address ?? "") || value.transport.algorithm !== SIGNATURE_ALGORITHM ||
        addressFromPublicKey(value.transport.publicKey) !== value.transport.address) {
      throw new Error("validator candidate transport identity is invalid");
    }
  }
  if (value.transport?.address === value.address ||
      value.readiness !== (value.readinessCertificateHash !== null) ||
      value.readiness !== (value.readinessExpiresHeight !== null) ||
      value.readiness !== (value.readinessValidatorSetId !== null) ||
      value.readiness !== (value.observedHeight !== null)) {
    throw new Error("validator candidate readiness state is inconsistent");
  }
  if (value.readiness && (!Number.isSafeInteger(value.observedHeight) ||
      value.readinessExpiresHeight <= value.observedHeight ||
      value.readinessExpiresHeight > value.observedHeight + 16 || value.endpoint === null ||
      value.tlsCertificateSha256 === null || value.transport === null) ||
      !value.readiness && value.legacy && (value.endpoint !== null ||
        value.tlsCertificateSha256 !== null || value.transport !== null) ||
      !value.readiness && !value.legacy && (value.endpoint === null ||
        value.tlsCertificateSha256 === null || value.transport === null)) {
    throw new Error("validator candidate readiness fields are invalid");
  }
  return structuredClone(value);
}
function normalizeStatement(value) {
  exact(value, ["accountStateRoot", "address", "admission", "format", "height", "networkId", "protocolVersion",
    "queuePosition", "queueSize", "stateRoot", "tipHash", "validatorSetId", "version"],
  "validator candidate statement");
  if (value.format !== "nir-validator-candidate-proof-v1" || value.version !== 1 ||
      !ADDRESS.test(value.address ?? "") || typeof value.networkId !== "string" ||
      value.networkId.length < 3 || value.networkId.length > 128 ||
      !Number.isSafeInteger(value.height) || value.height < 1 ||
      !SUPPORTED_PROTOCOL_VERSIONS.includes(value.protocolVersion) || value.protocolVersion < 31 ||
      !HASH.test(value.accountStateRoot ?? "") || !HASH.test(value.stateRoot ?? "") || !HASH.test(value.tipHash ?? "") ||
      !HASH.test(value.validatorSetId ?? "") || !Number.isSafeInteger(value.queueSize) ||
      value.queueSize < 0 || value.queueSize > 256 ||
      (value.queuePosition !== null && (!Number.isSafeInteger(value.queuePosition) ||
        value.queuePosition < 0 || value.queuePosition >= value.queueSize))) {
    throw new Error("validator candidate statement is invalid");
  }
  const admission = normalizeAdmission(value.admission, value.networkId);
  if ((admission === null) !== (value.queuePosition === null) ||
      admission !== null && (admission.address !== value.address ||
        admission.submittedHeight > value.height ||
        admission.observedHeight !== null && admission.observedHeight > value.height)) {
    throw new Error("validator candidate queue membership is inconsistent");
  }
  return { ...structuredClone(value), admission };
}

export function createValidatorCandidateProof({ accountStateRoot, address, admission, height, networkId,
  protocolVersion, queuePosition, queueSize, stateRoot, tipHash, validators, wallet }) {
  const statement = normalizeStatement({ accountStateRoot, address, admission: structuredClone(admission),
    format: "nir-validator-candidate-proof-v1", height, networkId, protocolVersion,
    queuePosition, queueSize, stateRoot, tipHash, validatorSetId: validatorSetId(validators), version: 1 });
  if (!validators.some((member) => member.address === wallet?.address &&
      member.publicKey === wallet.publicKey)) throw new Error("candidate proof signer is not active");
  const statementHash = hashObject(statement, "VALIDATOR_CANDIDATE_STATEMENT_V1");
  return { ...statement, attestation: { signature: signObject({ statementHash }, wallet,
    "VALIDATOR_CANDIDATE_APPROVAL_V1"), validator: wallet.address }, statementHash };
}

export function verifyValidatorCandidateProofCandidate(proof, { expectedAddress,
  expectedNetworkId, expectedValidator, minimumHeight = 1, trustedValidators } = {}) {
  if (!proof || Buffer.byteLength(canonicalJson(proof)) > MAX_BYTES) throw new Error("candidate proof is too large");
  exact(proof, ["accountStateRoot", "address", "admission", "attestation", "format", "height", "networkId",
    "protocolVersion", "queuePosition", "queueSize", "stateRoot", "statementHash", "tipHash",
    "validatorSetId", "version"], "validator candidate proof");
  exact(proof.attestation, ["signature", "validator"], "validator candidate attestation");
  const { attestation, statementHash, ...unsigned } = proof;
  const statement = normalizeStatement(unsigned);
  const signer = trustedValidators?.find((member) => member.address === expectedValidator);
  if (!signer || attestation.validator !== expectedValidator || statement.address !== expectedAddress ||
      statement.networkId !== expectedNetworkId || statement.height < minimumHeight ||
      statement.validatorSetId !== validatorSetId(trustedValidators) ||
      statementHash !== hashObject(statement, "VALIDATOR_CANDIDATE_STATEMENT_V1") ||
      !verifyObject({ statementHash }, attestation.signature, signer.publicKey,
        "VALIDATOR_CANDIDATE_APPROVAL_V1")) throw new Error("validator candidate proof is invalid");
  return { statement, attestation: structuredClone(attestation) };
}

export function assembleValidatorCandidateProof(candidates, options = {}) {
  if (!Array.isArray(candidates) || !Array.isArray(options.trustedValidators) ||
      options.trustedValidators.length < 4 || options.trustedValidators.length > MAX_VALIDATORS ||
      candidates.length > MAX_VALIDATORS) {
    throw new Error("validator candidate proof candidates are invalid");
  }
  const verified = candidates.map((proof) => verifyValidatorCandidateProofCandidate(proof, {
    ...options, expectedValidator: proof?.attestation?.validator,
  }));
  const groups = new Map();
  const signerStatements = new Map();
  for (const item of verified) {
    const key = canonicalJson(item.statement); const group = groups.get(key) ?? { statement: item.statement, attestations: [] };
    const previous = signerStatements.get(item.attestation.validator);
    if (previous !== undefined && previous !== key) {
      throw new Error("validator candidate proof contains signer equivocation");
    }
    signerStatements.set(item.attestation.validator, key);
    if (!group.attestations.some(({ validator }) => validator === item.attestation.validator)) {
      group.attestations.push(item.attestation);
    }
    groups.set(key, group);
  }
  const quorum = Math.floor(options.trustedValidators.length * 2 / 3) + 1;
  const quorumGroups = [...groups.values()].filter(({ attestations }) => attestations.length >= quorum);
  if (quorumGroups.length !== 1) throw new Error(quorumGroups.length > 1
    ? "validator candidate proof has conflicting quorums"
    : "validator candidate proof quorum is not reached");
  const selected = quorumGroups[0];
  return { ...selected.statement, attestations: selected.attestations.sort((a, b) =>
    a.validator.localeCompare(b.validator)), statementHash:
    hashObject(selected.statement, "VALIDATOR_CANDIDATE_STATEMENT_V1") };
}

export function verifyValidatorCandidateProof(proof, options = {}) {
  if (!proof || Buffer.byteLength(canonicalJson(proof)) >
      MAX_VALIDATOR_CANDIDATE_QUORUM_PROOF_BYTES || !Array.isArray(proof.attestations) ||
      proof.attestations.length > (options.trustedValidators?.length ?? 0)) {
    throw new Error("validator candidate proof quorum envelope is invalid");
  }
  const { attestations, ...base } = proof;
  const candidates = attestations.map((attestation) => ({ ...base, attestation }));
  const assembled = assembleValidatorCandidateProof(candidates, options);
  if (canonicalJson(assembled) !== canonicalJson(proof)) {
    throw new Error("validator candidate proof quorum is non-canonical");
  }
  return structuredClone(assembled);
}

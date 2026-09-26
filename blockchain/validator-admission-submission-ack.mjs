import { signObject, verifyObject } from "./crypto.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const STATUS = new Set(["known", "queued"]);

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function payload(value) {
  exact(value, ["attemptNonce", "candidateContextHash", "chainIdentityGenesisHash", "format",
    "networkId", "status", "transactionId", "validator", "version"],
  "validator admission submission acknowledgement payload");
  if (value.format !== "nir-validator-admission-submission-ack-v1" || value.version !== 1 ||
      typeof value.networkId !== "string" || value.networkId.length < 3 || value.networkId.length > 128 ||
      !HASH.test(value.attemptNonce ?? "") || !HASH.test(value.candidateContextHash ?? "") ||
      !HASH.test(value.chainIdentityGenesisHash ?? "") || !HASH.test(value.transactionId ?? "") ||
      !ADDRESS.test(value.validator ?? "") || !STATUS.has(value.status)) {
    throw new Error("validator admission submission acknowledgement payload is invalid");
  }
  return structuredClone(value);
}

export function createValidatorAdmissionSubmissionAck(fields, wallet) {
  const normalized = payload({ ...fields, format: "nir-validator-admission-submission-ack-v1",
    validator: wallet.address, version: 1 });
  return { ...normalized,
    signature: signObject(normalized, wallet, "VALIDATOR_ADMISSION_SUBMISSION_ACK_V1") };
}

export function verifyValidatorAdmissionSubmissionAck(value, {
  attemptNonce, candidateContextHash, chainIdentityGenesisHash, networkId, transactionId, validator,
}) {
  exact(value, ["attemptNonce", "candidateContextHash", "chainIdentityGenesisHash", "format",
    "networkId", "signature", "status", "transactionId", "validator", "version"],
  "validator admission submission acknowledgement");
  const { signature, ...unsigned } = value;
  const normalized = payload(unsigned);
  if (normalized.attemptNonce !== attemptNonce || normalized.candidateContextHash !== candidateContextHash ||
      normalized.chainIdentityGenesisHash !== chainIdentityGenesisHash || normalized.networkId !== networkId ||
      normalized.transactionId !== transactionId || normalized.validator !== validator.address ||
      typeof signature !== "string" || signature.length > 7_000 ||
      !verifyObject(normalized, signature, validator.publicKey,
        "VALIDATOR_ADMISSION_SUBMISSION_ACK_V1")) {
    throw new Error("validator admission submission acknowledgement is forged or mismatched");
  }
  return structuredClone(value);
}

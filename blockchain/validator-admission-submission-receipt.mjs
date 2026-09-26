import { canonicalJson, hashObject } from "./crypto.mjs";
import { peerRegistryHash } from "./peer-registry.mjs";
import { verifyValidatorAdmissionSubmissionAck }
  from "./validator-admission-submission-ack.mjs";
import { validateValidatorCandidateContext } from "./validator-candidate-context.mjs";

const HASH = /^[0-9a-f]{64}$/;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

export function verifyValidatorAdmissionSubmissionReceipt(value, {
  joinPlan, plan, signed, signingPackage,
}) {
  exact(value, ["acknowledgements", "attemptNonce", "attemptedAt", "candidateContext",
    "chainIdentityGenesisHash", "format", "networkId", "packageHash", "peerRegistry",
    "peerOutcomes", "previousReceiptHash", "quorumRequired", "receiptHash", "sequence", "status",
    "transactionId", "version"], "validator admission submission receipt");
  const { receiptHash, ...payload } = value;
  if (value.format !== "nir-validator-admission-submission-v1" || value.version !== 1 ||
      value.networkId !== plan.networkId ||
      value.chainIdentityGenesisHash !== plan.expectedChainIdentityGenesisHash ||
      value.packageHash !== signingPackage.packageHash || value.transactionId !== signed.transactionId ||
      !HASH.test(value.attemptNonce ?? "") || !HASH.test(value.previousReceiptHash ?? "") ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !Number.isSafeInteger(value.attemptedAt) || value.attemptedAt < 0 ||
      receiptHash !== hashObject(payload, "VALIDATOR_ADMISSION_SUBMISSION_V1")) {
    throw new Error("validator admission submission receipt is invalid or mismatched");
  }
  const context = validateValidatorCandidateContext(value.candidateContext, joinPlan,
    { now: value.candidateContext?.syncedAt });
  const validators = context.checkpointTrustPackage.validators;
  const validatorMap = new Map(validators.map((validator) => [validator.address, validator]));
  const peers = value.peerRegistry?.peers;
  if (!Array.isArray(peers) || validators.length !== validatorMap.size || peers.length !== validators.length ||
      new Set(peers.map(({ validatorAddress }) => validatorAddress)).size !== validators.length ||
      peers.some(({ validatorAddress }) => !validatorMap.has(validatorAddress)) ||
      peerRegistryHash(value.peerRegistry) !==
        context.checkpointTrustPackage.finalityProof.header.peerRegistryHash ||
      value.quorumRequired !== Math.floor(validators.length * 2 / 3) + 1 ||
      !Array.isArray(value.acknowledgements) || !Array.isArray(value.peerOutcomes)) {
    throw new Error("validator admission submission receipt validator set is invalid");
  }
  const acknowledgements = new Map();
  for (const acknowledgement of value.acknowledgements) {
    const validator = validatorMap.get(acknowledgement?.validator);
    if (!validator || acknowledgements.has(validator.address)) {
      throw new Error("validator admission submission acknowledgement is duplicate or unknown");
    }
    verifyValidatorAdmissionSubmissionAck(acknowledgement, {
      attemptNonce: value.attemptNonce, candidateContextHash: context.contextHash,
      chainIdentityGenesisHash: plan.expectedChainIdentityGenesisHash,
      networkId: plan.networkId, transactionId: signed.transactionId, validator,
    });
    acknowledgements.set(validator.address, acknowledgement);
  }
  const outcomes = new Set();
  for (const outcome of value.peerOutcomes) {
    exact(outcome, ["status", "validatorAddress"], "validator admission submission outcome");
    const acknowledgement = acknowledgements.get(outcome.validatorAddress);
    if (!validatorMap.has(outcome.validatorAddress) || outcomes.has(outcome.validatorAddress) ||
        !["failed", "known", "queued"].includes(outcome.status) ||
        ((outcome.status === "known" || outcome.status === "queued") !== Boolean(acknowledgement)) ||
        (acknowledgement && acknowledgement.status !== outcome.status)) {
      throw new Error("validator admission submission outcome is invalid");
    }
    outcomes.add(outcome.validatorAddress);
  }
  const status = acknowledgements.size >= value.quorumRequired
    ? "submitted-to-quorum" : "partial-retryable";
  if (outcomes.size !== validators.length || value.status !== status) {
    throw new Error("validator admission submission receipt status is forged");
  }
  return { context, receipt: structuredClone(value), status };
}

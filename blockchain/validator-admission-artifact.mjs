import { transactionId } from "./chain.mjs";
import { MIN_TRANSFER_FEE } from "./constants.mjs";
import { canonicalJson, hashObject } from "./crypto.mjs";
import {
  MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES, validateValidatorCandidateContext,
} from "./validator-candidate-context.mjs";
import {
  VALIDATOR_ADMISSION_TRANSACTION_LIFETIME_BLOCKS, verifyValidatorAdmission,
} from "./validator-admission.mjs";
import { MIN_VALIDATOR_BOND } from "./validator-staking.mjs";

const MAX_ADMISSION_PACKAGE_BYTES = MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES + 1024 * 1024;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function admissionPublicPlan(plan) {
  return {
    candidateContextMaxWitnessAgeMs: plan.candidateContextMaxWitnessAgeMs,
    candidateContextMinimumCheckpointHeight: plan.candidateContextMinimumCheckpointHeight,
    candidateContextMinimumSequence: plan.candidateContextMinimumSequence,
    consensus: plan.consensus, endpoint: plan.endpoint,
    expectedChainIdentityGenesisHash: plan.expectedChainIdentityGenesisHash,
    expectedCheckpointPolicyId: plan.expectedCheckpointPolicyId, networkId: plan.networkId,
    operatorId: plan.operatorId, tlsCertificateSha256: plan.tlsCertificateSha256,
    transport: plan.transport,
  };
}

export function validateValidatorAdmissionSigningPackage(value, plan, { now = Date.now() } = {}) {
  exact(value, ["amount", "candidateContext", "candidateContextHash",
    "chainIdentityGenesisHash", "consensus", "endpoint", "fee", "format", "networkId",
    "nonce", "operatorId", "packageHash", "planCommitment", "referenceHeight",
    "tlsCertificateSha256", "transport", "validUntilHeight", "version"],
  "validator admission signing package");
  if (Buffer.byteLength(canonicalJson(value)) > MAX_ADMISSION_PACKAGE_BYTES) {
    throw new Error("validator admission signing package is too large");
  }
  const { packageHash, ...payload } = value;
  const context = validateValidatorCandidateContext(value.candidateContext, plan, { now });
  const balance = BigInt(context.account?.atomicBalance ?? "-1");
  if (plan.format !== "nir-validator-join-plan-v2" || plan.version !== 2 ||
      value.format !== "nir-validator-admission-signing-package-v1" || value.version !== 1 ||
      value.networkId !== plan.networkId ||
      value.chainIdentityGenesisHash !== plan.expectedChainIdentityGenesisHash ||
      value.planCommitment !== hashObject(admissionPublicPlan(plan), "VALIDATOR_ADMISSION_PLAN_V1") ||
      value.candidateContextHash !== context.contextHash ||
      canonicalJson(value.consensus) !== canonicalJson(plan.consensus) ||
      canonicalJson(value.transport) !== canonicalJson(plan.transport) ||
      value.endpoint !== plan.endpoint || value.operatorId !== plan.operatorId ||
      value.tlsCertificateSha256 !== plan.tlsCertificateSha256 ||
      context.protocolVersion !== 32 || context.status !== "not-admitted" ||
      context.admission !== null || context.queuePosition !== null ||
      context.address !== plan.consensus.address ||
      value.amount !== MIN_VALIDATOR_BOND.toString() || value.fee !== MIN_TRANSFER_FEE.toString() ||
      balance < MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE || context.bondAndFeeCovered !== true ||
      value.nonce !== context.account.nextNonce || !Number.isSafeInteger(value.nonce) || value.nonce < 0 ||
      value.referenceHeight !== context.checkpoint.height ||
      value.validUntilHeight !== context.checkpoint.height +
        VALIDATOR_ADMISSION_TRANSACTION_LIFETIME_BLOCKS ||
      packageHash !== hashObject(payload, "VALIDATOR_ADMISSION_PACKAGE_V1")) {
    throw new Error("validator admission signing package context or policy is invalid");
  }
  return structuredClone(value);
}

export function validateSignedValidatorAdmissionArtifact(signed, signingPackage, plan) {
  exact(signed, ["broadcast", "format", "packageHash", "transaction", "transactionId", "version"],
    "signed validator admission");
  const verified = verifyValidatorAdmission(signed.transaction, plan.networkId, {
    chainIdentityGenesisHash: plan.expectedChainIdentityGenesisHash,
    currentHeight: signingPackage.referenceHeight + 1, protocolVersion: 32,
  });
  const { signature: _signature, transportSignature: _transportSignature,
    ...unsigned } = signed.transaction;
  const expectedUnsigned = {
    algorithm: plan.consensus.algorithm, amount: signingPackage.amount,
    chainIdentityGenesisHash: signingPackage.chainIdentityGenesisHash,
    endpoint: signingPackage.endpoint, fee: signingPackage.fee,
    networkId: signingPackage.networkId, nonce: signingPackage.nonce,
    operatorId: signingPackage.operatorId, publicKey: plan.consensus.publicKey,
    referenceHeight: signingPackage.referenceHeight, sender: plan.consensus.address,
    tlsCertificateSha256: signingPackage.tlsCertificateSha256,
    transportAlgorithm: plan.transport.algorithm,
    transportPublicKey: plan.transport.publicKey, type: "validator-admission",
    validUntilHeight: signingPackage.validUntilHeight,
  };
  if (signed.broadcast !== false || signed.format !== "nir-signed-validator-admission-v1" ||
      signed.version !== 1 || signed.packageHash !== signingPackage.packageHash ||
      signed.transactionId !== transactionId(signed.transaction) ||
      canonicalJson(unsigned) !== canonicalJson(expectedUnsigned) ||
      verified.payload.sender !== plan.consensus.address ||
      verified.transport.address !== plan.transport.address ||
      verified.payload.publicKey !== plan.consensus.publicKey ||
      verified.payload.transportPublicKey !== plan.transport.publicKey ||
      verified.payload.nonce !== signingPackage.nonce ||
      verified.payload.referenceHeight !== signingPackage.referenceHeight ||
      verified.payload.validUntilHeight !== signingPackage.validUntilHeight) {
    throw new Error("signed validator admission identity or package binding is invalid");
  }
  return structuredClone(signed);
}

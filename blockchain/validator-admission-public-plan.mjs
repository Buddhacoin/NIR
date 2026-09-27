import { createPublicKey } from "node:crypto";

import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import { addressFromPublicKey, hashObject } from "./crypto.mjs";

const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const OPERATOR = /^[a-z0-9][a-z0-9._-]{2,63}$/;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function identity(value, label) {
  exact(value, ["address", "algorithm", "label", "publicKey"], label);
  let publicKey;
  try {
    if (typeof value.publicKey !== "string" || value.publicKey.length < 1 ||
        value.publicKey.length > 8_000 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          value.publicKey,
        ) || Buffer.from(value.publicKey, "base64").toString("base64") !== value.publicKey) {
      throw new Error("non-canonical public key");
    }
    publicKey = createPublicKey({ key: Buffer.from(value.publicKey, "base64"),
      format: "der", type: "spki" });
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (value.algorithm !== SIGNATURE_ALGORITHM ||
      publicKey.asymmetricKeyType !== SIGNATURE_ALGORITHM ||
      addressFromPublicKey(value.publicKey ?? "") !== value.address ||
      typeof value.label !== "string" || value.label.length < 1 || value.label.length > 256 ||
      value.label.normalize("NFC") !== value.label) {
    throw new Error(`${label} is invalid`);
  }
  return structuredClone(value);
}

function endpoint(value) {
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error("validator admission public plan endpoint is invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search ||
      parsed.hash || parsed.pathname !== "/" || parsed.origin !== value) {
    throw new Error("validator admission public plan endpoint is invalid");
  }
  return value;
}

export function validatorAdmissionPublicPlan(plan) {
  return {
    candidateContextMaxWitnessAgeMs: plan.candidateContextMaxWitnessAgeMs,
    candidateContextMinimumCheckpointHeight: plan.candidateContextMinimumCheckpointHeight,
    candidateContextMinimumSequence: plan.candidateContextMinimumSequence,
    consensus: structuredClone(plan.consensus), endpoint: plan.endpoint,
    expectedChainIdentityGenesisHash: plan.expectedChainIdentityGenesisHash,
    expectedCheckpointPolicyId: plan.expectedCheckpointPolicyId, networkId: plan.networkId,
    operatorId: plan.operatorId, tlsCertificateSha256: plan.tlsCertificateSha256,
    transport: structuredClone(plan.transport),
  };
}

export function validatorAdmissionPlanCommitment(plan) {
  return hashObject(validatorAdmissionPublicPlan(plan), "VALIDATOR_ADMISSION_PLAN_V1");
}

export function createValidatorAdmissionPublicPlan(plan) {
  const payload = validatorAdmissionPublicPlan(plan);
  return { ...payload, format: "nir-validator-admission-public-plan-v1",
    planCommitment: hashObject(payload, "VALIDATOR_ADMISSION_PLAN_V1"), version: 1 };
}

export function validateValidatorAdmissionPublicPlan(value) {
  exact(value, ["candidateContextMaxWitnessAgeMs", "candidateContextMinimumCheckpointHeight",
    "candidateContextMinimumSequence", "consensus", "endpoint",
    "expectedChainIdentityGenesisHash", "expectedCheckpointPolicyId", "format", "networkId",
    "operatorId", "planCommitment", "tlsCertificateSha256", "transport", "version"],
  "validator admission public plan");
  identity(value.consensus, "validator admission consensus identity");
  identity(value.transport, "validator admission transport identity");
  const { format: _format, planCommitment, version: _version, ...payload } = value;
  if (value.format !== "nir-validator-admission-public-plan-v1" || value.version !== 1 ||
      !NETWORK.test(value.networkId ?? "") || !OPERATOR.test(value.operatorId ?? "") ||
      !HASH.test(value.expectedChainIdentityGenesisHash ?? "") ||
      !TAGGED_HASH.test(value.expectedCheckpointPolicyId ?? "") ||
      !HASH.test(value.tlsCertificateSha256 ?? "") ||
      !Number.isSafeInteger(value.candidateContextMaxWitnessAgeMs) ||
      value.candidateContextMaxWitnessAgeMs < 1 ||
      value.candidateContextMaxWitnessAgeMs > 86_400_000 ||
      !Number.isSafeInteger(value.candidateContextMinimumCheckpointHeight) ||
      value.candidateContextMinimumCheckpointHeight < 1 ||
      !Number.isSafeInteger(value.candidateContextMinimumSequence) ||
      value.candidateContextMinimumSequence < 0 || endpoint(value.endpoint) !== value.endpoint ||
      value.consensus.address === value.transport.address ||
      planCommitment !== hashObject(payload, "VALIDATOR_ADMISSION_PLAN_V1")) {
    throw new Error("validator admission public plan is invalid");
  }
  return structuredClone(value);
}

export function validatorAdmissionJoinPlan(publicPlan) {
  const value = validateValidatorAdmissionPublicPlan(publicPlan);
  delete value.planCommitment;
  value.format = "nir-validator-join-plan-v2";
  value.version = 2;
  return value;
}

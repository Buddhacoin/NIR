import {
  canonicalJson, hashObject, signObject, verifyObject,
} from "./crypto.mjs";
import { validateCheckpointWitnessPolicy } from "./checkpoint-trust-package.mjs";

const FORMAT = "nir-checkpoint-witness-policy-transition-v1";
const HASH = /^sha3-256:[0-9a-f]{64}$/;
const OPERATOR = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const MIN_CHECKPOINT_POLICY_ROTATION_HEIGHT_DELAY = 10;
export const MIN_CHECKPOINT_POLICY_ROTATION_SEQUENCE_DELAY = 2;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function canonicalBase64(value, label) {
  if (typeof value !== "string" || value.length > 32 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 1 || bytes.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
}

function transitionPayload(value) {
  exact(value, ["activationHeight", "activationSequence", "chainIdentityGenesisHash",
    "createdHeight", "createdPackageHash", "createdSequence", "format", "networkId",
    "newGeneration", "newPolicyId", "oldGeneration", "oldPolicyId", "overlapOperators",
    "version"], "checkpoint witness policy transition");
  if (value.format !== FORMAT || value.version !== 1 ||
      typeof value.networkId !== "string" || value.networkId.length < 2 || value.networkId.length > 64 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/.test(value.networkId) ||
      !/^[0-9a-f]{64}$/.test(value.chainIdentityGenesisHash ?? "") ||
      !HASH.test(value.oldPolicyId ?? "") || !HASH.test(value.newPolicyId ?? "") ||
      !HASH.test(value.createdPackageHash ?? "") || value.oldPolicyId === value.newPolicyId ||
      !Number.isSafeInteger(value.oldGeneration) || value.oldGeneration < 0 ||
      !Number.isSafeInteger(value.newGeneration) || value.newGeneration !== value.oldGeneration + 1 ||
      !Number.isSafeInteger(value.createdSequence) || value.createdSequence < 0 ||
      !Number.isSafeInteger(value.createdHeight) || value.createdHeight < 1 ||
      !Number.isSafeInteger(value.activationSequence) ||
      value.activationSequence < value.createdSequence + MIN_CHECKPOINT_POLICY_ROTATION_SEQUENCE_DELAY ||
      !Number.isSafeInteger(value.activationHeight) ||
      value.activationHeight < value.createdHeight + MIN_CHECKPOINT_POLICY_ROTATION_HEIGHT_DELAY ||
      !Array.isArray(value.overlapOperators) || value.overlapOperators.length < 1 ||
      value.overlapOperators.some((operatorId, index) => !OPERATOR.test(operatorId ?? "") ||
        (index > 0 && value.overlapOperators[index - 1] >= operatorId))) {
    throw new Error("checkpoint witness policy transition is invalid");
  }
  return structuredClone(value);
}

function approvalPayload(value) {
  exact(value, ["address", "operatorId", "signature"], "checkpoint policy signature");
  if (!/^nir1[0-9a-f]{64}$/.test(value.address ?? "") || !OPERATOR.test(value.operatorId ?? "")) {
    throw new Error("checkpoint policy signature identity is invalid");
  }
  canonicalBase64(value.signature, "checkpoint policy signature");
  return structuredClone(value);
}

function coreFor({ activationHeight, activationSequence, createdHeight, createdPackageHash,
  createdSequence, newPolicy, oldPolicy }) {
  if (oldPolicy.networkId !== newPolicy.networkId ||
      oldPolicy.chainIdentityGenesisHash !== newPolicy.chainIdentityGenesisHash) {
    throw new Error("checkpoint witness policies do not share one chain identity");
  }
  const overlapOperators = oldPolicy.witnesses.filter((oldWitness) =>
    newPolicy.witnesses.some((newWitness) => newWitness.operatorId === oldWitness.operatorId &&
      newWitness.address === oldWitness.address && newWitness.publicKey === oldWitness.publicKey))
    .map(({ operatorId }) => operatorId).sort(compareText);
  const requiredOverlap = Math.max(1,
    Math.ceil(Math.min(oldPolicy.witnesses.length, newPolicy.witnesses.length) / 3));
  if (overlapOperators.length < requiredOverlap) {
    throw new Error("checkpoint witness policy transition lacks one-third key continuity");
  }
  return transitionPayload({ activationHeight, activationSequence,
    chainIdentityGenesisHash: oldPolicy.chainIdentityGenesisHash, createdHeight,
    createdPackageHash, createdSequence, format: FORMAT, networkId: oldPolicy.networkId,
    newGeneration: newPolicy.generation, newPolicyId: newPolicy.policyId,
    oldGeneration: oldPolicy.generation, oldPolicyId: oldPolicy.policyId,
    overlapOperators, version: 1 });
}

function signer(wallets, witness, payload, domain) {
  const wallet = wallets.find((candidate) => candidate.address === witness.address &&
    candidate.publicKey === witness.publicKey);
  if (!wallet) return null;
  return { address: witness.address, operatorId: witness.operatorId,
    signature: signObject(payload, wallet, domain) };
}

export function createCheckpointWitnessPolicyTransition({ activationHeight, activationSequence,
  createdHeight, createdPackageHash, createdSequence, newPolicy: newPolicyValue,
  newSignerWallets, oldPolicy: oldPolicyValue, oldSignerWallets }) {
  const oldPolicy = validateCheckpointWitnessPolicy(oldPolicyValue);
  const newPolicy = validateCheckpointWitnessPolicy(newPolicyValue);
  if (oldPolicy.networkId !== newPolicy.networkId ||
      oldPolicy.chainIdentityGenesisHash !== newPolicy.chainIdentityGenesisHash) {
    throw new Error("checkpoint witness policies do not share one chain identity");
  }
  const payload = coreFor({ activationHeight, activationSequence, createdHeight,
    createdPackageHash, createdSequence, newPolicy, oldPolicy });
  const oldApprovals = oldPolicy.witnesses.map((witness) =>
    signer(oldSignerWallets ?? [], witness, payload, "CHECKPOINT_POLICY_OLD_V1"))
    .filter(Boolean).sort((left, right) => compareText(left.operatorId, right.operatorId));
  const newPossessionProofs = newPolicy.witnesses.map((witness) =>
    signer(newSignerWallets ?? [], witness, payload, "CHECKPOINT_POLICY_NEW_V1"))
    .filter(Boolean).sort((left, right) => compareText(left.operatorId, right.operatorId));
  return validateCheckpointWitnessPolicyTransition({ ...payload, oldApprovals,
    newPossessionProofs, transitionHash: `sha3-256:${hashObject(
      { ...payload, oldApprovals, newPossessionProofs }, "CHECKPOINT_POLICY_TRANSITION_HASH_V1")}` },
  { newPolicy, oldPolicy });
}

function verifySignatures(values, policy, payload, domain, { requireAll = false } = {}) {
  if (!Array.isArray(values) || values.length > policy.witnesses.length) {
    throw new Error("checkpoint policy signature set is invalid");
  }
  const normalized = values.map(approvalPayload);
  if (normalized.some((value, index) => index > 0 &&
      normalized[index - 1].operatorId >= value.operatorId)) {
    throw new Error("checkpoint policy signatures are duplicate or unordered");
  }
  for (const value of normalized) {
    const witness = policy.witnesses.find(({ operatorId }) => operatorId === value.operatorId);
    if (!witness || witness.address !== value.address ||
        !verifyObject(payload, value.signature, witness.publicKey, domain)) {
      throw new Error("checkpoint policy signature is invalid");
    }
  }
  if ((requireAll && normalized.length !== policy.witnesses.length) ||
      (!requireAll && normalized.length < policy.threshold)) {
    throw new Error(requireAll ? "new checkpoint witness key possession is incomplete" :
      "old checkpoint witness quorum did not authorize transition");
  }
  return normalized;
}

export function validateCheckpointWitnessPolicyTransition(value,
  { newPolicy: newPolicyValue, oldPolicy: oldPolicyValue }) {
  exact(value, ["activationHeight", "activationSequence", "chainIdentityGenesisHash",
    "createdHeight", "createdPackageHash", "createdSequence", "format", "networkId",
    "newGeneration", "newPolicyId", "newPossessionProofs", "oldApprovals", "oldGeneration",
    "oldPolicyId", "overlapOperators", "transitionHash", "version"],
  "checkpoint witness policy transition envelope");
  const oldPolicy = validateCheckpointWitnessPolicy(oldPolicyValue);
  const newPolicy = validateCheckpointWitnessPolicy(newPolicyValue);
  const { oldApprovals, newPossessionProofs, transitionHash, ...unsigned } = value;
  const payload = coreFor({ activationHeight: unsigned.activationHeight,
    activationSequence: unsigned.activationSequence, createdHeight: unsigned.createdHeight,
    createdPackageHash: unsigned.createdPackageHash, createdSequence: unsigned.createdSequence,
    newPolicy, oldPolicy });
  if (canonicalJson(payload) !== canonicalJson(unsigned) ||
      oldPolicy.policyId !== payload.oldPolicyId || newPolicy.policyId !== payload.newPolicyId ||
      !HASH.test(transitionHash ?? "")) {
    throw new Error("checkpoint witness policy transition context is invalid");
  }
  const approvals = verifySignatures(oldApprovals, oldPolicy, payload,
    "CHECKPOINT_POLICY_OLD_V1");
  const possession = verifySignatures(newPossessionProofs, newPolicy, payload,
    "CHECKPOINT_POLICY_NEW_V1", { requireAll: true });
  const expectedHash = `sha3-256:${hashObject({ ...payload, oldApprovals: approvals,
    newPossessionProofs: possession }, "CHECKPOINT_POLICY_TRANSITION_HASH_V1")}`;
  if (transitionHash !== expectedHash) {
    throw new Error("checkpoint witness policy transition hash is invalid");
  }
  return { ...payload, oldApprovals: approvals, newPossessionProofs: possession, transitionHash };
}

export function checkpointWitnessPolicyTransitionSummary(value) {
  return { activationHeight: value.activationHeight, activationSequence: value.activationSequence,
    newGeneration: value.newGeneration, newPolicyId: value.newPolicyId,
    transitionHash: value.transitionHash };
}

import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync,
  realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson, hashObject } from "./crypto.mjs";
import { verifyFinalityProofChain } from "./light-client.mjs";
import { verifyValidatorAdmissionSubmissionReceipt }
  from "./validator-admission-submission-receipt.mjs";
import {
  validateSignedValidatorAdmissionArtifact, validateValidatorAdmissionSigningPackage,
} from "./validator-join.mjs";
import { verifyTransactionProof } from "./transaction-tree.mjs";

const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
export const MAX_VALIDATOR_ADMISSION_FINALITY_BYTES = 40 * 1024 * 1024;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function publicPlan(value) {
  exact(value, ["candidateContextMaxWitnessAgeMs", "candidateContextMinimumCheckpointHeight",
    "candidateContextMinimumSequence", "consensus", "endpoint", "expectedChainIdentityGenesisHash",
    "expectedCheckpointPolicyId", "format", "networkId", "operatorId", "planCommitment",
    "tlsCertificateSha256", "transport", "version"], "validator admission public plan");
  const { format: _format, planCommitment, version: _version, ...payload } = value;
  if (value.format !== "nir-validator-admission-public-plan-v1" || value.version !== 1 ||
      !HASH.test(value.expectedChainIdentityGenesisHash ?? "") ||
      !TAGGED_HASH.test(value.expectedCheckpointPolicyId ?? "") ||
      !HASH.test(value.tlsCertificateSha256 ?? "") || !ADDRESS.test(value.consensus?.address ?? "") ||
      !ADDRESS.test(value.transport?.address ?? "") || value.consensus.address === value.transport.address ||
      planCommitment !== hashObject(payload, "VALIDATOR_ADMISSION_PLAN_V1")) {
    throw new Error("validator admission public plan is invalid");
  }
  return structuredClone(value);
}

function joinPlan(plan) {
  const value = structuredClone(plan); delete value.planCommitment;
  value.format = "nir-validator-join-plan-v2"; value.version = 2;
  return value;
}

function checkpointForProof(proof) {
  return {
    chainIdentityGenesisHash: proof.header.chainIdentityGenesisHash,
    height: proof.header.height,
    protocolVersion: proof.header.protocolVersion,
    stateRoot: proof.header.stateRoot,
    tipHash: proof.hash,
    validatorSetId: proof.header.validatorSetId,
  };
}

export function verifyValidatorAdmissionReceiptCheckpointBinding({
  anchor, finalityProofs, receiptCheckpoint, tip,
} = {}) {
  if (!anchor || !receiptCheckpoint || !tip || !Array.isArray(finalityProofs) ||
      !Number.isSafeInteger(receiptCheckpoint.height) ||
      receiptCheckpoint.height < anchor.height || receiptCheckpoint.height > tip.height) {
    throw new Error("validator admission submission checkpoint is outside the finalized chain");
  }
  const proof = receiptCheckpoint.height === anchor.height ? null
    : finalityProofs.find(({ header }) => header?.height === receiptCheckpoint.height);
  if (receiptCheckpoint.height !== anchor.height && !proof) {
    throw new Error("validator admission submission checkpoint is outside the finalized chain");
  }
  const expected = proof === null ? anchor : checkpointForProof(proof);
  if (canonicalJson(receiptCheckpoint) !== canonicalJson(expected)) {
    throw new Error("validator admission submission checkpoint is not on the finalized chain");
  }
  return structuredClone(receiptCheckpoint);
}

export function verifyValidatorAdmissionFinalityEvidence(value) {
  exact(value, ["candidateCheckpoint", "finalityProofs", "format", "handoffs", "inclusion",
    "publicPlan", "signedArtifact", "signedJournal", "signingPackage", "submissionReceipt",
    "version"], "validator admission finality evidence");
  if (value.format !== "nir-validator-admission-finality-evidence-v1" || value.version !== 1 ||
      !Array.isArray(value.finalityProofs) || value.finalityProofs.length < 1 ||
      !Array.isArray(value.handoffs)) throw new Error("validator admission finality evidence is invalid");
  const plan = publicPlan(value.publicPlan); const normalizedJoinPlan = joinPlan(plan);
  const signingPackage = validateValidatorAdmissionSigningPackage(value.signingPackage,
    normalizedJoinPlan, { now: value.signingPackage?.candidateContext?.syncedAt });
  const signed = validateSignedValidatorAdmissionArtifact(value.signedArtifact,
    signingPackage, normalizedJoinPlan);
  const journal = validateSignedValidatorAdmissionArtifact(value.signedJournal,
    signingPackage, normalizedJoinPlan);
  if (canonicalJson(signed) !== canonicalJson(journal)) {
    throw new Error("signed validator admission differs from its immutable journal");
  }
  const anchor = signingPackage.candidateContext.checkpoint;
  if (canonicalJson(value.candidateCheckpoint) !== canonicalJson(anchor) ||
      anchor.height !== signingPackage.referenceHeight || anchor.protocolVersion !== 32 ||
      signingPackage.candidateContext.accountProof?.pendingProtocolUpgrade !== null ||
      value.handoffs.some((handoff) => !Number.isSafeInteger(handoff?.activationHeight) ||
        handoff.activationHeight <= anchor.height)) {
    throw new Error("validator admission candidate checkpoint anchor is invalid");
  }
  const submission = verifyValidatorAdmissionSubmissionReceipt(value.submissionReceipt, {
    joinPlan: normalizedJoinPlan, plan, signed, signingPackage,
  });
  if (submission.context.checkpoint.height < anchor.height ||
      submission.context.checkpoint.height > signingPackage.validUntilHeight) {
    throw new Error("validator admission submission receipt is outside admission lifetime");
  }
  if (value.finalityProofs.some((proof) => proof?.header?.protocolVersion !== 32 ||
      proof?.header?.protocolUpgrade !== null ||
      proof?.header?.networkId !== plan.networkId ||
      proof?.header?.chainIdentityGenesisHash !== plan.expectedChainIdentityGenesisHash)) {
    throw new Error("validator admission finality chain has the wrong protocol or chain identity");
  }
  const tip = verifyFinalityProofChain(value.finalityProofs, {
    checkpoint: anchor, expectedChainIdentityGenesisHash: plan.expectedChainIdentityGenesisHash,
    expectedNetworkId: plan.networkId, handoffs: value.handoffs,
    trustedValidators: signingPackage.candidateContext.checkpointTrustPackage.validators,
  });
  verifyValidatorAdmissionReceiptCheckpointBinding({ anchor, finalityProofs: value.finalityProofs,
    receiptCheckpoint: submission.context.checkpoint, tip });
  if (value.handoffs.some(({ activationHeight }) => activationHeight > tip.height)) {
    throw new Error("validator admission finality evidence contains an unused validator handoff");
  }
  exact(value.inclusion, ["blockHash", "format", "height", "proof", "transaction",
    "transactionId", "transactionsRoot", "version"], "validator admission transaction inclusion");
  if (value.inclusion.height !== tip.height || value.inclusion.blockHash !== tip.tipHash ||
      value.inclusion.format !== "nir-validator-admission-transaction-proof-v1" ||
      value.inclusion.version !== 1 ||
      value.inclusion.transactionsRoot !== tip.transactionsRoot ||
      value.inclusion.proof?.count !== tip.transactionCount ||
      canonicalJson(value.inclusion.transaction) !== canonicalJson(signed.transaction) ||
      value.inclusion.transactionId !== signed.transactionId || tip.protocolVersion !== 32 ||
      tip.height <= signingPackage.referenceHeight || tip.height > signingPackage.validUntilHeight) {
    throw new Error("validator admission inclusion does not match the finalized tip or lifetime");
  }
  const transactionId = verifyTransactionProof(value.inclusion.transaction,
    value.inclusion.proof, tip.transactionsRoot);
  if (transactionId !== signed.transactionId || value.inclusion.transactionId !== transactionId) {
    throw new Error("validator admission transaction proof identifier does not match");
  }
  const evidenceHash = hashObject(value, "NIR_ADMISSION_FINALITY_EVIDENCE_V1");
  return { blockHash: tip.tipHash, evidenceHash, format: "nir-validator-admission-finality-result-v1",
    height: tip.height, networkId: plan.networkId, packageHash: signingPackage.packageHash,
    protocolVersion: tip.protocolVersion, submissionStatus: submission.status,
    transactionId, version: 1 };
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

export function loadValidatorAdmissionFinalityEvidence(path) {
  const requested = resolve(path); const parent = realpathSync(dirname(requested));
  const target = join(parent, basename(requested)); let descriptor;
  try {
    const linked = lstatSync(target);
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor); const bytes = readFileSync(descriptor); const after = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) ||
        !sameIdentity(linked, before) || !sameIdentity(before, after) ||
        !sameIdentity(before, lstatSync(target)) || bytes.length < 2 ||
        bytes.length > MAX_VALIDATOR_ADMISSION_FINALITY_BYTES || bytes.length !== before.size) {
      throw new Error("validator admission finality evidence file is unsafe");
    }
    const text = bytes.toString("utf8");
    if (!text.endsWith("\n")) throw new Error("validator admission finality evidence is not canonical JSON");
    const value = JSON.parse(text.slice(0, -1));
    if (`${canonicalJson(value)}\n` !== text) {
      throw new Error("validator admission finality evidence is not canonical JSON");
    }
    return value;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function persistValidatorAdmissionFinalityReceipt(path, result) {
  exact(result, ["blockHash", "evidenceHash", "format", "height", "networkId", "packageHash",
    "protocolVersion", "submissionStatus", "transactionId", "version"],
  "validator admission finality result");
  if (result.format !== "nir-validator-admission-finality-result-v1" || result.version !== 1 ||
      !HASH.test(result.blockHash ?? "") || !HASH.test(result.evidenceHash ?? "") ||
      !HASH.test(result.packageHash ?? "") || !HASH.test(result.transactionId ?? "") ||
      !Number.isSafeInteger(result.height) || result.height < 1 || result.protocolVersion !== 32 ||
      !["partial-retryable", "submitted-to-quorum"].includes(result.submissionStatus) ||
      typeof result.networkId !== "string" || result.networkId.length < 1 ||
      result.networkId.length > 128) {
    throw new Error("validator admission finality result is invalid");
  }
  const payload = { ...result, format: "nir-validator-admission-finality-receipt-v1" };
  const receipt = { ...payload, receiptHash:
    hashObject(payload, "NIR_ADMISSION_FINALITY_RECEIPT_V1") };
  const requested = resolve(path); const parent = realpathSync(dirname(requested));
  const target = join(parent, basename(requested));
  const temporary = join(parent, `.${basename(target)}.finality-${randomBytes(16).toString("hex")}`);
  let descriptor; let identity;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    identity = fstatSync(descriptor); writeFileSync(descriptor, `${canonicalJson(receipt)}\n`);
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    if (!sameIdentity(identity, lstatSync(temporary))) throw new Error("finality receipt staging changed");
    linkSync(temporary, target); unlinkSync(temporary);
    const directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    if (!sameIdentity(identity, lstatSync(target))) throw new Error("finality receipt activation changed");
    return receipt;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { if (identity && sameIdentity(identity, lstatSync(temporary))) unlinkSync(temporary); } catch {}
  }
}

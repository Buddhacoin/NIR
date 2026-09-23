import {
  verifyAdmissionInclusionCertificate,
} from "./admission-inclusion.mjs";
import {
  addressFromPublicKey, canonicalJson, hashObject, signObject, verifyObject,
} from "./crypto.mjs";
import {
  MAX_TRANSACTIONS_PER_BLOCK, MAX_VALIDATORS, MIN_TRANSFER_FEE,
  RECOVERY_STATE_COMMITMENT_PROTOCOL_VERSION, SIGNATURE_ALGORITHM,
} from "./constants.mjs";
import { transactionRootFromIds } from "./transaction-tree.mjs";
import { validatorSetId } from "./validator-rotation.mjs";

export const MAX_ADMISSION_OMISSION_EVIDENCE_BYTES = 1_850_000;
export const ADMISSION_OMISSION_REPORTER_REWARD_BPS = 1_000;

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const LEGACY_HEADER_FIELDS = [
  "accountStateRoot", "bodyHash", "capabilityMemoryRoot", "format", "height",
  "networkId", "peerRegistryHash", "previousHash", "protocolUpgrade", "protocolVersion",
  "stateRoot", "timestamp", "transactionCount", "transactionsRoot",
];
const EVIDENCE_FIELDS = [
  "blockHash", "commitVotes", "evidenceHash", "finalizedHeader", "format",
  "prepareCertificateHash", "receipts", "round", "transaction", "transactionIds",
  "validatorSetId",
];
const TRANSACTION_FIELDS = [
  "algorithm", "evidence", "fee", "networkId", "nonce", "publicKey", "sender",
  "signature", "type",
];
const VOTE_FIELDS = ["signature", "validator"];

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function evidencePayload(evidence) {
  const { evidenceHash: _evidenceHash, ...payload } = evidence;
  return payload;
}

function assertEvidenceShape(evidence) {
  const recoveryFormat = evidence?.finalizedHeader?.protocolVersion >=
    RECOVERY_STATE_COMMITMENT_PROTOCOL_VERSION;
  exact(evidence, EVIDENCE_FIELDS, "validator admission omission evidence");
  exact(evidence.finalizedHeader, recoveryFormat
    ? [...LEGACY_HEADER_FIELDS, "recoveryStateCommitment"] : LEGACY_HEADER_FIELDS,
  "validator admission omission header");
  if (evidence.format !== "nir-validator-admission-omission-v1" ||
      evidence.finalizedHeader.format !==
        (recoveryFormat ? "nir-finality-header-v2" : "nir-finality-header-v1") ||
      !HASH.test(evidence.blockHash ?? "") || !HASH.test(evidence.evidenceHash ?? "") ||
      !HASH.test(evidence.prepareCertificateHash ?? "") ||
      (recoveryFormat && !HASH.test(evidence.finalizedHeader.recoveryStateCommitment ?? "")) ||
      !HASH.test(evidence.validatorSetId ?? "") ||
      !Number.isSafeInteger(evidence.round) || evidence.round < 0 ||
      !Array.isArray(evidence.receipts) || evidence.receipts.length > MAX_VALIDATORS ||
      !Array.isArray(evidence.commitVotes) || evidence.commitVotes.length > MAX_VALIDATORS ||
      !Array.isArray(evidence.transactionIds) ||
      evidence.transactionIds.length > MAX_TRANSACTIONS_PER_BLOCK ||
      evidence.transactionIds.some((id) => !HASH.test(id ?? "")) ||
      new Set(evidence.transactionIds).size !== evidence.transactionIds.length ||
      evidence.commitVotes.some((vote) => {
        try { exact(vote, VOTE_FIELDS, "validator admission omission vote"); } catch { return true; }
        return !ADDRESS.test(vote.validator ?? "") || typeof vote.signature !== "string" ||
          vote.signature.length > 7_000;
      }) ||
      new Set(evidence.commitVotes.map(({ validator }) => validator)).size !==
        evidence.commitVotes.length ||
      Buffer.byteLength(canonicalJson(evidence)) > MAX_ADMISSION_OMISSION_EVIDENCE_BYTES) {
    throw new Error("validator admission omission evidence is malformed or oversized");
  }
}

export function createValidatorAdmissionOmissionEvidence({
  certificate, finalizedHeader, prepareCertificateHash, receipts, round, transaction,
  transactionIds, validators,
}) {
  if (!Array.isArray(transactionIds) ||
      finalizedHeader.transactionsRoot !== transactionRootFromIds(transactionIds) ||
      finalizedHeader.transactionCount !== transactionIds.length ||
      transactionIds.includes(hashObject(transaction, "TRANSACTION_ID"))) {
    throw new Error("finalized block does not prove admission omission");
  }
  const verifiedReceipts = verifyAdmissionInclusionCertificate(receipts, {
    acceptedHeight: finalizedHeader.height - 1,
    currentHeight: finalizedHeader.height,
    networkId: finalizedHeader.networkId,
    transaction,
    validators,
  });
  const receiptSigners = new Set(verifiedReceipts.map(({ validator }) => validator));
  const commitVotes = (certificate ?? []).filter(({ validator }) => receiptSigners.has(validator))
    .sort((left, right) => left.validator < right.validator ? -1 : 1);
  const payload = {
    blockHash: hashObject(finalizedHeader, "BLOCK"),
    commitVotes,
    finalizedHeader: structuredClone(finalizedHeader),
    format: "nir-validator-admission-omission-v1",
    prepareCertificateHash,
    receipts: verifiedReceipts,
    round,
    transaction: structuredClone(transaction),
    transactionIds: [...transactionIds],
    validatorSetId: validatorSetId(validators),
  };
  const evidence = { ...payload,
    evidenceHash: hashObject(payload, "VALIDATOR_ADMISSION_OMISSION_V1") };
  assertEvidenceShape(evidence);
  return evidence;
}

export function verifyValidatorAdmissionOmissionEvidence(evidence, {
  canonicalBlockHash, canonicalCertificate, canonicalHeader,
  canonicalPrepareCertificateHash, canonicalRound, canonicalTransactionIds,
  currentHeight, networkId, validators,
} = {}) {
  assertEvidenceShape(evidence);
  if (!Array.isArray(validators) || !Array.isArray(canonicalCertificate) ||
      !Array.isArray(canonicalTransactionIds) || currentHeight !== evidence.finalizedHeader.height + 1 ||
      evidence.finalizedHeader.networkId !== networkId ||
      evidence.validatorSetId !== validatorSetId(validators) ||
      evidence.blockHash !== canonicalBlockHash ||
      evidence.round !== canonicalRound ||
      canonicalJson(evidence.finalizedHeader) !== canonicalJson(canonicalHeader) ||
      evidence.prepareCertificateHash !== canonicalPrepareCertificateHash ||
      canonicalJson(evidence.transactionIds) !== canonicalJson(canonicalTransactionIds) ||
      evidence.finalizedHeader.transactionCount !== evidence.transactionIds.length ||
      evidence.finalizedHeader.transactionsRoot !== transactionRootFromIds(evidence.transactionIds) ||
      hashObject(evidence.finalizedHeader, "BLOCK") !== evidence.blockHash ||
      hashObject(evidencePayload(evidence), "VALIDATOR_ADMISSION_OMISSION_V1") !==
        evidence.evidenceHash) {
    throw new Error("validator admission omission evidence is stale or not canonical");
  }
  const verifiedReceipts = verifyAdmissionInclusionCertificate(evidence.receipts, {
    acceptedHeight: evidence.finalizedHeader.height - 1,
    currentHeight: evidence.finalizedHeader.height,
    networkId,
    transaction: evidence.transaction,
    validators,
  });
  const transactionId = hashObject(evidence.transaction, "TRANSACTION_ID");
  if (evidence.transactionIds.includes(transactionId)) {
    throw new Error("receipted admission was included in the finalized block");
  }
  const receiptSigners = new Set(verifiedReceipts.map(({ validator }) => validator));
  const expectedVotes = canonicalCertificate
    .filter(({ validator }) => receiptSigners.has(validator))
    .sort((left, right) => left.validator < right.validator ? -1 : 1);
  if (expectedVotes.length === 0 || canonicalJson(expectedVotes) !== canonicalJson(evidence.commitVotes)) {
    throw new Error("admission omission evidence does not contain the exact signer intersection");
  }
  const members = new Map(validators.map((member) => [member.address, member]));
  for (const vote of evidence.commitVotes) {
    const member = members.get(vote.validator);
    if (!member || !verifyObject({ blockHash: evidence.blockHash,
      prepareCertificateHash: evidence.prepareCertificateHash }, vote.signature,
    member.publicKey, "BLOCK_COMMIT")) {
      throw new Error("admission omission commit signature is invalid");
    }
  }
  return {
    evidenceHash: evidence.evidenceHash,
    offenders: evidence.commitVotes.map(({ validator }) => validator),
    transactionId,
  };
}

export function createValidatorAdmissionOmissionTransaction({
  evidence, fee = MIN_TRANSFER_FEE.toString(), networkId, nonce, wallet,
}) {
  assertEvidenceShape(evidence);
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    evidence: structuredClone(evidence),
    fee: String(fee),
    networkId,
    nonce,
    publicKey: wallet.publicKey,
    sender: wallet.address,
    type: "validator-admission-omission",
  };
  return { ...transaction,
    signature: signObject(transaction, wallet, "VALIDATOR_ADMISSION_OMISSION_TX_V1") };
}

export function verifyValidatorAdmissionOmissionTransactionEnvelope(transaction, networkId) {
  exact(transaction, TRANSACTION_FIELDS, "validator admission omission transaction");
  assertEvidenceShape(transaction.evidence);
  const { signature, ...unsigned } = transaction;
  if (transaction.type !== "validator-admission-omission" ||
      transaction.algorithm !== SIGNATURE_ALGORITHM || transaction.networkId !== networkId ||
      transaction.evidence.finalizedHeader.networkId !== networkId ||
      addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
      !Number.isSafeInteger(transaction.nonce) || transaction.nonce < 0 ||
      !/^(0|[1-9][0-9]*)$/.test(transaction.fee ?? "") ||
      BigInt(transaction.fee) < MIN_TRANSFER_FEE || typeof signature !== "string" ||
      signature.length > 7_000 || !verifyObject(unsigned, signature, transaction.publicKey,
        "VALIDATOR_ADMISSION_OMISSION_TX_V1")) {
    throw new Error("validator admission omission transaction is invalid");
  }
  return structuredClone(transaction);
}

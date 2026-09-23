import {
  addressFromPublicKey, canonicalJson, hashObject, signObject, verifyObject,
} from "./crypto.mjs";
import { blockHash, prepareCertificateHash } from "./chain.mjs";
import { BEACON_ADMISSION_DELAY_BLOCKS } from "./beacon-rotation.mjs";
import { MIN_BEACON_BOND, MIN_TRANSFER_FEE, SIGNATURE_ALGORITHM } from "./constants.mjs";
import { validatorSetId } from "./validator-rotation.mjs";

export const MAX_ADMISSION_INCLUSION_DELAY_BLOCKS = 1;
export const MAX_ADMISSION_RECEIPT_AGE_BLOCKS = 8;

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const RECEIPT_FIELDS = [
  "acceptedHeight", "expiresHeight", "format", "inclusionHeight", "networkId", "nonce",
  "receiptHash", "sender", "signature", "transactionId", "validator", "validatorSetId",
];

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

export function isProtectedBeaconAdmission(transaction) {
  return transaction?.type === "beacon-bond" &&
    typeof transaction.operatorId === "string" && transaction.operatorId.length > 0;
}

function receiptPayload({ acceptedHeight, networkId, transaction, validator, validators }) {
  const { signature, ...unsigned } = transaction ?? {};
  if (!isProtectedBeaconAdmission(transaction) || !Array.isArray(validators) ||
      !Number.isSafeInteger(acceptedHeight) || acceptedHeight < 0 ||
      typeof networkId !== "string" || networkId.length < 1 || networkId.length > 128 ||
      !ADDRESS.test(validator ?? "") || !ADDRESS.test(transaction.sender ?? "") ||
      transaction.algorithm !== SIGNATURE_ALGORITHM || transaction.networkId !== networkId ||
      addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
      !Number.isSafeInteger(transaction.nonce) || transaction.nonce < 0 ||
      transaction.activationHeight !== acceptedHeight + 1 + BEACON_ADMISSION_DELAY_BLOCKS ||
      transaction.amount !== MIN_BEACON_BOND.toString() ||
      !/^(0|[1-9][0-9]*)$/.test(transaction.fee ?? "") ||
      BigInt(transaction.fee) < MIN_TRANSFER_FEE ||
      !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(transaction.operatorId) ||
      typeof signature !== "string" || signature.length > 7_000 ||
      !verifyObject(unsigned, signature, transaction.publicKey, "BEACON_BOND")) {
    throw new Error("beacon admission receipt context is invalid");
  }
  const inclusionHeight = acceptedHeight + MAX_ADMISSION_INCLUSION_DELAY_BLOCKS;
  return {
    acceptedHeight,
    expiresHeight: inclusionHeight + MAX_ADMISSION_RECEIPT_AGE_BLOCKS,
    format: "nir-beacon-admission-inclusion-receipt-v1",
    inclusionHeight,
    networkId,
    nonce: transaction.nonce,
    sender: transaction.sender,
    transactionId: hashObject(transaction, "TRANSACTION_ID"),
    validator,
    validatorSetId: validatorSetId(validators),
  };
}

export function createAdmissionInclusionReceipt({
  acceptedHeight, networkId, transaction, validatorWallet, validators,
}) {
  const payload = receiptPayload({ acceptedHeight, networkId, transaction,
    validator: validatorWallet?.address, validators });
  const receiptHash = hashObject(payload, "BEACON_ADMISSION_RECEIPT_HASH_V1");
  return { ...payload, receiptHash,
    signature: signObject(payload, validatorWallet, "BEACON_ADMISSION_RECEIPT_V1") };
}

export function verifyAdmissionInclusionReceipt(receipt, {
  acceptedHeight, currentHeight = acceptedHeight, networkId, transaction, validators,
} = {}) {
  exact(receipt, RECEIPT_FIELDS, "beacon admission inclusion receipt");
  const member = (validators ?? []).find(({ address }) => address === receipt.validator);
  const payload = receiptPayload({ acceptedHeight, networkId, transaction,
    validator: receipt.validator, validators });
  if (!Number.isSafeInteger(currentHeight) || currentHeight < acceptedHeight ||
      currentHeight > receipt.expiresHeight || !member ||
      canonicalJson(payload) !== canonicalJson(Object.fromEntries(
    Object.entries(receipt).filter(([key]) => !["receiptHash", "signature"].includes(key)),
  )) || !HASH.test(receipt.receiptHash ?? "") ||
      receipt.receiptHash !== hashObject(payload, "BEACON_ADMISSION_RECEIPT_HASH_V1") ||
      typeof receipt.signature !== "string" || receipt.signature.length > 7_000 ||
      !verifyObject(payload, receipt.signature, member.publicKey,
        "BEACON_ADMISSION_RECEIPT_V1")) {
    throw new Error("beacon admission inclusion receipt is invalid");
  }
  return structuredClone(receipt);
}

export function verifyAdmissionInclusionCertificate(receipts, context = {}) {
  if (!Array.isArray(receipts) || !Array.isArray(context.validators) ||
      receipts.length > context.validators.length) {
    throw new Error("beacon admission inclusion certificate is invalid");
  }
  const seen = new Set();
  const verified = receipts.map((receipt) => {
    const value = verifyAdmissionInclusionReceipt(receipt, context);
    if (seen.has(value.validator)) throw new Error("duplicate beacon admission receipt signer");
    seen.add(value.validator);
    return value;
  });
  const quorum = Math.floor((context.validators.length * 2) / 3) + 1;
  if (seen.size < quorum) throw new Error("beacon admission receipt quorum is not reached");
  return verified.sort((left, right) => left.validator < right.validator ? -1 : 1);
}

export function assertAdmissionInclusionObligations(proposal, receipts) {
  if (!proposal || !Number.isSafeInteger(proposal.height) || proposal.height < 1 ||
      !Array.isArray(proposal.transactions) || !(receipts instanceof Map)) {
    throw new Error("admission inclusion obligation context is invalid");
  }
  const included = new Set(proposal.transactions.map((transaction) =>
    hashObject(transaction, "TRANSACTION_ID")));
  for (const [id, receipt] of receipts) {
    if (proposal.height < receipt.inclusionHeight) continue;
    if (proposal.height > receipt.inclusionHeight) {
      throw new Error("durable beacon admission inclusion obligation expired unsatisfied");
    }
    if (!included.has(id)) {
      throw new Error("proposal omits a quorum-receipted beacon admission");
    }
  }
  return true;
}

export function admissionReceiptEquivocation(first, second, { validators } = {}) {
  if (!Array.isArray(validators)) throw new Error("validator set is required");
  const member = validators.find(({ address }) => address === first?.validator);
  if (!member || second?.validator !== first.validator || first.networkId !== second.networkId ||
      first.acceptedHeight !== second.acceptedHeight || first.sender !== second.sender ||
      first.inclusionHeight !== second.inclusionHeight || first.expiresHeight !== second.expiresHeight ||
      first.validatorSetId !== second.validatorSetId || first.nonce !== second.nonce ||
      first.transactionId === second.transactionId) {
    throw new Error("receipts do not prove admission receipt equivocation");
  }
  for (const receipt of [first, second]) {
    exact(receipt, RECEIPT_FIELDS, "beacon admission inclusion receipt");
    const { receiptHash, signature, ...payload } = receipt;
    if (receiptHash !== hashObject(payload, "BEACON_ADMISSION_RECEIPT_HASH_V1") ||
        !verifyObject(payload, signature, member.publicKey,
          "BEACON_ADMISSION_RECEIPT_V1")) {
      throw new Error("receipts do not prove admission receipt equivocation");
    }
  }
  const receipts = [first, second].sort((left, right) =>
    left.transactionId < right.transactionId ? -1 : 1);
  return {
    evidenceHash: hashObject({ receipts }, "BEACON_ADMISSION_RECEIPT_EQUIV_V1"),
    receipts: receipts.map((receipt) => structuredClone(receipt)),
    validator: first.validator,
  };
}

export function proveAdmissionInclusionViolation({
  finalizedBlock, receipt, transaction, validators,
} = {}) {
  verifyAdmissionInclusionReceipt(receipt, {
    acceptedHeight: receipt?.acceptedHeight,
    networkId: finalizedBlock?.networkId,
    transaction,
    validators,
  });
  if (!finalizedBlock || finalizedBlock.height !== receipt.inclusionHeight ||
      finalizedBlock.hash !== blockHash(finalizedBlock) ||
      finalizedBlock.transactions.some((candidate) =>
        hashObject(candidate, "TRANSACTION_ID") === receipt.transactionId)) {
    throw new Error("finalized block does not prove an admission inclusion violation");
  }
  const member = validators.find(({ address }) => address === receipt.validator);
  const vote = finalizedBlock.certificate?.find(({ validator }) => validator === receipt.validator);
  if (!member || !vote || !verifyObject({
    blockHash: blockHash(finalizedBlock),
    prepareCertificateHash: prepareCertificateHash(finalizedBlock.prepareCertificate),
  }, vote.signature, member.publicKey, "BLOCK_COMMIT")) {
    throw new Error("receipt signer did not commit the omitting finalized block");
  }
  const statement = {
    blockHash: finalizedBlock.hash,
    receiptHash: receipt.receiptHash,
    transactionId: receipt.transactionId,
    validator: receipt.validator,
  };
  return { ...statement,
    evidenceHash: hashObject(statement, "BEACON_ADMISSION_OMISSION_V1") };
}

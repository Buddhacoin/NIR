import { canonicalJson, hashObject } from "./crypto.mjs";

const HASH = /^[0-9a-f]{64}$/;
const FORMAT = "nir-transaction-inclusion-v1";
export const MAX_TRANSACTION_PROOF_BYTES = 32 * 1024;

export function committedTransactionId(transaction) {
  return hashObject(transaction, "TRANSACTION_ID");
}

const emptyHashes = [hashObject(null, "TRANSACTION_TREE_EMPTY_LEAF")];
function emptyHash(level) {
  while (emptyHashes.length <= level) {
    const child = emptyHashes.at(-1);
    emptyHashes.push(hashObject({ left: child, right: child }, "TRANSACTION_TREE_NODE"));
  }
  return emptyHashes[level];
}

function leaf(transaction, index) {
  return hashObject({ index, transactionId: committedTransactionId(transaction) },
    "TRANSACTION_TREE_LEAF");
}

function levelsFor(transactions) {
  if (!Array.isArray(transactions)) throw new Error("transaction tree input is invalid");
  const levels = [transactions.map(leaf)];
  if (levels[0].length === 0) return levels;
  while (levels.at(-1).length > 1) {
    const current = levels.at(-1);
    const next = [];
    const level = levels.length - 1;
    for (let index = 0; index < current.length; index += 2) {
      next.push(hashObject({
        left: current[index], right: current[index + 1] ?? emptyHash(level),
      }, "TRANSACTION_TREE_NODE"));
    }
    levels.push(next);
  }
  return levels;
}

export function transactionRoot(transactions) {
  const levels = levelsFor(transactions);
  return levels[0].length === 0 ? emptyHash(0) : levels.at(-1)[0];
}

export function createTransactionProofs(transactions, indexes) {
  if (!Array.isArray(indexes) || indexes.some((index) =>
    !Number.isSafeInteger(index) || index < 0 || index >= transactions.length)) {
    throw new Error("transaction proof indexes are invalid");
  }
  const levels = levelsFor(transactions);
  return indexes.map((index) => {
    const siblings = [];
    let position = index;
    for (let level = 0; level < levels.length - 1; level += 1) {
      siblings.push(levels[level][position ^ 1] ?? emptyHash(level));
      position = Math.floor(position / 2);
    }
    return { count: transactions.length, format: FORMAT, index, siblings };
  });
}

export function createTransactionProof(transactions, index) {
  return createTransactionProofs(transactions, [index])[0];
}

export function verifyTransactionProof(transaction, proof, expectedRoot) {
  if (!proof || proof.format !== FORMAT || !Number.isSafeInteger(proof.count) ||
      proof.count < 1 || !Number.isSafeInteger(proof.index) || proof.index < 0 ||
      proof.index >= proof.count || !Array.isArray(proof.siblings) ||
      proof.siblings.some((hash) => !HASH.test(hash ?? "")) || !HASH.test(expectedRoot ?? "") ||
      Buffer.byteLength(canonicalJson(proof)) > MAX_TRANSACTION_PROOF_BYTES) {
    throw new Error("transaction inclusion proof is invalid");
  }
  const expectedDepth = Math.ceil(Math.log2(proof.count));
  if (proof.siblings.length !== expectedDepth) {
    throw new Error("transaction inclusion proof depth is invalid");
  }
  let current = leaf(transaction, proof.index);
  let position = proof.index;
  for (const sibling of proof.siblings) {
    current = position % 2 === 0
      ? hashObject({ left: current, right: sibling }, "TRANSACTION_TREE_NODE")
      : hashObject({ left: sibling, right: current }, "TRANSACTION_TREE_NODE");
    position = Math.floor(position / 2);
  }
  if (current !== expectedRoot) throw new Error("transaction root does not match");
  return committedTransactionId(transaction);
}

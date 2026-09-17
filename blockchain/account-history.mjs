import { canonicalJson, hashObject } from "./crypto.mjs";

const HASH = /^[0-9a-f]{64}$/;
const FORMAT = "nir-account-history-v2";
const PROOF_FORMAT = "nir-account-history-entry-v1";
const DEPTH = 32;
const MAX_COUNT = 2 ** DEPTH;
export const MAX_ACCOUNT_HISTORY_PROOF_BYTES = 64 * 1024;

const emptyHashes = [hashObject(null, "ACCOUNT_HISTORY_EMPTY_LEAF")];
for (let level = 0; level < DEPTH; level += 1) {
  emptyHashes.push(hashObject({
    left: emptyHashes[level], right: emptyHashes[level],
  }, "ACCOUNT_HISTORY_NODE"));
}
export const EMPTY_ACCOUNT_HISTORY_ROOT = emptyHashes[DEPTH];

function bit(index, level) { return Math.floor(index / (2 ** level)) % 2; }
function leaf(transactionId, index) {
  return hashObject({ index, transactionId }, "ACCOUNT_HISTORY_LEAF");
}
function node(left, right) { return hashObject({ left, right }, "ACCOUNT_HISTORY_NODE"); }
function rootFromFrontier(frontier, count) {
  let value = emptyHashes[0];
  for (let level = 0; level < DEPTH; level += 1) {
    value = bit(count, level) === 1
      ? node(frontier[level], value) : node(value, emptyHashes[level]);
  }
  return value;
}

export function emptyAccountHistory() {
  return { count: 0, format: FORMAT, root: EMPTY_ACCOUNT_HISTORY_ROOT };
}

export function emptyAccountHistoryAccumulator() {
  return { ...emptyAccountHistory(), frontier: Array(DEPTH).fill(null) };
}

export function normalizeAccountHistory(history) {
  if (!history || history.format !== FORMAT ||
      !Number.isSafeInteger(history.count) || history.count < 0 || history.count > MAX_COUNT ||
      !HASH.test(history.root ?? "") ||
      ((history.count === 0) !== (history.root === EMPTY_ACCOUNT_HISTORY_ROOT))) {
    throw new Error("account history commitment is invalid");
  }
  return { count: history.count, format: FORMAT, root: history.root };
}

export function normalizeAccountHistoryAccumulator(history) {
  const commitment = normalizeAccountHistory(history);
  if (!Array.isArray(history.frontier) || history.frontier.length !== DEPTH ||
      history.frontier.some((value, level) => bit(commitment.count, level) === 1
        ? !HASH.test(value ?? "") : value !== null) ||
      rootFromFrontier(history.frontier, commitment.count) !== commitment.root) {
    throw new Error("account history accumulator is invalid");
  }
  return { ...commitment, frontier: [...history.frontier] };
}

export function appendAccountHistory(history, transactionId) {
  const current = normalizeAccountHistoryAccumulator(history);
  if (current.count >= MAX_COUNT) throw new Error("account history capacity is exhausted");
  if (!HASH.test(transactionId ?? "")) throw new Error("account history transaction id is invalid");
  const frontier = [...current.frontier];
  let value = leaf(transactionId, current.count);
  for (let level = 0; level < DEPTH; level += 1) {
    if (bit(current.count, level) === 0) {
      frontier[level] = value;
      break;
    } else {
      if (!HASH.test(frontier[level] ?? "")) {
        throw new Error("account history frontier is incomplete");
      }
      value = node(frontier[level], value);
      frontier[level] = null;
    }
  }
  const count = current.count + 1;
  return { count, format: FORMAT, frontier, root: rootFromFrontier(frontier, count) };
}

export function accountHistoryAccumulator(transactionIds) {
  if (!Array.isArray(transactionIds)) throw new Error("account history is invalid");
  return transactionIds.reduce(appendAccountHistory, emptyAccountHistoryAccumulator());
}

export function accountHistoryCommitment(transactionIds) {
  return normalizeAccountHistory(accountHistoryAccumulator(transactionIds));
}

function historyLevels(transactionIds) {
  if (!Array.isArray(transactionIds) || transactionIds.length > MAX_COUNT ||
      transactionIds.some((id) => !HASH.test(id ?? ""))) throw new Error("account history is invalid");
  const levels = [new Map(transactionIds.map((id, index) => [index, leaf(id, index)]))];
  for (let level = 0; level < DEPTH; level += 1) {
    const parents = new Set([...levels[level].keys()].map((index) => Math.floor(index / 2)));
    const next = new Map();
    for (const parent of parents) {
      next.set(parent, node(
        levels[level].get(parent * 2) ?? emptyHashes[level],
        levels[level].get(parent * 2 + 1) ?? emptyHashes[level],
      ));
    }
    levels.push(next);
  }
  return levels;
}

export function createAccountHistoryProofs(transactionIds, indexes) {
  if (!Array.isArray(indexes) || indexes.some((index) =>
    !Number.isSafeInteger(index) || index < 0 || index >= transactionIds.length)) {
    throw new Error("account history proof indexes are invalid");
  }
  const levels = historyLevels(transactionIds);
  return indexes.map((index) => {
    const siblings = [];
    let position = index;
    for (let level = 0; level < DEPTH; level += 1) {
      siblings.push(levels[level].get(position ^ 1) ?? emptyHashes[level]);
      position = Math.floor(position / 2);
    }
    return { count: transactionIds.length, format: PROOF_FORMAT, index, siblings };
  });
}

export function createAccountHistoryProof(transactionIds, index) {
  return createAccountHistoryProofs(transactionIds, [index])[0];
}

export function verifyAccountHistoryEntry(transactionId, proof, expected) {
  const commitment = normalizeAccountHistory(expected);
  if (!HASH.test(transactionId ?? "") || !proof || proof.format !== PROOF_FORMAT ||
      proof.count !== commitment.count || !Number.isSafeInteger(proof.index) ||
      proof.index < 0 || proof.index >= proof.count || !Array.isArray(proof.siblings) ||
      proof.siblings.length !== DEPTH || proof.siblings.some((hash) => !HASH.test(hash ?? "")) ||
      Buffer.byteLength(canonicalJson(proof)) > MAX_ACCOUNT_HISTORY_PROOF_BYTES) {
    throw new Error("account history entry proof is invalid");
  }
  let value = leaf(transactionId, proof.index);
  let position = proof.index;
  for (let level = 0; level < DEPTH; level += 1) {
    value = position % 2 === 0
      ? node(value, proof.siblings[level]) : node(proof.siblings[level], value);
    position = Math.floor(position / 2);
  }
  if (value !== commitment.root) throw new Error("account history root does not match");
  return { index: proof.index, transactionId };
}

export function verifyAccountHistory(transactionIds, expected) {
  const commitment = accountHistoryCommitment(transactionIds);
  const normalized = normalizeAccountHistory(expected);
  if (commitment.count !== normalized.count || commitment.root !== normalized.root) {
    throw new Error("account history is incomplete or reordered");
  }
  return commitment;
}

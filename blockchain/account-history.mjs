import { canonicalJson, hashObject } from "./crypto.mjs";

const HASH = /^[0-9a-f]{64}$/;
const FORMAT = "nir-account-history-v1";
export const EMPTY_ACCOUNT_HISTORY_ROOT = hashObject(null, "ACCOUNT_HISTORY_EMPTY");
export const MAX_ACCOUNT_HISTORY_PROOF_BYTES = 16 * 1024 * 1024;

export function emptyAccountHistory() {
  return { count: 0, format: FORMAT, root: EMPTY_ACCOUNT_HISTORY_ROOT };
}

export function normalizeAccountHistory(history) {
  if (!history || history.format !== FORMAT ||
      !Number.isSafeInteger(history.count) || history.count < 0 ||
      !HASH.test(history.root ?? "") ||
      ((history.count === 0) !== (history.root === EMPTY_ACCOUNT_HISTORY_ROOT))) {
    throw new Error("account history commitment is invalid");
  }
  return { count: history.count, format: FORMAT, root: history.root };
}

export function appendAccountHistory(history, transactionId) {
  const current = normalizeAccountHistory(history);
  if (!HASH.test(transactionId ?? "")) throw new Error("account history transaction id is invalid");
  return {
    count: current.count + 1,
    format: FORMAT,
    root: hashObject({
      index: current.count,
      previousRoot: current.root,
      transactionId,
    }, "ACCOUNT_HISTORY_ENTRY"),
  };
}

export function accountHistoryCommitment(transactionIds) {
  if (!Array.isArray(transactionIds) ||
      Buffer.byteLength(canonicalJson(transactionIds)) > MAX_ACCOUNT_HISTORY_PROOF_BYTES) {
    throw new Error("account history is invalid");
  }
  return transactionIds.reduce(appendAccountHistory, emptyAccountHistory());
}

export function verifyAccountHistory(transactionIds, expected) {
  const commitment = accountHistoryCommitment(transactionIds);
  const normalized = normalizeAccountHistory(expected);
  if (commitment.count !== normalized.count || commitment.root !== normalized.root) {
    throw new Error("account history is incomplete or reordered");
  }
  return commitment;
}

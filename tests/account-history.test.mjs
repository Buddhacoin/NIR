import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountHistoryMerkleIndex,
  accountHistoryCommitment,
  appendAccountHistory,
  createAccountHistoryProof,
  emptyAccountHistoryAccumulator,
  verifyAccountHistory,
  verifyAccountHistoryEntry,
} from "../blockchain/account-history.mjs";

const ids = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];

test("account history accumulator binds every identifier and its order", () => {
  const commitment = accountHistoryCommitment(ids);
  assert.equal(commitment.count, 3);
  assert.deepEqual(verifyAccountHistory(ids, commitment), commitment);
  assert.throws(() => verifyAccountHistory(ids.slice(1), commitment), /incomplete or reordered/);
  assert.throws(() => verifyAccountHistory([ids[1], ids[0], ids[2]], commitment),
    /incomplete or reordered/);
  assert.throws(() => verifyAccountHistory([...ids.slice(0, 2), "4".repeat(64)], commitment),
    /incomplete or reordered/);
});

test("account history validates empty and incremental commitments", () => {
  const first = appendAccountHistory(emptyAccountHistoryAccumulator(), ids[0]);
  assert.deepEqual(
    { count: first.count, format: first.format, root: first.root },
    accountHistoryCommitment(ids.slice(0, 1)),
  );
  assert.throws(() => appendAccountHistory(first, "not-a-hash"), /transaction id/);
});

test("fixed-depth proofs authenticate exact history positions without the full list", () => {
  const commitment = accountHistoryCommitment(ids);
  ids.forEach((id, index) => assert.deepEqual(
    verifyAccountHistoryEntry(id, createAccountHistoryProof(ids, index), commitment),
    { index, transactionId: id },
  ));
  assert.throws(() => verifyAccountHistoryEntry(
    ids[1], createAccountHistoryProof(ids, 0), commitment,
  ), /root does not match/);
});

test("cached Merkle nodes advance to the same commitment incrementally", () => {
  const tree = new AccountHistoryMerkleIndex();
  ids.forEach((id, index) => {
    assert.deepEqual(tree.append(id), accountHistoryCommitment(ids.slice(0, index + 1)));
  });
  assert.deepEqual(tree.commitment(), accountHistoryCommitment(ids));
});

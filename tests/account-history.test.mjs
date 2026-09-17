import assert from "node:assert/strict";
import test from "node:test";

import {
  accountHistoryCommitment,
  appendAccountHistory,
  emptyAccountHistory,
  verifyAccountHistory,
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
  const first = appendAccountHistory(emptyAccountHistory(), ids[0]);
  assert.deepEqual(first, accountHistoryCommitment(ids.slice(0, 1)));
  assert.throws(() => appendAccountHistory(first, "not-a-hash"), /transaction id/);
});

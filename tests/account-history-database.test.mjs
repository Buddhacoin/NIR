import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountHistoryDatabase } from "../blockchain/account-history-database.mjs";
import {
  accountHistoryCommitment,
  verifyAccountHistoryEntry,
} from "../blockchain/account-history.mjs";
import {
  committedTransactionId,
  createTransactionProofs,
  transactionRoot,
} from "../blockchain/transaction-tree.mjs";

const address = `nir1${"a".repeat(64)}`;
const transactions = Array.from({ length: 25 }, (_, sequence) => ({ sequence }));
const ids = transactions.map(committedTransactionId);

function record(height, values) {
  const transactionIds = values.map(committedTransactionId);
  const proofs = createTransactionProofs(values, values.map((_, index) => index));
  return {
    blockHash: height.toString(16).padStart(64, "b"),
    height,
    indexHash: height.toString(16).padStart(64, "c"),
    networkId: "nir-history-database-test",
    transactions: transactionIds.map((id, index) => ({
      id,
      proof: proofs[index],
      transaction: values[index],
    })),
    transactionsRoot: transactionRoot(values),
    updates: [{ address, transactionIds }],
  };
}

test("the disk history database serves bounded pages and survives reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-history-db-test-"));
  const path = join(directory, "history.sqlite");
  try {
    let database = new AccountHistoryDatabase(path, { reset: true });
    database.appendRecord(record(1, transactions.slice(0, 12)));
    database.appendRecord(record(2, transactions.slice(12)));
    assert.deepEqual(database.checkpoint(), {
      format: "nir-account-history-database",
      height: 2,
      indexHash: record(2, []).indexHash,
      networkId: "nir-history-database-test",
      schemaVersion: 1,
      tipHash: record(2, []).blockHash,
    });
    database.close();

    database = new AccountHistoryDatabase(path);
    const page = database.page(address);
    assert.equal(page.count, 25);
    assert.equal(page.start, 5);
    assert.deepEqual(page.entries.map(({ id }) => id), ids.slice(5));
    const commitment = accountHistoryCommitment(ids);
    for (const entry of page.entries) {
      assert.equal(verifyAccountHistoryEntry(entry.id, entry.proof, commitment).index,
        entry.index);
    }
    assert.deepEqual(database.transactionProof(ids[24]).transaction, transactions[24]);
    assert.equal(database.matchesCommitments(new Map([[address, commitment]]), {
      height: 2,
      indexHash: record(2, []).indexHash,
      networkId: "nir-history-database-test",
      tipHash: record(2, []).blockHash,
    }), true);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a duplicate transaction rolls back the complete database record", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-history-db-test-"));
  try {
    const database = new AccountHistoryDatabase(join(directory, "history.sqlite"), { reset: true });
    database.appendRecord(record(1, transactions.slice(0, 2)));
    assert.throws(() => database.appendRecord(record(2,
      [transactions[0], transactions[2]])), /UNIQUE/);
    assert.equal(database.page(address).count, 2);
    assert.deepEqual(database.checkpoint(), {
      format: "nir-account-history-database",
      height: 1,
      indexHash: record(1, []).indexHash,
      networkId: "nir-history-database-test",
      schemaVersion: 1,
      tipHash: record(1, []).blockHash,
    });
    assert.throws(() => database.transactionProof(ids[2]), /not found/);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

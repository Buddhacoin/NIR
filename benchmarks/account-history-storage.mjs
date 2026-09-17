#!/usr/bin/env node
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { AccountHistoryDatabase } from "../blockchain/account-history-database.mjs";
import {
  ACCOUNT_HISTORY_DEPTH,
  ACCOUNT_HISTORY_PROOF_FORMAT,
  accountHistoryCommitment,
  accountHistoryEmptyHash,
  verifyAccountHistoryEntry,
} from "../blockchain/account-history.mjs";
import { hashObject } from "../blockchain/crypto.mjs";
import {
  committedTransactionId,
  createTransactionProofs,
  transactionRoot,
} from "../blockchain/transaction-tree.mjs";

const address = `nir1${"a".repeat(64)}`;
const networkId = "nir-storage-benchmark";

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be positive`);
  return parsed;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function elapsed(operation) {
  const start = performance.now();
  const value = operation();
  return { milliseconds: performance.now() - start, value };
}

function siblingPosition(position) { return position % 2 === 0 ? position + 1 : position - 1; }

function record(height, transactions) {
  const ids = transactions.map(committedTransactionId);
  const proofs = createTransactionProofs(transactions, transactions.map((_, index) => index));
  const blockHash = hashObject({ height }, "STORAGE_BENCHMARK_BLOCK");
  return {
    blockHash,
    height,
    indexHash: hashObject({ blockHash, height }, "STORAGE_BENCHMARK_INDEX"),
    networkId,
    transactions: transactions.map((transaction, index) => ({
      id: ids[index], proof: proofs[index], transaction,
    })),
    transactionsRoot: transactionRoot(transactions),
    updates: [{ address, transactionIds: ids }],
  };
}

const { values } = parseArgs({
  options: {
    "block-size": { default: "100", type: "string" },
    entries: { default: "10000", type: "string" },
    lookups: { default: "200", type: "string" },
  },
});
const entries = positiveInteger(values.entries, "entries");
const blockSize = positiveInteger(values["block-size"], "block-size");
const lookups = positiveInteger(values.lookups, "lookups");
const directory = mkdtempSync(join(tmpdir(), "nir-storage-benchmark-"));
const path = join(directory, "history.sqlite");

try {
  const rssBefore = process.memoryUsage().rss;
  let database = new AccountHistoryDatabase(path, { reset: true });
  const ids = [];
  const build = elapsed(() => {
    let height = 0;
    for (let offset = 0; offset < entries; offset += blockSize) {
      height += 1;
      const transactions = Array.from(
        { length: Math.min(blockSize, entries - offset) },
        (_, index) => ({ benchmarkSequence: offset + index }),
      );
      const next = record(height, transactions);
      ids.push(...next.transactions.map(({ id }) => id));
      database.appendRecord(next);
    }
  });
  const lastHeight = Math.ceil(entries / blockSize);
  const tipHash = hashObject({ height: lastHeight }, "STORAGE_BENCHMARK_BLOCK");
  const indexHash = hashObject({ blockHash: tipHash, height: lastHeight },
    "STORAGE_BENCHMARK_INDEX");
  const commitment = accountHistoryCommitment(ids);
  database.close();

  const reopen = elapsed(() => { database = new AccountHistoryDatabase(path); });
  const validate = elapsed(() => database.matchesCommitments(new Map([[address, commitment]]), {
    height: lastHeight, indexHash, networkId, tipHash,
  }));
  if (!validate.value) throw new Error("benchmark database validation failed");

  const legacy = new DatabaseSync(path, { readOnly: true });
  const legacyHistory = legacy.prepare(`
    SELECT position, transaction_id AS id FROM history
    WHERE address = ? AND position >= ? AND position < ? ORDER BY position
  `);
  const legacyNode = legacy.prepare(
    "SELECT hash FROM nodes WHERE address = ? AND level = ? AND position = ?",
  );
  function legacyPage(before) {
    const start = Math.max(0, before - 20);
    const pageEntries = legacyHistory.all(address, start, before).map(({ id, position }) => {
      const siblings = [];
      let nodePosition = position;
      for (let level = 0; level < ACCOUNT_HISTORY_DEPTH; level += 1) {
        siblings.push(legacyNode.get(
          address, level, siblingPosition(nodePosition),
        )?.hash ?? accountHistoryEmptyHash(level));
        nodePosition = Math.floor(nodePosition / 2);
      }
      return { id, proof: {
        count: entries, format: ACCOUNT_HISTORY_PROOF_FORMAT, index: position, siblings,
      } };
    });
    for (const entry of pageEntries) verifyAccountHistoryEntry(entry.id, entry.proof, commitment);
    return pageEntries;
  }
  database.page(address, { limit: 20 });
  legacyPage(entries);
  const pageTimes = [];
  const legacyPageTimes = [];
  for (let index = 0; index < lookups; index += 1) {
    const before = entries - (index % Math.max(1, entries - 20));
    const optimized = () => pageTimes.push(
      elapsed(() => database.page(address, { before, limit: 20 })).milliseconds,
    );
    const previous = () => legacyPageTimes.push(elapsed(() => legacyPage(before)).milliseconds);
    if (index % 2 === 0) { optimized(); previous(); } else { previous(); optimized(); }
  }
  const transactionTimes = [];
  for (let index = 0; index < lookups; index += 1) {
    transactionTimes.push(elapsed(() => database.transactionProof(
      ids[(index * 7919) % ids.length],
    )).milliseconds);
  }
  const storage = database.storageStats();
  legacy.close();
  database.close();
  const rssAfter = process.memoryUsage().rss;
  console.log(JSON.stringify({
    blockSize,
    buildMs: Number(build.milliseconds.toFixed(3)),
    databaseBytes: statSync(path).size,
    entries,
    lookupCount: lookups,
    legacyPage20Ms: {
      p50: Number(percentile(legacyPageTimes, 0.5).toFixed(3)),
      p95: Number(percentile(legacyPageTimes, 0.95).toFixed(3)),
    },
    page20Ms: {
      p50: Number(percentile(pageTimes, 0.5).toFixed(3)),
      p95: Number(percentile(pageTimes, 0.95).toFixed(3)),
    },
    reopenMs: Number(reopen.milliseconds.toFixed(3)),
    rssDeltaBytes: rssAfter - rssBefore,
    storage,
    transactionProofMs: {
      p50: Number(percentile(transactionTimes, 0.5).toFixed(3)),
      p95: Number(percentile(transactionTimes, 0.95).toFixed(3)),
    },
    validateCheckpointMs: Number(validate.milliseconds.toFixed(3)),
  }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

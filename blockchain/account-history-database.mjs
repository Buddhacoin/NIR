import { chmodSync, lstatSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ACCOUNT_HISTORY_DEPTH,
  ACCOUNT_HISTORY_FORMAT,
  ACCOUNT_HISTORY_PROOF_FORMAT,
  accountHistoryEmptyHash,
  accountHistoryLeafHash,
  accountHistoryNodeHash,
  verifyAccountHistoryEntry,
} from "./account-history.mjs";
import { canonicalJson } from "./crypto.mjs";
import { verifyTransactionProof } from "./transaction-tree.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
export const ACCOUNT_HISTORY_DATABASE_FORMAT = "nir-account-history-database";
export const ACCOUNT_HISTORY_DATABASE_SCHEMA_VERSION = 1;

function fileMetadata(path) {
  try { return lstatSync(path); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertSafeDatabaseFiles(target) {
  for (const suffix of ["", "-journal", "-shm", "-wal"]) {
    const metadata = fileMetadata(`${target}${suffix}`);
    if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
      throw new Error("account history database path is unsafe");
    }
  }
}

export class AccountHistoryDatabase {
  #database;
  #statements;

  constructor(path, { reset = false } = {}) {
    const target = resolve(path);
    assertSafeDatabaseFiles(target);
    const initialize = reset || fileMetadata(target) === null;
    if (reset) {
      for (const suffix of ["", "-journal", "-shm", "-wal"]) rmSync(`${target}${suffix}`, { force: true });
    }
    this.#database = new DatabaseSync(target);
    chmodSync(target, 0o600);
    this.#database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA cache_size = -8192;
      PRAGMA temp_store = FILE;
      PRAGMA mmap_size = 0;
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
      PRAGMA foreign_keys = ON;
    `);
    if (initialize) this.#database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS accounts (
        address TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        root TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS history (
        address TEXT NOT NULL,
        position INTEGER NOT NULL,
        transaction_id TEXT NOT NULL,
        PRIMARY KEY (address, position)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS history_transaction ON history(transaction_id);
      CREATE TABLE IF NOT EXISTS nodes (
        address TEXT NOT NULL,
        level INTEGER NOT NULL,
        position INTEGER NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (address, level, position)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        envelope TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = ${ACCOUNT_HISTORY_DATABASE_SCHEMA_VERSION};
    `);
    this.#statements = {
      account: this.#database.prepare("SELECT count, root FROM accounts WHERE address = ?"),
      accountCount: this.#database.prepare("SELECT COUNT(*) AS count FROM accounts"),
      history: this.#database.prepare(`
        SELECT position, transaction_id AS id FROM history
        WHERE address = ? AND position >= ? AND position < ? ORDER BY position
      `),
      insertAccount: this.#database.prepare(`
        INSERT INTO accounts(address, count, root) VALUES (?, ?, ?)
        ON CONFLICT(address) DO UPDATE SET count = excluded.count, root = excluded.root
      `),
      insertHistory: this.#database.prepare(
        "INSERT INTO history(address, position, transaction_id) VALUES (?, ?, ?)",
      ),
      insertNode: this.#database.prepare(`
        INSERT INTO nodes(address, level, position, hash) VALUES (?, ?, ?, ?)
        ON CONFLICT(address, level, position) DO UPDATE SET hash = excluded.hash
      `),
      insertTransaction: this.#database.prepare(
        "INSERT INTO transactions(id, envelope) VALUES (?, ?)",
      ),
      metadata: this.#database.prepare("SELECT value FROM metadata WHERE key = ?"),
      node: this.#database.prepare(
        "SELECT hash FROM nodes WHERE address = ? AND level = ? AND position = ?",
      ),
      setMetadata: this.#database.prepare(`
        INSERT INTO metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `),
      transaction: this.#database.prepare("SELECT envelope FROM transactions WHERE id = ?"),
    };
    if (initialize) {
      this.#statements.setMetadata.run("format", ACCOUNT_HISTORY_DATABASE_FORMAT);
      this.#statements.setMetadata.run("schemaVersion",
        String(ACCOUNT_HISTORY_DATABASE_SCHEMA_VERSION));
    }
  }

  close() { this.#database.close(); }

  appendRecord(record) {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of record.transactions) {
        this.#statements.insertTransaction.run(entry.id, canonicalJson({
          blockHash: record.blockHash,
          height: record.height,
          proof: entry.proof,
          transaction: entry.transaction,
          transactionsRoot: record.transactionsRoot,
        }));
      }
      for (const { address, transactionIds } of record.updates) {
        const current = this.#statements.account.get(address);
        let count = current?.count ?? 0;
        let root = current?.root ?? accountHistoryEmptyHash(ACCOUNT_HISTORY_DEPTH);
        for (const id of transactionIds) {
          let position = count;
          let value = accountHistoryLeafHash(id, position);
          this.#statements.insertHistory.run(address, count, id);
          this.#statements.insertNode.run(address, 0, position, value);
          for (let level = 0; level < ACCOUNT_HISTORY_DEPTH; level += 1) {
            const sibling = this.#statements.node.get(address, level, position ^ 1)?.hash ??
              accountHistoryEmptyHash(level);
            value = position % 2 === 0
              ? accountHistoryNodeHash(value, sibling)
              : accountHistoryNodeHash(sibling, value);
            position = Math.floor(position / 2);
            this.#statements.insertNode.run(address, level + 1, position, value);
          }
          count += 1;
          root = value;
        }
        this.#statements.insertAccount.run(address, count, root);
      }
      this.#statements.setMetadata.run("height", String(record.height));
      this.#statements.setMetadata.run("tipHash", record.blockHash);
      this.#statements.setMetadata.run("networkId", record.networkId);
      this.#statements.setMetadata.run("indexHash", record.indexHash);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  checkpoint() {
    const height = this.#statements.metadata.get("height")?.value ?? "0";
    const tipHash = this.#statements.metadata.get("tipHash")?.value ?? null;
    return {
      format: this.#statements.metadata.get("format")?.value ?? null,
      height: Number(height),
      indexHash: this.#statements.metadata.get("indexHash")?.value ?? null,
      networkId: this.#statements.metadata.get("networkId")?.value ?? null,
      schemaVersion: Number(this.#statements.metadata.get("schemaVersion")?.value ?? 0),
      tipHash,
    };
  }

  sealCheckpoint({ height, indexHash, networkId, tipHash }) {
    if (!Number.isSafeInteger(height) || height < 0 || !HASH.test(indexHash ?? "") ||
        typeof networkId !== "string" || networkId.length === 0 || !HASH.test(tipHash ?? "")) {
      throw new Error("account history database checkpoint is invalid");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#statements.setMetadata.run("height", String(height));
      this.#statements.setMetadata.run("tipHash", tipHash);
      this.#statements.setMetadata.run("networkId", networkId);
      this.#statements.setMetadata.run("indexHash", indexHash);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  commitment(address) {
    if (!ADDRESS.test(address ?? "")) throw new Error("address is invalid");
    const account = this.#statements.account.get(address);
    return account ? { count: account.count, root: account.root } : {
      count: 0,
      root: accountHistoryEmptyHash(ACCOUNT_HISTORY_DEPTH),
    };
  }

  matchesCommitments(expected, { height, indexHash, networkId, tipHash }) {
    try {
      const integrity = this.#database.prepare("PRAGMA quick_check").all();
      const userVersion = this.#database.prepare("PRAGMA user_version").get().user_version;
      if (integrity.length !== 1 || integrity[0].quick_check !== "ok" ||
          userVersion !== ACCOUNT_HISTORY_DATABASE_SCHEMA_VERSION ||
          !(expected instanceof Map) || this.#statements.accountCount.get().count !== expected.size) {
        return false;
      }
      const checkpoint = this.checkpoint();
      if (checkpoint.format !== ACCOUNT_HISTORY_DATABASE_FORMAT ||
          checkpoint.schemaVersion !== ACCOUNT_HISTORY_DATABASE_SCHEMA_VERSION ||
          checkpoint.height !== height || checkpoint.tipHash !== tipHash ||
          checkpoint.networkId !== networkId || checkpoint.indexHash !== indexHash) return false;
      for (const [address, commitment] of expected) {
        const actual = this.commitment(address);
        if (actual.count !== commitment.count || actual.root !== commitment.root) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  page(address, { before, limit = 20 } = {}) {
    if (!ADDRESS.test(address ?? "")) throw new Error("address is invalid");
    const account = this.#statements.account.get(address);
    const count = account?.count ?? 0;
    const end = before === undefined ? count : before;
    if (!Number.isSafeInteger(end) || end < 0 || end > count ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("account history page is invalid");
    }
    const start = Math.max(0, end - limit);
    const entries = this.#statements.history.all(address, start, end).map(({ id, position }) => {
      const siblings = [];
      let nodePosition = position;
      for (let level = 0; level < ACCOUNT_HISTORY_DEPTH; level += 1) {
        siblings.push(this.#statements.node.get(address, level, nodePosition ^ 1)?.hash ??
          accountHistoryEmptyHash(level));
        nodePosition = Math.floor(nodePosition / 2);
      }
      return {
        id,
        index: position,
        proof: {
          count,
          format: ACCOUNT_HISTORY_PROOF_FORMAT,
          index: position,
          siblings,
        },
      };
    });
    if (entries.length !== end - start || (account && !HASH.test(account.root))) {
      throw new Error("account history database is inconsistent");
    }
    if (account) {
      const commitment = { count, format: ACCOUNT_HISTORY_FORMAT, root: account.root };
      for (const entry of entries) verifyAccountHistoryEntry(entry.id, entry.proof, commitment);
    }
    return { count, entries, nextBefore: start === 0 ? null : start, start };
  }

  transactionProof(id) {
    if (!HASH.test(id ?? "")) throw new Error("transaction id is invalid");
    const row = this.#statements.transaction.get(id);
    if (!row) throw new Error("transaction is not found");
    const envelope = JSON.parse(row.envelope);
    if (verifyTransactionProof(
      envelope.transaction, envelope.proof, envelope.transactionsRoot,
    ) !== id) throw new Error("account history database is inconsistent");
    return structuredClone(envelope);
  }
}

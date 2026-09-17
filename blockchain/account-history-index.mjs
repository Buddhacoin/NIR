import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  accountHistoryCommitment,
  createAccountHistoryProofs,
  normalizeAccountHistory,
} from "./account-history.mjs";
import { transactionId } from "./chain.mjs";
import { canonicalJson, hashObject } from "./crypto.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const FORMAT = "nir-account-history-index-v1";
const MAX_RECORD_BYTES = 512 * 1024;
const PRIMARY_DIRECTORY = "account-history-index";
const BACKUP_DIRECTORY = "account-history-index-backup";
const ZERO_HASH = "0".repeat(64);

function fileName(height) {
  if (!Number.isSafeInteger(height) || height < 1) throw new Error("history index height is invalid");
  return `${String(height).padStart(12, "0")}.json`;
}

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "w", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function updatesForBlock(block) {
  const updates = new Map();
  for (const transaction of block.transactions) {
    const id = transactionId(transaction);
    const participants = new Set([transaction.sender, transaction.recipient]
      .filter((address) => ADDRESS.test(address ?? "")));
    for (const address of participants) {
      const ids = updates.get(address) ?? [];
      ids.push(id);
      updates.set(address, ids);
    }
  }
  return [...updates].sort(([left], [right]) => left.localeCompare(right))
    .map(([address, transactionIds]) => ({ address, transactionIds }));
}

function createRecord(block, networkId, previousIndexHash) {
  const payload = {
    blockHash: block.hash,
    format: FORMAT,
    height: block.height,
    networkId,
    previousIndexHash,
    updates: updatesForBlock(block),
  };
  return { ...payload, indexHash: hashObject(payload, "ACCOUNT_HISTORY_INDEX_BLOCK") };
}

function verifyRecord(value, { height, networkId, previousIndexHash }) {
  if (!value || value.format !== FORMAT || value.height !== height || value.networkId !== networkId ||
      value.previousIndexHash !== previousIndexHash || !HASH.test(value.blockHash ?? "") ||
      !HASH.test(value.indexHash ?? "") || !Array.isArray(value.updates)) {
    throw new Error("account history index record header is invalid");
  }
  let previousAddress = null;
  for (const update of value.updates) {
    if (!ADDRESS.test(update?.address ?? "") ||
        (previousAddress !== null && update.address <= previousAddress) ||
        !Array.isArray(update.transactionIds) || update.transactionIds.length === 0 ||
        update.transactionIds.some((id) => !HASH.test(id ?? ""))) {
      throw new Error("account history index updates are invalid");
    }
    previousAddress = update.address;
  }
  const { indexHash, ...payload } = value;
  if (hashObject(payload, "ACCOUNT_HISTORY_INDEX_BLOCK") !== indexHash) {
    throw new Error("account history index checksum mismatch");
  }
  return structuredClone(value);
}

function readCandidate(path, context) {
  try {
    if (statSync(path).size > MAX_RECORD_BYTES) return null;
    return verifyRecord(JSON.parse(readFileSync(path, "utf8")), context);
  }
  catch { return null; }
}

function applyRecord(histories, record) {
  for (const { address, transactionIds } of record.updates) {
    const ids = histories.get(address) ?? [];
    ids.push(...transactionIds);
    histories.set(address, ids);
  }
}

function expectedHistories(chain) {
  const entries = chain.consensusSnapshot().state.accountHistories ?? [];
  return new Map(entries.map(([address, history]) => [address, normalizeAccountHistory(history)]));
}

function matchesChain(histories, chain) {
  const expected = expectedHistories(chain);
  if (histories.size !== expected.size) return false;
  for (const [address, commitment] of expected) {
    const ids = histories.get(address);
    if (!ids) return false;
    const actual = accountHistoryCommitment(ids);
    if (canonicalJson(actual) !== canonicalJson(commitment)) return false;
  }
  return true;
}

function updatesMatchChain(histories, record, chain) {
  return record.updates.every(({ address }) => canonicalJson(
    accountHistoryCommitment(histories.get(address) ?? []),
  ) === canonicalJson(chain.accountState(address).history));
}

function retainedBlocks(chain) {
  return new Map(chain.blocks().filter(({ height }) => height > 0)
    .map((block) => [block.height, block]));
}

export class AccountHistoryIndex {
  #directories;
  #height = 0;
  #histories = new Map();
  #indexHash = ZERO_HASH;
  #networkId;
  #tipHash;

  constructor(directory, chain) {
    const root = resolve(directory);
    this.#directories = [join(root, PRIMARY_DIRECTORY), join(root, BACKUP_DIRECTORY)];
    this.#directories.forEach((path) => mkdirSync(path, { recursive: true, mode: 0o700 }));
    this.#networkId = chain.networkId;
    this.#tipHash = chain.blocks()[0].hash;
    this.#load(chain);
  }

  #write(record) {
    const name = fileName(record.height);
    for (const directory of this.#directories) writeAtomic(join(directory, name), record);
  }

  #reset() {
    this.#height = 0;
    this.#histories = new Map();
    this.#indexHash = ZERO_HASH;
  }

  #load(chain) {
    const retained = retainedBlocks(chain);
    this.#reset();
    for (let height = 1; height <= chain.height; height += 1) {
      const context = { height, networkId: this.#networkId, previousIndexHash: this.#indexHash };
      const name = fileName(height);
      const candidatesByCopy = this.#directories
        .map((directory) => readCandidate(join(directory, name), context));
      const candidates = candidatesByCopy.filter(Boolean);
      if (candidates.length === 2 && candidates[0].indexHash !== candidates[1].indexHash) {
        throw new Error(`account history index copies conflict at height ${height}`);
      }
      const retainedBlock = retained.get(height);
      const canonical = retainedBlock
        ? createRecord(retainedBlock, this.#networkId, this.#indexHash) : null;
      let record = candidates[0] ?? null;
      if (canonical && record?.indexHash !== canonical.indexHash) record = canonical;
      if (!record) {
        if (!canonical) throw new Error(`account history index ${height} cannot be recovered`);
        record = canonical;
      }
      if (retainedBlock && record.blockHash !== retainedBlock.hash) record = canonical;
      candidatesByCopy.forEach((candidate, index) => {
        if (candidate?.indexHash !== record.indexHash) {
          writeAtomic(join(this.#directories[index], name), record);
        }
      });
      applyRecord(this.#histories, record);
      this.#height = height;
      this.#indexHash = record.indexHash;
      this.#tipHash = record.blockHash;
    }
    if (this.#height !== chain.height || this.#tipHash !== chain.tipHash ||
        !matchesChain(this.#histories, chain)) {
      if (chain.blocks()[0].height !== 0) {
        throw new Error("account history index does not match the pruned chain state");
      }
      this.#reset();
      this.#tipHash = chain.blocks()[0].hash;
      for (const block of chain.blocks().slice(1)) this.#append(block);
      if (!matchesChain(this.#histories, chain)) {
        throw new Error("account history index rebuild does not match chain state");
      }
    }
  }

  #append(block) {
    const record = createRecord(block, this.#networkId, this.#indexHash);
    this.#write(record);
    applyRecord(this.#histories, record);
    this.#height = block.height;
    this.#indexHash = record.indexHash;
    this.#tipHash = block.hash;
  }

  appendBlock(block, verifiedChain) {
    if (verifiedChain.networkId !== this.#networkId || block.height !== this.#height + 1 ||
        verifiedChain.height !== block.height || verifiedChain.tipHash !== block.hash) {
      throw new Error("account history index requires the next verified block");
    }
    const record = createRecord(block, this.#networkId, this.#indexHash);
    const nextHistories = new Map([...this.#histories]
      .map(([address, ids]) => [address, [...ids]]));
    applyRecord(nextHistories, record);
    if (!updatesMatchChain(nextHistories, record, verifiedChain)) {
      throw new Error("account history index update does not match chain state");
    }
    this.#write(record);
    this.#histories = nextHistories;
    this.#height = block.height;
    this.#indexHash = record.indexHash;
    this.#tipHash = block.hash;
  }

  page(address, { before, limit = 20 } = {}) {
    if (!ADDRESS.test(address ?? "")) throw new Error("address is invalid");
    const ids = this.#histories.get(address) ?? [];
    const end = before === undefined ? ids.length : before;
    if (!Number.isSafeInteger(end) || end < 0 || end > ids.length ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("account history page is invalid");
    }
    const start = Math.max(0, end - limit);
    const indexes = Array.from({ length: end - start }, (_, offset) => start + offset);
    const proofs = createAccountHistoryProofs(ids, indexes);
    return {
      count: ids.length,
      entries: ids.slice(start, end).map((id, offset) => ({
        id, index: indexes[offset], proof: proofs[offset],
      })),
      nextBefore: start === 0 ? null : start,
      start,
    };
  }
}

export function copyAccountHistoryIndex(sourceDirectory, destinationDirectory, chain) {
  new AccountHistoryIndex(sourceDirectory, chain);
  const source = join(resolve(sourceDirectory), PRIMARY_DIRECTORY);
  const targetDirectories = [
    join(resolve(destinationDirectory), PRIMARY_DIRECTORY),
    join(resolve(destinationDirectory), BACKUP_DIRECTORY),
  ];
  targetDirectories.forEach((path) => mkdirSync(path, { recursive: true, mode: 0o700 }));
  let previousIndexHash = ZERO_HASH;
  for (let height = 1; height <= chain.height; height += 1) {
    const value = readCandidate(join(source, fileName(height)), {
      height, networkId: chain.networkId, previousIndexHash,
    });
    if (!value) throw new Error(`account history index ${height} changed during backup`);
    for (const directory of targetDirectories) writeAtomic(join(directory, fileName(height)), value);
    previousIndexHash = value.indexHash;
  }
  new AccountHistoryIndex(destinationDirectory, chain);
  return { height: chain.height, records: chain.height };
}

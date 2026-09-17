import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import {
  appendAccountHistory,
  emptyAccountHistoryAccumulator,
  normalizeAccountHistory,
  normalizeAccountHistoryAccumulator,
} from "./account-history.mjs";
import { transactionId } from "./chain.mjs";
import { MAX_BLOCK_BYTES } from "./constants.mjs";
import { canonicalJson, hashObject } from "./crypto.mjs";
import {
  createTransactionProofs,
  verifyTransactionProof,
} from "./transaction-tree.mjs";
import { AccountHistoryDatabase } from "./account-history-database.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const FORMAT = "nir-account-history-index-v2";
const MAX_RECORD_BYTES = MAX_BLOCK_BYTES * 4;
const PRIMARY_DIRECTORY = "account-history-index";
const BACKUP_DIRECTORY = "account-history-index-backup";
const INSTALL_DIRECTORY = ".account-history-index-install";
const INSTALL_MARKER = "ACCOUNT-HISTORY-INSTALL.json";
const INSTALL_FORMAT = "nir-account-history-install-v1";
const DATABASE_FILE = "account-history.sqlite";
const ZERO_HASH = "0".repeat(64);

function fileName(height) {
  if (!Number.isSafeInteger(height) || height < 1) throw new Error("history index height is invalid");
  return `${String(height).padStart(12, "0")}.json`;
}

function syncDirectory(path) {
  const descriptor = openSync(path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function ensureRealDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("account history directory is unsafe");
  }
}

function readBoundedRegularFile(path, maximumBytes) {
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw new Error("account history file is unsafe");
    }
    const contents = readFileSync(descriptor);
    if (contents.length > maximumBytes) throw new Error("account history file is too large");
    return contents;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeAtomic(path, value) {
  const parent = dirname(path);
  const parentMetadata = lstatSync(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("account history destination directory is unsafe");
  }
  const temporary = join(dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT |
      fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
    closeSync(descriptor);
    descriptor = undefined;
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
  const indexes = block.transactions.map((_, index) => index);
  const proofs = createTransactionProofs(block.transactions, indexes);
  const payload = {
    blockHash: block.hash,
    format: FORMAT,
    height: block.height,
    networkId,
    previousIndexHash,
    transactions: block.transactions.map((transaction, index) => ({
      id: transactionId(transaction), index, proof: proofs[index], transaction,
    })),
    transactionsRoot: block.transactionsRoot,
    updates: updatesForBlock(block),
  };
  return { ...payload, indexHash: hashObject(payload, "ACCOUNT_HISTORY_INDEX_BLOCK") };
}

function verifyRecord(value, { height, networkId, previousIndexHash }) {
  if (!value || value.format !== FORMAT || value.height !== height || value.networkId !== networkId ||
      value.previousIndexHash !== previousIndexHash || !HASH.test(value.blockHash ?? "") ||
      !HASH.test(value.indexHash ?? "") || !HASH.test(value.transactionsRoot ?? "") ||
      !Array.isArray(value.transactions) || !Array.isArray(value.updates)) {
    throw new Error("account history index record header is invalid");
  }
  const transactionIds = new Set();
  for (const [index, entry] of value.transactions.entries()) {
    if (!entry || entry.index !== index || entry.proof?.index !== index ||
        entry.proof?.count !== value.transactions.length || !HASH.test(entry.id ?? "") ||
        verifyTransactionProof(entry.transaction, entry.proof, value.transactionsRoot) !== entry.id ||
        transactionIds.has(entry.id)) {
      throw new Error("account history transaction index is invalid");
    }
    transactionIds.add(entry.id);
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
    return verifyRecord(JSON.parse(readBoundedRegularFile(path, MAX_RECORD_BYTES).toString("utf8")),
      context);
  }
  catch { return null; }
}

function readSelfVerifiedCandidate(path, { height, networkId }) {
  try {
    const value = JSON.parse(readBoundedRegularFile(path, MAX_RECORD_BYTES).toString("utf8"));
    if (!HASH.test(value?.previousIndexHash ?? "")) return null;
    return verifyRecord(value, { height, networkId, previousIndexHash: value.previousIndexHash });
  } catch { return null; }
}

function applyAccumulatorUpdates(accumulators, record) {
  for (const { address, transactionIds } of record.updates) {
    let accumulator = accumulators.get(address) ?? emptyAccountHistoryAccumulator();
    for (const id of transactionIds) accumulator = appendAccountHistory(accumulator, id);
    accumulators.set(address, accumulator);
  }
}

function expectedHistories(chain) {
  const entries = chain.consensusSnapshot().state.accountHistories ?? [];
  return new Map(entries.map(([address, history]) => [address, normalizeAccountHistory(history)]));
}

function expectedAccumulators(chain) {
  const entries = chain.consensusSnapshot().state.accountHistories ?? [];
  return new Map(entries.map(([address, history]) => [
    address, normalizeAccountHistoryAccumulator(history),
  ]));
}

function verifyLatestRecordCopies(directories, chain, expectedIndexHash) {
  if (chain.height === 0) return expectedIndexHash === ZERO_HASH;
  const name = fileName(chain.height);
  const candidates = directories.map((directory) => readSelfVerifiedCandidate(
    join(directory, name), { height: chain.height, networkId: chain.networkId },
  ));
  const valid = candidates.filter((record) => record && record.indexHash === expectedIndexHash &&
    record.blockHash === chain.tipHash);
  if (valid.length === 0 || (candidates.every(Boolean) &&
      candidates[0].indexHash !== candidates[1].indexHash)) return false;
  candidates.forEach((candidate, index) => {
    if (!candidate || candidate.indexHash !== expectedIndexHash) {
      writeAtomic(join(directories[index], name), valid[0]);
    }
  });
  return true;
}

function accumulatorsMatchChain(accumulators, chain) {
  const expected = expectedHistories(chain);
  if (accumulators.size !== expected.size) return false;
  for (const [address, commitment] of expected) {
    if (canonicalJson(normalizeAccountHistory(accumulators.get(address))) !==
        canonicalJson(commitment)) return false;
  }
  return true;
}

function updatesMatchChain(accumulators, record, chain) {
  return record.updates.every(({ address, transactionIds }) => {
    let accumulator = accumulators.get(address) ?? emptyAccountHistoryAccumulator();
    for (const id of transactionIds) accumulator = appendAccountHistory(accumulator, id);
    return canonicalJson(normalizeAccountHistory(accumulator)) ===
      canonicalJson(chain.accountState(address).history);
  });
}

function retainedBlocks(chain) {
  return new Map(chain.blocks().filter(({ height }) => height > 0)
    .map((block) => [block.height, block]));
}

function *recordDirectoryEntries(directory, chain) {
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("account history record directory is unsafe");
  }
  let previousIndexHash = ZERO_HASH;
  for (let height = 1; height <= chain.height; height += 1) {
    const record = readCandidate(join(directory, fileName(height)), {
      height, networkId: chain.networkId, previousIndexHash,
    });
    if (!record) throw new Error(`account history index ${height} is unavailable`);
    previousIndexHash = record.indexHash;
    yield record;
  }
}

function verifyRecordDirectory(directory, chain) {
  try {
    verifyAccountHistoryIndexRecordIterable(recordDirectoryEntries(directory, chain), chain);
    return true;
  } catch { return false; }
}

function readInstallMarker(root, chain) {
  const path = join(root, INSTALL_MARKER);
  let marker;
  try {
    marker = JSON.parse(readBoundedRegularFile(path, 64 * 1024).toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("account history installation marker is invalid");
  }
  if (marker?.format !== INSTALL_FORMAT || marker.networkId !== chain.networkId ||
      marker.height !== chain.height || marker.tipHash !== chain.tipHash) {
    throw new Error("account history installation marker does not match the chain");
  }
  return marker;
}

function copyRecordSet(source, destination, chain) {
  if (!verifyRecordDirectory(source, chain)) return false;
  rmSync(destination, { recursive: true, force: true });
  ensureRealDirectory(destination);
  for (const record of recordDirectoryEntries(source, chain)) {
    writeAtomic(join(destination, fileName(record.height)), record);
  }
  return verifyRecordDirectory(destination, chain);
}

function finishPreparedInstallation(root, chain) {
  if (!readInstallMarker(root, chain)) return false;
  const staging = join(root, INSTALL_DIRECTORY);
  const candidates = [
    join(staging, PRIMARY_DIRECTORY),
    join(staging, BACKUP_DIRECTORY),
    join(root, PRIMARY_DIRECTORY),
    join(root, BACKUP_DIRECTORY),
  ];
  const source = candidates.find((directory) => verifyRecordDirectory(directory, chain));
  if (!source) throw new Error("prepared account history installation cannot be recovered");
  const live = [join(root, PRIMARY_DIRECTORY), join(root, BACKUP_DIRECTORY)];
  for (const directory of live) {
    if (directory !== source && !copyRecordSet(source, directory, chain)) {
      throw new Error("prepared account history installation did not verify");
    }
  }
  if (live.some((directory) => !verifyRecordDirectory(directory, chain))) {
    throw new Error("prepared account history installation did not verify");
  }
  rmSync(join(root, INSTALL_MARKER));
  syncDirectory(root);
  rmSync(staging, { recursive: true, force: true });
  syncDirectory(root);
  return true;
}

export class AccountHistoryIndex {
  #accumulators = new Map();
  #database;
  #databasePath;
  #directories;
  #height = 0;
  #indexHash = ZERO_HASH;
  #networkId;
  #tipHash;

  constructor(directory, chain) {
    const root = resolve(directory);
    ensureRealDirectory(root);
    finishPreparedInstallation(root, chain);
    this.#directories = [join(root, PRIMARY_DIRECTORY), join(root, BACKUP_DIRECTORY)];
    this.#directories.forEach(ensureRealDirectory);
    this.#networkId = chain.networkId;
    this.#tipHash = chain.blocks()[0].hash;
    const liveDatabase = join(root, DATABASE_FILE);
    try {
      const database = new AccountHistoryDatabase(liveDatabase);
      const checkpoint = database.checkpoint();
      if (HASH.test(checkpoint.indexHash ?? "") &&
          verifyLatestRecordCopies(this.#directories, chain, checkpoint.indexHash) &&
          database.matchesCommitments(expectedHistories(chain), {
            height: chain.height,
            indexHash: checkpoint.indexHash,
            networkId: chain.networkId,
            tipHash: chain.tipHash,
          })) {
        this.#accumulators = expectedAccumulators(chain);
        this.#database = database;
        this.#databasePath = liveDatabase;
        this.#height = chain.height;
        this.#indexHash = checkpoint.indexHash;
        this.#tipHash = chain.tipHash;
        return;
      }
      database.close();
    } catch {
      // A corrupt or incompatible cache is rebuilt from the verified redundant journals below.
    }
    this.#databasePath = `${liveDatabase}.${process.pid}.rebuild`;
    this.#database = new AccountHistoryDatabase(this.#databasePath, { reset: true });
    try {
      this.#load(chain);
      this.#database.sealCheckpoint({
        height: this.#height,
        indexHash: this.#indexHash,
        networkId: this.#networkId,
        tipHash: this.#tipHash,
      });
      if (!this.#database.matchesCommitments(expectedHistories(chain), {
        height: chain.height,
        indexHash: this.#indexHash,
        networkId: chain.networkId,
        tipHash: chain.tipHash,
      })) throw new Error("account history database does not match chain state");
      this.#database.close();
      this.#database = undefined;
      for (const suffix of ["", "-journal", "-shm", "-wal"]) {
        rmSync(`${liveDatabase}${suffix}`, { force: true });
      }
      renameSync(this.#databasePath, liveDatabase);
      syncDirectory(root);
      this.#databasePath = liveDatabase;
      this.#database = new AccountHistoryDatabase(liveDatabase);
    } catch (error) {
      this.#database?.close();
      for (const suffix of ["", "-journal", "-shm", "-wal"]) {
        rmSync(`${this.#databasePath}${suffix}`, { force: true });
      }
      throw error;
    }
  }

  #write(record) {
    const name = fileName(record.height);
    for (const directory of this.#directories) writeAtomic(join(directory, name), record);
  }

  #reset() {
    this.#accumulators = new Map();
    this.#height = 0;
    this.#indexHash = ZERO_HASH;
  }

  #resetDatabase() {
    this.#database.close();
    this.#database = new AccountHistoryDatabase(this.#databasePath, { reset: true });
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
      let record = candidates[0] ?? null;
      const matchesRetained = !retainedBlock || (record &&
        record.blockHash === retainedBlock.hash &&
        record.transactionsRoot === retainedBlock.transactionsRoot &&
        record.transactions.length === retainedBlock.transactions.length);
      const canonical = retainedBlock && !matchesRetained
        ? createRecord(retainedBlock, this.#networkId, this.#indexHash) : null;
      if (canonical) record = canonical;
      if (!record) {
        if (!retainedBlock) throw new Error(`account history index ${height} cannot be recovered`);
        record = createRecord(retainedBlock, this.#networkId, this.#indexHash);
      }
      candidatesByCopy.forEach((candidate, index) => {
        if (candidate?.indexHash !== record.indexHash) {
          writeAtomic(join(this.#directories[index], name), record);
        }
      });
      this.#database.appendRecord(record);
      applyAccumulatorUpdates(this.#accumulators, record);
      this.#height = height;
      this.#indexHash = record.indexHash;
      this.#tipHash = record.blockHash;
    }
    if (this.#height !== chain.height || this.#tipHash !== chain.tipHash ||
        !accumulatorsMatchChain(this.#accumulators, chain)) {
      if (chain.blocks()[0].height !== 0) {
        throw new Error("account history index does not match the pruned chain state");
      }
      this.#reset();
      this.#resetDatabase();
      this.#tipHash = chain.blocks()[0].hash;
      for (const block of chain.blocks().slice(1)) this.#append(block);
      if (!accumulatorsMatchChain(this.#accumulators, chain)) {
        throw new Error("account history index rebuild does not match chain state");
      }
    }
  }

  #append(block) {
    const record = createRecord(block, this.#networkId, this.#indexHash);
    this.#write(record);
    this.#database.appendRecord(record);
    applyAccumulatorUpdates(this.#accumulators, record);
    for (const { address } of record.updates) {
      const expected = normalizeAccountHistory(this.#accumulators.get(address));
      const actual = this.#database.commitment(address);
      if (actual.count !== expected.count || actual.root !== expected.root) {
        throw new Error("account history database update does not match chain state");
      }
    }
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
    if (!updatesMatchChain(this.#accumulators, record, verifiedChain)) {
      throw new Error("account history index update does not match chain state");
    }
    this.#write(record);
    this.#database.appendRecord(record);
    applyAccumulatorUpdates(this.#accumulators, record);
    for (const { address } of record.updates) {
      const expected = normalizeAccountHistory(this.#accumulators.get(address));
      const actual = this.#database.commitment(address);
      if (actual.count !== expected.count || actual.root !== expected.root) {
        throw new Error("account history database update does not match chain state");
      }
    }
    this.#height = block.height;
    this.#indexHash = record.indexHash;
    this.#tipHash = block.hash;
  }

  page(address, { before, limit = 20 } = {}) {
    return this.#database.page(address, { before, limit });
  }

  transactionProof(id) {
    return this.#database.transactionProof(id);
  }
}

export function copyAccountHistoryIndex(sourceDirectory, destinationDirectory, chain) {
  new AccountHistoryIndex(sourceDirectory, chain);
  const source = join(resolve(sourceDirectory), PRIMARY_DIRECTORY);
  const targetDirectories = [
    join(resolve(destinationDirectory), PRIMARY_DIRECTORY),
    join(resolve(destinationDirectory), BACKUP_DIRECTORY),
  ];
  targetDirectories.forEach(ensureRealDirectory);
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

export function readAccountHistoryIndexRecords(directory, chain) {
  new AccountHistoryIndex(directory, chain);
  const source = join(resolve(directory), PRIMARY_DIRECTORY);
  const records = [];
  let previousIndexHash = ZERO_HASH;
  for (let height = 1; height <= chain.height; height += 1) {
    const record = readCandidate(join(source, fileName(height)), {
      height, networkId: chain.networkId, previousIndexHash,
    });
    if (!record) throw new Error(`account history index ${height} changed during export`);
    records.push(record);
    previousIndexHash = record.indexHash;
  }
  return records;
}

export function verifyAccountHistoryIndexRecords(records, chain) {
  if (!Array.isArray(records) || records.length !== chain.height) {
    throw new Error("account history archive record count is invalid");
  }
  return verifyAccountHistoryIndexRecordIterable(records, chain, { collect: true });
}

export function verifyAccountHistoryIndexRecord(record, context) {
  return verifyRecord(record, context);
}

export function verifyAccountHistoryIndexRecordIterable(records, chain, {
  collect = false,
  onRecord,
} = {}) {
  if (!records || typeof records[Symbol.iterator] !== "function" ||
      (onRecord !== undefined && typeof onRecord !== "function")) {
    throw new Error("account history archive records are invalid");
  }
  const accumulators = new Map();
  const transactions = new Set();
  const retained = retainedBlocks(chain);
  let previousIndexHash = ZERO_HASH;
  let tipHash = chain.blocks()[0].hash;
  let count = 0;
  const verified = collect ? [] : null;
  for (const candidate of records) {
    const height = count + 1;
    if (height > chain.height) throw new Error("account history archive has extra records");
    const record = verifyRecord(candidate, {
      height, networkId: chain.networkId, previousIndexHash,
    });
    const block = retained.get(height);
    if (block && (record.blockHash !== block.hash ||
        record.transactionsRoot !== block.transactionsRoot ||
        record.transactions.length !== block.transactions.length)) {
      throw new Error(`account history archive conflicts with block ${height}`);
    }
    for (const entry of record.transactions) {
      if (transactions.has(entry.id)) throw new Error("duplicate transaction in history index");
      transactions.add(entry.id);
    }
    applyAccumulatorUpdates(accumulators, record);
    if (onRecord) onRecord(record);
    if (verified) verified.push(record);
    previousIndexHash = record.indexHash;
    tipHash = record.blockHash;
    count += 1;
  }
  if (count !== chain.height || tipHash !== chain.tipHash ||
      !accumulatorsMatchChain(accumulators, chain)) {
    throw new Error("account history archive does not match chain state");
  }
  return verified ?? { records: count, tipHash };
}

export function installAccountHistoryIndexRecords(directory, records, chain) {
  if (!Array.isArray(records)) throw new Error("account history archive records are invalid");
  return installAccountHistoryIndexRecordIterable(directory, records, chain);
}

export function installAccountHistoryIndexRecordIterable(directory, records, chain) {
  const root = resolve(directory);
  ensureRealDirectory(root);
  finishPreparedInstallation(root, chain);
  const staging = join(root, INSTALL_DIRECTORY);
  rmSync(staging, { recursive: true, force: true });
  const stagedCopies = [join(staging, PRIMARY_DIRECTORY), join(staging, BACKUP_DIRECTORY)];
  stagedCopies.forEach(ensureRealDirectory);
  const verified = verifyAccountHistoryIndexRecordIterable(records, chain, {
    onRecord(record) {
      for (const path of stagedCopies) {
        writeAtomic(join(path, fileName(record.height)), record);
      }
    },
  });
  for (const path of stagedCopies) {
    if (!verifyRecordDirectory(path, chain)) {
      throw new Error("staged account history installation did not verify");
    }
  }
  writeAtomic(join(root, INSTALL_MARKER), {
    format: INSTALL_FORMAT,
    height: chain.height,
    networkId: chain.networkId,
    tipHash: chain.tipHash,
  });
  finishPreparedInstallation(root, chain);
  new AccountHistoryIndex(root, chain);
  return { height: chain.height, records: verified.records, tipHash: chain.tipHash };
}

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AccountHistoryIndex, readAccountHistoryIndexRecords } from "./account-history-index.mjs";
import { loadBlockStore } from "./block-store.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import {
  addressFromPublicKey,
  canonicalJson,
  hashObject,
  publicWallet,
  signObject,
  verifyObject,
} from "./crypto.mjs";

const RECEIPT_FORMAT = "nir-remote-backup-receipt-v1";
const INVENTORY_FORMAT = "nir-portable-backup-inventory-v1";
const DRILL_FORMAT = "nir-backup-restore-drill-v1";
const HASH = /^[0-9a-f]{64}$/;
const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const ALLOWED_DIRECTORIES = new Set([
  "account-history-index", "account-history-index-backup", "block-backups", "blocks", "snapshots",
]);
const ALLOWED_FILES = new Set([
  "account-history.sqlite", "genesis.json", "STORE-CHECKPOINT.backup.json", "STORE-CHECKPOINT.json",
]);
export const MAX_BACKUP_FILES = 200_000;
export const MAX_BACKUP_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_BACKUP_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_BACKUP_INVENTORY_BYTES = 32 * 1024 * 1024;
export const MAX_BACKUP_RECEIPT_BYTES = 128 * 1024;
const MAX_SOURCE_BYTES = 256;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function sha256(contents) { return createHash("sha256").update(contents).digest("hex"); }
function portablePath(path) { return path.split(sep).join("/"); }

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeAtomic(path, value) {
  const target = resolve(path);
  const temporary = `${target}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    syncDirectory(dirname(target));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value) > 1024 ||
      value.startsWith("/") || value.includes("\\") || value.split("/").some((part) =>
        part.length < 1 || part === "." || part === "..")) {
    throw new Error("backup inventory path is invalid");
  }
  return value;
}

function allowedBackupPath(path) {
  const [first, ...rest] = path.split("/");
  return rest.length === 0 ? ALLOWED_FILES.has(first) : ALLOWED_DIRECTORIES.has(first);
}

export function createBackupInventory(directory, {
  maxFiles = MAX_BACKUP_FILES,
  maxFileBytes = MAX_BACKUP_FILE_BYTES,
  maxTotalBytes = MAX_BACKUP_TOTAL_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_BACKUP_FILES ||
      !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_BACKUP_FILE_BYTES ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 ||
      maxTotalBytes > MAX_BACKUP_TOTAL_BYTES) throw new Error("backup inventory policy is invalid");
  const root = resolve(directory);
  const files = [];
  let totalBytes = 0;
  const walk = (path) => {
    const entries = readdirSync(path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = join(path, entry.name);
      const metadata = lstatSync(target);
      if (metadata.isSymbolicLink()) throw new Error("backup cannot contain symbolic links");
      if (entry.isDirectory()) { walk(target); continue; }
      if (!entry.isFile()) throw new Error("backup contains a non-regular file");
      const name = safeRelativePath(portablePath(relative(root, target)));
      if (!allowedBackupPath(name)) throw new Error(`backup contains disallowed file ${name}`);
      if (metadata.size > maxFileBytes) throw new Error("one backup file exceeds the size limit");
      totalBytes += metadata.size;
      if (totalBytes > maxTotalBytes) throw new Error("backup exceeds the total size limit");
      if (files.length >= maxFiles) throw new Error("backup contains too many files");
      const contents = readFileSync(target);
      files.push({ bytes: contents.length, path: name, sha256: sha256(contents) });
    }
  };
  walk(root);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (files.length === 0 || !files.some(({ path }) => path === "genesis.json") ||
      !files.some(({ path }) => path === "STORE-CHECKPOINT.json")) {
    throw new Error("portable backup is incomplete");
  }
  const inventory = { files, format: INVENTORY_FORMAT, totalBytes };
  if (Buffer.byteLength(canonicalJson(inventory)) > MAX_BACKUP_INVENTORY_BYTES) {
    throw new Error("backup inventory is too large");
  }
  return { ...inventory, inventoryRoot: hashObject(inventory, "BACKUP_INVENTORY") };
}

function readHistoryIndexHash(directory) {
  const database = new DatabaseSync(join(resolve(directory), "account-history.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database.prepare("SELECT value FROM metadata WHERE key = 'indexHash'").get();
    if (!HASH.test(row?.value ?? "")) throw new Error("backup history checkpoint is missing");
    return row.value;
  } finally { database.close(); }
}

function historyContentRoot(directory, chain) {
  const records = readAccountHistoryIndexRecords(directory, chain);
  return hashObject(records.map(({ blockHash, height, indexHash }) => ({
    blockHash, height, indexHash,
  })), "HISTORY_ARCHIVE_CONTENT");
}

function readSnapshotHash(directory) {
  const path = join(resolve(directory), "snapshots", "STATE-SNAPSHOT.json");
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!HASH.test(value?.snapshotHash ?? "")) throw new Error("backup snapshot hash is invalid");
  return value.snapshotHash;
}

function validateOperatorId(value) {
  if (!OPERATOR_ID.test(value ?? "")) throw new Error("backup operator id is invalid");
  return value;
}

export function createSignedBackupReceipt(directory, genesis, wallet, {
  createdAt = Date.now(), operatorId, sourceId,
} = {}) {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || typeof sourceId !== "string" ||
      sourceId.length < 1 || Buffer.byteLength(sourceId) > MAX_SOURCE_BYTES) {
    throw new Error("backup receipt context is invalid");
  }
  validateOperatorId(operatorId);
  const loaded = loadBlockStore(directory, genesis);
  new AccountHistoryIndex(directory, loaded.chain);
  const inventory = createBackupInventory(directory);
  const payload = {
    checkpointHash: loaded.checkpoint.checkpointHash,
    createdAt,
    format: RECEIPT_FORMAT,
    height: loaded.chain.height,
    historyContentRoot: historyContentRoot(directory, loaded.chain),
    historyIndexHash: readHistoryIndexHash(directory),
    inventoryRoot: inventory.inventoryRoot,
    networkId: loaded.chain.networkId,
    operatorId,
    privateKeysIncluded: false,
    snapshotHash: readSnapshotHash(directory),
    sourceId,
    stateRoot: loaded.chain.stateRoot,
    tipHash: loaded.chain.tipHash,
    totalBytes: inventory.totalBytes,
    totalFiles: inventory.files.length,
  };
  const receiptHash = hashObject(payload, "REMOTE_BACKUP_RECEIPT");
  return {
    payload: { ...payload, receiptHash },
    signature: signObject({ receiptHash }, wallet, "REMOTE_BACKUP_RECEIPT"),
    signer: publicWallet(wallet),
  };
}

function trustedOperatorMap(trustedOperators) {
  if (!Array.isArray(trustedOperators) || trustedOperators.length < 2 ||
      trustedOperators.length > 128) throw new Error("backup operators are invalid");
  const result = new Map();
  const ids = new Set();
  for (const operator of trustedOperators) {
    if (operator?.algorithm !== SIGNATURE_ALGORITHM ||
        addressFromPublicKey(operator.publicKey ?? "") !== operator.address ||
        !OPERATOR_ID.test(operator.operatorId ?? "") || result.has(operator.address) ||
        ids.has(operator.operatorId)) throw new Error("backup operator is invalid");
    result.set(operator.address, operator);
    ids.add(operator.operatorId);
  }
  return result;
}

export function verifySignedBackupReceipt(receipt, {
  maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now(), trustedOperators,
} = {}) {
  const operators = trustedOperatorMap(trustedOperators);
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 ||
      maxAgeMs > 365 * 24 * 60 * 60 * 1000 ||
      Buffer.byteLength(canonicalJson(receipt)) > MAX_BACKUP_RECEIPT_BYTES) {
    throw new Error("backup receipt policy is invalid");
  }
  const signer = receipt?.signer;
  const operator = operators.get(signer?.address);
  const { receiptHash, ...payload } = receipt?.payload ?? {};
  if (!operator || signer.algorithm !== operator.algorithm || signer.publicKey !== operator.publicKey ||
      payload?.format !== RECEIPT_FORMAT || payload.operatorId !== operator.operatorId ||
      !Number.isSafeInteger(payload.createdAt) || payload.createdAt < 0 ||
      payload.createdAt > now + 5 * 60 * 1000 || now - payload.createdAt > maxAgeMs ||
      typeof payload.sourceId !== "string" || payload.sourceId.length < 1 ||
      Buffer.byteLength(payload.sourceId) > MAX_SOURCE_BYTES ||
      typeof payload.networkId !== "string" || payload.networkId.length < 1 ||
      !Number.isSafeInteger(payload.height) || payload.height < 0 ||
      !HASH.test(payload.checkpointHash ?? "") || !HASH.test(payload.historyContentRoot ?? "") ||
      !HASH.test(payload.historyIndexHash ?? "") ||
      !HASH.test(payload.inventoryRoot ?? "") || !HASH.test(payload.stateRoot ?? "") ||
      !HASH.test(payload.tipHash ?? "") ||
      (payload.snapshotHash !== null && !HASH.test(payload.snapshotHash ?? "")) ||
      payload.privateKeysIncluded !== false || !Number.isSafeInteger(payload.totalBytes) ||
      payload.totalBytes < 1 || payload.totalBytes > MAX_BACKUP_TOTAL_BYTES ||
      !Number.isSafeInteger(payload.totalFiles) || payload.totalFiles < 1 ||
      payload.totalFiles > MAX_BACKUP_FILES ||
      receiptHash !== hashObject(payload, "REMOTE_BACKUP_RECEIPT") ||
      !verifyObject({ receiptHash }, receipt.signature, signer.publicKey, "REMOTE_BACKUP_RECEIPT")) {
    throw new Error("backup receipt is invalid, stale, or untrusted");
  }
  return { ...structuredClone(payload), receiptHash, signer: structuredClone(signer) };
}

export function selectBackupReceipts(candidates, options = {}) {
  const minimumSources = options.minimumSources ?? 2;
  if (!Array.isArray(candidates) || candidates.length < minimumSources || candidates.length > 128 ||
      !Number.isSafeInteger(minimumSources) || minimumSources < 2 || minimumSources > 128) {
    throw new Error("backup receipt candidates are invalid");
  }
  const sources = new Set();
  const signers = new Set();
  const operators = new Set();
  const valid = [];
  for (const candidate of candidates) {
    if (typeof candidate?.source !== "string" || sources.has(candidate.source) ||
        Buffer.byteLength(candidate.source) > MAX_SOURCE_BYTES) {
      throw new Error("backup receipt sources must be unique");
    }
    sources.add(candidate.source);
    try {
      const verified = verifySignedBackupReceipt(candidate.receipt, options);
      if (verified.sourceId !== candidate.source) throw new Error("backup receipt source mismatch");
      if (signers.has(verified.signer.address) || operators.has(verified.operatorId)) {
        throw new Error("backup receipt operators must be independent");
      }
      signers.add(verified.signer.address);
      operators.add(verified.operatorId);
      valid.push({ ...verified, receipt: candidate.receipt, source: candidate.source });
    } catch (error) {
      if (error.message.includes("independent") || error.message.includes("source mismatch")) throw error;
    }
  }
  const groups = new Map();
  for (const receipt of valid) {
    const key = [receipt.networkId, receipt.height, receipt.tipHash, receipt.stateRoot,
      receipt.checkpointHash, receipt.historyContentRoot, receipt.historyIndexHash, receipt.snapshotHash,
      receipt.inventoryRoot].join(":");
    const group = groups.get(key) ?? [];
    group.push(receipt);
    groups.set(key, group);
  }
  if (groups.size > 1) throw new Error("trusted backup operators returned conflicting receipts");
  const selected = [...groups.values()].find((group) => group.length >= minimumSources);
  if (!selected) throw new Error("backup lacks enough independent fresh receipts");
  return selected;
}

function validateInventory(inventory, expectedRoot) {
  const { inventoryRoot, ...payload } = inventory ?? {};
  if (payload.format !== INVENTORY_FORMAT || !Array.isArray(payload.files) ||
      payload.files.length < 1 || payload.files.length > MAX_BACKUP_FILES ||
      !Number.isSafeInteger(payload.totalBytes) || payload.totalBytes < 1 ||
      payload.totalBytes > MAX_BACKUP_TOTAL_BYTES ||
      Buffer.byteLength(canonicalJson(payload)) > MAX_BACKUP_INVENTORY_BYTES ||
      inventoryRoot !== expectedRoot || inventoryRoot !== hashObject(payload, "BACKUP_INVENTORY")) {
    throw new Error("backup inventory is invalid");
  }
  let total = 0;
  let previous = null;
  for (const file of payload.files) {
    safeRelativePath(file?.path);
    if (!allowedBackupPath(file.path) || (previous !== null && file.path <= previous) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_BACKUP_FILE_BYTES ||
        !/^[0-9a-f]{64}$/.test(file.sha256 ?? "")) throw new Error("backup inventory file is invalid");
    previous = file.path;
    total += file.bytes;
  }
  if (total !== payload.totalBytes) throw new Error("backup inventory byte count is invalid");
  return structuredClone(inventory);
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store", "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export function createBackupHttpServer(directory, receipt) {
  const root = resolve(directory);
  const inventory = createBackupInventory(root);
  if (receipt?.payload?.inventoryRoot !== inventory.inventoryRoot) {
    throw new Error("backup receipt does not match served content");
  }
  const byPath = new Map(inventory.files.map((file) => [file.path, file]));
  const server = createServer((request, response) => {
    if (request.method !== "GET") { json(response, 405, { error: "method not allowed" }); return; }
    let url;
    try { url = new URL(request.url, "http://backup.invalid"); }
    catch { json(response, 400, { error: "invalid URL" }); return; }
    if (url.search || url.hash) { json(response, 400, { error: "query is unsupported" }); return; }
    if (url.pathname === "/v1/backup/receipt") { json(response, 200, receipt); return; }
    if (url.pathname === "/v1/backup/inventory") { json(response, 200, inventory); return; }
    const match = /^\/v1\/backup\/files\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (!match) { json(response, 404, { error: "not found" }); return; }
    let path;
    try { path = Buffer.from(match[1], "base64url").toString("utf8"); }
    catch { json(response, 400, { error: "invalid file id" }); return; }
    const expected = byPath.get(path);
    if (!expected) { json(response, 404, { error: "not found" }); return; }
    try {
      const target = join(root, ...path.split("/"));
      const metadata = lstatSync(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== expected.bytes) {
        throw new Error("changed");
      }
      const contents = readFileSync(target);
      if (sha256(contents) !== expected.sha256) throw new Error("changed");
      response.writeHead(200, {
        "cache-control": "public, immutable, max-age=31536000",
        "content-length": contents.length, "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
      });
      response.end(contents);
    } catch { json(response, 409, { error: "backup changed after receipt" }); }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

function normalizedSource(value, allowInsecureLocalhost) {
  let url;
  try { url = new URL(value); } catch { throw new Error("backup source URL is invalid"); }
  const localhost = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(allowInsecureLocalhost && localhost && url.protocol === "http:"))) {
    throw new Error("backup source must use HTTPS");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  const source = url.href.replace(/\/$/, "");
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw new Error("backup source URL is too long");
  return { source, url };
}

async function boundedBuffer(response, maximumBytes) {
  if (!response.ok) throw new Error(`backup HTTP status ${response.status}`);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error("backup response is too large");
  }
  if (!response.body) throw new Error("backup response has no body");
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) { await reader.cancel(); throw new Error("backup response is too large"); }
      parts.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts, length);
}

async function getRemote(sourceValue, path, maximumBytes, options) {
  const { source, url } = normalizedSource(sourceValue, options.allowInsecureLocalhost ?? false);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("backup fetch is unavailable");
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("backup timeout policy is invalid");
  }
  const response = await fetchImpl(new URL(path, url), {
    redirect: "error", signal: AbortSignal.timeout(timeoutMs),
  });
  return { bytes: await boundedBuffer(response, maximumBytes), source };
}

async function fetchReceipt(source, options) {
  const result = await getRemote(source, "v1/backup/receipt", MAX_BACKUP_RECEIPT_BYTES, options);
  try { return { receipt: JSON.parse(result.bytes.toString("utf8")), source: result.source }; }
  catch { throw new Error("backup receipt JSON is invalid"); }
}

function verifyDownloadedDirectory(directory, inventory) {
  const actual = createBackupInventory(directory);
  if (actual.inventoryRoot !== inventory.inventoryRoot) throw new Error("downloaded backup root mismatch");
}

async function downloadProvider(provider, workspace, options) {
  const inventoryResponse = await getRemote(
    provider.source, "v1/backup/inventory", MAX_BACKUP_INVENTORY_BYTES, options,
  );
  let inventory;
  try { inventory = JSON.parse(inventoryResponse.bytes.toString("utf8")); }
  catch { throw new Error("backup inventory JSON is invalid"); }
  inventory = validateInventory(inventory, provider.inventoryRoot);
  if (inventory.totalBytes !== provider.totalBytes || inventory.files.length !== provider.totalFiles) {
    throw new Error("backup receipt and inventory sizes differ");
  }
  mkdirSync(workspace, { recursive: false, mode: 0o700 });
  for (const file of inventory.files) {
    const encoded = Buffer.from(file.path).toString("base64url");
    const response = await getRemote(provider.source, `v1/backup/files/${encoded}`, file.bytes, options);
    if (response.bytes.length !== file.bytes || sha256(response.bytes) !== file.sha256) {
      throw new Error("downloaded backup file hash mismatch");
    }
    const target = join(workspace, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const descriptor = openSync(target, "wx", 0o600);
    try { writeSync(descriptor, response.bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
  verifyDownloadedDirectory(workspace, inventory);
  return inventory;
}

export async function runRemoteBackupRestoreDrill(parentDirectory, sources, genesis, options = {}) {
  if (!Array.isArray(sources) || sources.length < 2 || sources.length > 128) {
    throw new Error("backup drill sources are invalid");
  }
  const receipts = [];
  for (const source of sources) {
    try { receipts.push(await fetchReceipt(source, options)); } catch { /* Try independent sources. */ }
  }
  const selected = selectBackupReceipts(receipts, options);
  if (selected[0].networkId !== genesis.networkId) throw new Error("backup belongs to another network");
  const root = resolve(parentDirectory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const workspace = join(root, `drill-${selected[0].inventoryRoot}`);
  const staging = `${workspace}.staging`;
  if (existsSync(workspace)) {
    try {
      const completed = JSON.parse(readFileSync(join(workspace, "DRILL-COMPLETE.json"), "utf8"));
      if (completed?.format === DRILL_FORMAT && completed.inventoryRoot === selected[0].inventoryRoot &&
          completed.checkpointHash === selected[0].checkpointHash) return completed;
    } catch { /* Remove only this deterministic drill workspace and recreate it. */ }
    rmSync(workspace, { recursive: true, force: true });
  }
  rmSync(staging, { recursive: true, force: true });
  let inventory;
  let downloadedFrom = null;
  const failures = [];
  for (const provider of selected) {
    try {
      rmSync(staging, { recursive: true, force: true });
      inventory = await downloadProvider(provider, staging, options);
      downloadedFrom = provider.source;
      break;
    } catch (error) {
      failures.push(`${provider.source}: ${error.message}`);
      rmSync(staging, { recursive: true, force: true });
    }
  }
  if (!inventory) throw new Error(
    `no agreed backup source completed the bounded download (${failures.join("; ")})`,
  );
  writeAtomic(join(staging, "DRILL-STARTED.json"), {
    checkpointHash: selected[0].checkpointHash, format: DRILL_FORMAT,
    inventoryRoot: selected[0].inventoryRoot,
  });
  renameSync(staging, workspace);
  syncDirectory(root);
  const loaded = loadBlockStore(workspace, genesis);
  new AccountHistoryIndex(workspace, loaded.chain);
  if (loaded.checkpoint.checkpointHash !== selected[0].checkpointHash ||
      loaded.chain.height !== selected[0].height || loaded.chain.tipHash !== selected[0].tipHash ||
      loaded.chain.stateRoot !== selected[0].stateRoot ||
      historyContentRoot(workspace, loaded.chain) !== selected[0].historyContentRoot ||
      readHistoryIndexHash(workspace) !== selected[0].historyIndexHash ||
      readSnapshotHash(workspace) !== selected[0].snapshotHash) {
    throw new Error("restored backup does not match its receipts");
  }
  const completed = {
    checkpointHash: selected[0].checkpointHash,
    completedAt: Date.now(),
    downloadedFrom,
    format: DRILL_FORMAT,
    height: loaded.chain.height,
    inventoryRoot: selected[0].inventoryRoot,
    networkId: loaded.chain.networkId,
    privateKeysIncluded: false,
    sources: selected.map(({ source }) => source).sort(),
    tipHash: loaded.chain.tipHash,
    workspace,
  };
  writeAtomic(join(workspace, "DRILL-COMPLETE.json"), completed);
  return completed;
}

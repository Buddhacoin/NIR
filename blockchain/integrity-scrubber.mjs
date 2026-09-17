import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { verifyAccountHistoryIndexRecord } from "./account-history-index.mjs";
import {
  loadBlockStore,
  readBlockStoreCheckpoint,
} from "./block-store.mjs";
import {
  createBackupInventory,
  runRemoteBackupRestoreDrill,
} from "./backup-recovery.mjs";
import { hashObject } from "./crypto.mjs";
import { acquireDataDirectoryLock } from "./data-directory-lock.mjs";

const CONFIG_FORMAT = "nir-integrity-scrubber-config-v1";
const CURSOR_FORMAT = "nir-integrity-scrubber-cursor-v1";
const INSTALL_FORMAT = "nir-integrity-install-v1";
const HEALTH_FORMAT = "nir-integrity-scrubber-health-v1";
const LOCK_FORMAT = "nir-integrity-scrubber-lock-v1";
const ZERO_HASH = "0".repeat(64);
const HASH = /^[0-9a-f]{64}$/;
const CURSOR_FILES = ["SCRUB-CURSOR.json", "SCRUB-CURSOR.backup.json"];
const LOCK_DIRECTORY = ".integrity-scrubber-lock";
const INSTALL_MARKER = "SCRUB-INSTALLING.json";
const MAX_CURSOR_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_ISSUES = 256;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MIN_STEP_BYTES = 64 * 1024 * 1024;
const COMPONENTS = [
  "STORE-CHECKPOINT.json", "STORE-CHECKPOINT.backup.json", "blocks", "block-backups",
  "snapshots", "account-history-index", "account-history-index-backup",
  "account-history.sqlite",
];
const ALLOWED_CONFIG_KEYS = new Set([
  "format", "genesisPath", "handoffsPath", "intervalMs", "jitterMs", "maxBytesPerStep",
  "maxFilesPerStep", "maxQuarantines", "maxReceiptAgeMs", "maxReplayBytes", "nodeDirectory", "operatorId",
  "sources", "stateDirectory", "trustedOperatorsPath",
]);
const SENSITIVE_KEY = /(password|passphrase|private|secret|mnemonic|seed|bearer|token)/i;

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function blockName(height) { return `${String(height).padStart(12, "0")}.json`; }

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("integrity scrubber directory is unsafe");
  }
}

function writeAtomic(path, value) {
  const target = resolve(path);
  ensureDirectory(dirname(target));
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

function readBoundedJson(path, maximum = MAX_CONFIG_BYTES) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximum) {
    throw new Error("integrity JSON input is invalid");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertNoSecrets(value) {
  if (Array.isArray(value)) { value.forEach(assertNoSecrets); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error("integrity configuration contains a secret field");
    assertNoSecrets(child);
  }
}

function canonicalSource(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("integrity source URL is invalid"); }
  const local = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("integrity source URL is unsafe");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href.replace(/\/$/, "");
}

export function validateIntegrityScrubberConfig(input) {
  assertNoSecrets(input);
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !ALLOWED_CONFIG_KEYS.has(key)) ||
      input.format !== CONFIG_FORMAT || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(input.operatorId ?? "")) {
    throw new Error("integrity scrubber configuration is invalid");
  }
  const integer = (value, minimum, maximum) => Number.isSafeInteger(value) &&
    value >= minimum && value <= maximum;
  if (!integer(input.intervalMs, 60_000, 31 * 24 * 60 * 60 * 1000) ||
      !integer(input.jitterMs, 0, Math.min(input.intervalMs / 4, 6 * 60 * 60 * 1000)) ||
      !integer(input.maxBytesPerStep, MIN_STEP_BYTES, 512 * 1024 * 1024) ||
      !integer(input.maxFilesPerStep, 1, 1024) ||
      !integer(input.maxReceiptAgeMs, 60_000, 365 * 24 * 60 * 60 * 1000) ||
      !integer(input.maxReplayBytes, input.maxBytesPerStep, 16 * 1024 * 1024 * 1024) ||
      !integer(input.maxQuarantines, 1, 8)) {
    throw new Error("integrity scrubber budget is invalid");
  }
  const pathKeys = ["genesisPath", "nodeDirectory", "stateDirectory", "trustedOperatorsPath"];
  if (input.handoffsPath !== null && input.handoffsPath !== undefined) pathKeys.push("handoffsPath");
  if (pathKeys.some((key) => typeof input[key] !== "string" || input[key].length < 1 ||
      Buffer.byteLength(input[key]) > 4096)) throw new Error("integrity scrubber path is invalid");
  if (!Array.isArray(input.sources) || input.sources.length < 2 || input.sources.length > 128) {
    throw new Error("integrity scrubber sources are invalid");
  }
  const sources = input.sources.map(canonicalSource);
  if (new Set(sources).size !== sources.length) throw new Error("integrity sources must be unique");
  const result = structuredClone(input);
  for (const key of pathKeys) result[key] = resolve(input[key]);
  const stateFromNode = relative(result.nodeDirectory, result.stateDirectory);
  const nodeFromState = relative(result.stateDirectory, result.nodeDirectory);
  const nested = (value) => value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
  if (nested(stateFromNode) || nested(nodeFromState)) {
    throw new Error("node and scrubber state directories must not overlap");
  }
  result.sources = sources;
  return result;
}

export function readIntegrityScrubberConfig(path) {
  return validateIntegrityScrubberConfig(readBoundedJson(path));
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function acquireScrubLock(stateDirectory, { now = Date.now(), pid = process.pid,
  processAlive = processExists } = {}) {
  ensureDirectory(stateDirectory);
  const lock = join(stateDirectory, LOCK_DIRECTORY);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      const owner = { format: LOCK_FORMAT, pid, startedAt: now,
        token: randomBytes(32).toString("hex") };
      writeFileSync(join(lock, "owner.json"), `${JSON.stringify(owner)}\n`, {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
      let released = false;
      return () => {
        if (released) return false;
        const current = readBoundedJson(join(lock, "owner.json"), 16 * 1024);
        if (current.token !== owner.token || current.pid !== pid) return false;
        rmSync(lock, { recursive: true });
        syncDirectory(stateDirectory);
        released = true;
        return true;
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = readBoundedJson(join(lock, "owner.json"), 16 * 1024);
      if (owner?.format !== LOCK_FORMAT || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
          !HASH.test(owner.token ?? "") || !Number.isSafeInteger(owner.startedAt)) {
        throw new Error("integrity scrubber lock is invalid");
      }
      if (processAlive(owner.pid)) throw new Error("integrity scrubber is already running");
      const stale = `${lock}.stale-${owner.token}`;
      renameSync(lock, stale);
      rmSync(stale, { recursive: true });
    }
  }
  throw new Error("integrity scrubber lock could not be acquired");
}

function cursorPayload(value) {
  const { cursorHash, ...payload } = value;
  return { cursorHash, payload };
}

function verifyCursor(value) {
  const { cursorHash, payload } = cursorPayload(value ?? {});
  if (payload.format !== CURSOR_FORMAT || !HASH.test(payload.checkpointHash ?? "") ||
      !Number.isSafeInteger(payload.height) || payload.height < 0 ||
      !HASH.test(payload.tipHash ?? "") ||
      !Number.isSafeInteger(payload.sweep) || payload.sweep < 1 ||
      !["checkpoint", "blocks", "snapshot", "history", "sqlite", "replay", "complete"]
        .includes(payload.phase) || !Number.isSafeInteger(payload.position) || payload.position < 0 ||
      !Number.isSafeInteger(payload.scannedBytes) || payload.scannedBytes < 0 ||
      !Number.isSafeInteger(payload.scannedFiles) || payload.scannedFiles < 0 ||
      !Number.isSafeInteger(payload.totalIssues) || payload.totalIssues < 0 ||
      !Number.isSafeInteger(payload.startedAt) || payload.startedAt < 0 ||
      !Number.isSafeInteger(payload.updatedAt) || payload.updatedAt < payload.startedAt ||
      (payload.completedAt !== null && (!Number.isSafeInteger(payload.completedAt) ||
        payload.completedAt < payload.startedAt)) ||
      !Array.isArray(payload.issues) || payload.issues.length > MAX_ISSUES ||
      !HASH.test(payload.previousHistoryHash ?? "") ||
      cursorHash !== hashObject(payload, "INTEGRITY_SCRUB_CURSOR")) {
    throw new Error("integrity scrubber cursor is invalid");
  }
  return structuredClone(value);
}

function cursorPaths(config) { return CURSOR_FILES.map((name) => join(config.stateDirectory, name)); }

function readCursor(config, { repair = false } = {}) {
  const values = cursorPaths(config).map((path) => {
    if (!existsSync(path)) return { state: "missing", value: null };
    try {
      return { state: "valid", value: verifyCursor(readBoundedJson(path, MAX_CURSOR_BYTES)) };
    } catch { return { state: "invalid", value: null }; }
  });
  const valid = values.filter(({ state }) => state === "valid").map(({ value }) => value);
  if (valid.length === 0) {
    if (values.every(({ state }) => state === "missing")) return null;
    throw new Error("integrity scrubber cursor copies are invalid");
  }
  if (valid.length === 2 && JSON.stringify(valid[0]) !== JSON.stringify(valid[1])) {
    throw new Error("integrity scrubber cursor copies conflict");
  }
  if (valid.length === 1 && !repair) throw new Error("integrity scrubber cursor copy is unavailable");
  if (valid.length === 1) {
    for (const path of cursorPaths(config)) writeAtomic(path, valid[0]);
  }
  return valid[0];
}

function sealCursor(payload) {
  return { ...payload, cursorHash: hashObject(payload, "INTEGRITY_SCRUB_CURSOR") };
}

function writeCursor(config, payload) {
  const value = sealCursor(payload);
  for (const path of cursorPaths(config)) writeAtomic(path, value);
  return value;
}

function newCursor(checkpoint, previous = null, now = Date.now()) {
  return {
    checkpointHash: checkpoint.checkpointHash,
    completedAt: null,
    format: CURSOR_FORMAT,
    height: checkpoint.height,
    issues: [],
    phase: "checkpoint",
    position: 0,
    previousHistoryHash: ZERO_HASH,
    scannedBytes: 0,
    scannedFiles: 0,
    startedAt: now,
    sweep: (previous?.sweep ?? 0) + 1,
    totalIssues: 0,
    tipHash: checkpoint.tipHash,
    updatedAt: now,
  };
}

function openSafe(path, afterLstat) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) {
    throw new Error("integrity file is unsafe or too large");
  }
  afterLstat?.(path, before);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const opened = fstatSync(descriptor);
  if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.size !== before.size) {
    closeSync(descriptor);
    throw new Error("integrity file changed during open");
  }
  return { descriptor, metadata: opened };
}

function readSafe(path, maximumBytes, afterLstat) {
  const { descriptor, metadata } = openSafe(path, afterLstat);
  try {
    if (metadata.size > maximumBytes) throw new Error("integrity item exceeds the step budget");
    const contents = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < contents.length) {
      const length = readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (length === 0) throw new Error("integrity file changed during read");
      offset += length;
    }
    const after = fstatSync(descriptor);
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) {
      throw new Error("integrity file changed during read");
    }
    return contents;
  } finally { closeSync(descriptor); }
}

function fileState(root, relativePath, maximumBytes, afterLstat) {
  if (!isAllowedNodePath(relativePath)) {
    return { bytes: 0, error: "integrity path is not allowed", hash: null, path: relativePath };
  }
  const path = join(root, ...relativePath.split("/"));
  try {
    const contents = readSafe(path, maximumBytes, afterLstat);
    return { bytes: contents.length, contents, hash: sha256(contents), path: relativePath };
  } catch (error) {
    return { bytes: 0, error: error.message, hash: null, path: relativePath };
  }
}

function isAllowedNodePath(path) {
  if (["STORE-CHECKPOINT.json", "STORE-CHECKPOINT.backup.json",
    "account-history.sqlite"].includes(path)) return true;
  if (["snapshots/STATE-SNAPSHOT.json", "snapshots/STATE-SNAPSHOT.backup.json"]
    .includes(path)) return true;
  const [directory, name, ...rest] = String(path).split("/");
  return rest.length === 0 && ["blocks", "block-backups", "account-history-index",
    "account-history-index-backup"].includes(directory) && /^\d{12}\.json$/.test(name ?? "");
}

function issue(cursor, value) {
  cursor.totalIssues += 1;
  cursor.issues.push(value);
  if (cursor.issues.length > MAX_ISSUES) cursor.issues.shift();
}

function checkPair(config, cursor, leftPath, rightPath, budget, expectedHash = null,
  validator = null, afterLstat = null) {
  const perFile = Math.max(1, Math.floor(budget / 2));
  const left = fileState(config.nodeDirectory, leftPath, perFile, afterLstat);
  const right = fileState(config.nodeDirectory, rightPath, perFile, afterLstat);
  cursor.scannedFiles += 2;
  cursor.scannedBytes += left.bytes + right.bytes;
  const valid = (candidate) => candidate.hash && (!expectedHash || candidate.hash === expectedHash) &&
    (!validator || validator(candidate.contents));
  const leftValid = valid(left);
  const rightValid = valid(right);
  if (leftValid && rightValid && left.hash === right.hash) return { left, right, verified: left };
  if (leftValid !== rightValid || (leftValid && rightValid && expectedHash)) {
    const source = leftValid ? left : right;
    const target = leftValid ? right : left;
    issue(cursor, { expectedHash: source.hash, kind: "repairable-local", source: source.path,
      target: target.path });
    return { left, right, verified: source };
  }
  issue(cursor, { kind: "remote-repair-required", left: leftPath, right: rightPath });
  return { left, right, verified: null };
}

function checkpointValidator(networkId, checkpointHash) {
  return (contents) => {
    try {
      const value = JSON.parse(contents.toString("utf8"));
      const { checkpointHash: claimed, ...payload } = value;
      return claimed === checkpointHash && value.networkId === networkId &&
        claimed === hashObject(payload, "BLOCK_STORE_CHECKPOINT");
    } catch { return false; }
  };
}

function historyValidator(context, expectedBlockHash) {
  return (contents) => {
    try {
      const value = verifyAccountHistoryIndexRecord(JSON.parse(contents.toString("utf8")), context);
      return !expectedBlockHash || value.blockHash === expectedBlockHash;
    } catch { return false; }
  };
}

function loadContext(config) {
  const genesis = readBoundedJson(config.genesisPath);
  const handoffs = config.handoffsPath ? readBoundedJson(config.handoffsPath) : [];
  if (!Array.isArray(handoffs)) throw new Error("integrity handoffs must be an array");
  return { genesis, options: { handoffs, repair: false, trustedValidators: genesis.validators } };
}

function boundedCheckpoint(config, genesis) {
  let bytes = 0;
  let files = 0;
  for (const name of ["STORE-CHECKPOINT.json", "STORE-CHECKPOINT.backup.json"]) {
    const path = join(config.nodeDirectory, name);
    if (!existsSync(path)) continue;
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() ||
        metadata.size > Math.floor(config.maxBytesPerStep / 4)) {
      throw new Error("block-store checkpoint exceeds the scrub budget or is unsafe");
    }
    bytes += metadata.size;
    files += 1;
  }
  if (bytes > Math.floor(config.maxBytesPerStep / 2)) {
    throw new Error("block-store checkpoints exceed the scrub budget");
  }
  return { bytes, checkpoint: readBlockStoreCheckpoint(config.nodeDirectory, genesis), files };
}

function expectedBlock(checkpoint, height) {
  if (height <= checkpoint.baseHeight || height > checkpoint.height) return null;
  return checkpoint.blocks[height - checkpoint.baseHeight - 1];
}

function sqliteCheck(config, cursor, budget) {
  const path = join(config.nodeDirectory, "account-history.sqlite");
  let metadata;
  try { metadata = lstatSync(path); } catch {
    issue(cursor, { kind: "cache-rebuild-required", path: "account-history.sqlite" });
    return;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > config.maxReplayBytes ||
      metadata.size > budget) {
    issue(cursor, { kind: "cache-rebuild-required", path: "account-history.sqlite" });
    return;
  }
  cursor.scannedBytes += metadata.size;
  cursor.scannedFiles += 1;
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const result = database.prepare("PRAGMA quick_check(1)").get();
      if (!result || Object.values(result)[0] !== "ok") throw new Error("quick check failed");
    } finally { database.close(); }
  } catch { issue(cursor, { kind: "cache-rebuild-required", path: "account-history.sqlite" }); }
}

function estimatedReplayBytes(config, checkpoint) {
  let total = 0;
  for (const entry of checkpoint.blocks) {
    const path = join(config.nodeDirectory, "blocks", blockName(entry.height));
    try { total += lstatSync(path).size; } catch { /* Full replay reports the exact failure. */ }
  }
  for (const name of ["STATE-SNAPSHOT.json", "STATE-SNAPSHOT.backup.json"]) {
    const path = join(config.nodeDirectory, "snapshots", name);
    try { total += lstatSync(path).size; } catch { /* Optional snapshot. */ }
  }
  return total;
}

export function integrityScrubDryRun(configInput, now = Date.now()) {
  const config = validateIntegrityScrubberConfig(configInput);
  const { genesis } = loadContext(config);
  const { checkpoint } = boundedCheckpoint(config, genesis);
  const cursor = readCursor(config);
  return {
    checkpointHash: checkpoint.checkpointHash,
    format: "nir-integrity-scrubber-dry-run-v1",
    nextPhase: cursor?.checkpointHash === checkpoint.checkpointHash ? cursor.phase : "checkpoint",
    operatorId: config.operatorId,
    writesPerformed: false,
    now,
  };
}

export function runIntegrityScrubStep(configInput, options = {}) {
  const config = validateIntegrityScrubberConfig(configInput);
  const now = options.now ?? Date.now();
  const release = acquireScrubLock(config.stateDirectory, {
    now, pid: options.pid, processAlive: options.processAlive,
  });
  try {
    const { genesis, options: loadOptions } = loadContext(config);
    const checkpointRead = boundedCheckpoint(config, genesis);
    const checkpoint = checkpointRead.checkpoint;
    let stored = readCursor(config, { repair: true });
    let cursor = stored && stored.checkpointHash === checkpoint.checkpointHash &&
      stored.phase !== "complete" ? cursorPayload(stored).payload : newCursor(checkpoint, stored, now);
    let files = 0;
    const initialBytes = cursor.scannedBytes;
    cursor.scannedBytes += checkpointRead.bytes;
    cursor.scannedFiles += checkpointRead.files;
    const advance = () => { files += 1; };
    while (files < config.maxFilesPerStep) {
      const remaining = config.maxBytesPerStep - (cursor.scannedBytes - initialBytes);
      if (remaining < 1024 * 1024) break;
      if (cursor.phase === "checkpoint") {
        checkPair(config, cursor, "STORE-CHECKPOINT.json", "STORE-CHECKPOINT.backup.json",
          remaining, null, checkpointValidator(genesis.networkId, checkpoint.checkpointHash),
          options.afterFileLstat);
        cursor.phase = "blocks";
        cursor.position = checkpoint.baseHeight + 1;
        advance();
      } else if (cursor.phase === "blocks") {
        if (cursor.position > checkpoint.height) {
          cursor.phase = "snapshot"; cursor.position = 0; continue;
        }
        const expected = expectedBlock(checkpoint, cursor.position);
        const name = blockName(cursor.position);
        checkPair(config, cursor, `blocks/${name}`, `block-backups/${name}`,
          remaining, expected?.fileSha256 ?? null, null, options.afterFileLstat);
        cursor.position += 1;
        advance();
      } else if (cursor.phase === "snapshot") {
        const primary = join(config.nodeDirectory, "snapshots", "STATE-SNAPSHOT.json");
        const backup = join(config.nodeDirectory, "snapshots", "STATE-SNAPSHOT.backup.json");
        if (existsSync(primary) || existsSync(backup)) {
          checkPair(config, cursor, "snapshots/STATE-SNAPSHOT.json",
            "snapshots/STATE-SNAPSHOT.backup.json", remaining, null, null,
            options.afterFileLstat);
        }
        cursor.phase = "history"; cursor.position = 1; cursor.previousHistoryHash = ZERO_HASH;
        advance();
      } else if (cursor.phase === "history") {
        if (cursor.position > checkpoint.height) {
          cursor.phase = "sqlite"; cursor.position = 0; continue;
        }
        const height = cursor.position;
        const name = blockName(height);
        const expected = expectedBlock(checkpoint, height);
        const context = { height, networkId: genesis.networkId,
          previousIndexHash: cursor.previousHistoryHash };
        const checked = checkPair(config, cursor, `account-history-index/${name}`,
          `account-history-index-backup/${name}`, remaining, null,
          historyValidator(context, expected?.blockHash ?? null), options.afterFileLstat);
        let verified = null;
        for (const candidate of [checked.left, checked.right]) {
          try {
            verified = verifyAccountHistoryIndexRecord(
              JSON.parse(candidate.contents.toString("utf8")), context,
            );
            if (expected && verified.blockHash !== expected.blockHash) verified = null;
            if (verified) break;
          } catch { /* Try redundant copy. */ }
        }
        if (!verified) cursor.previousHistoryHash = ZERO_HASH;
        else cursor.previousHistoryHash = verified.indexHash;
        cursor.position += 1;
        advance();
      } else if (cursor.phase === "sqlite") {
        sqliteCheck(config, cursor, remaining);
        cursor.phase = "replay"; cursor.position = 0;
        advance();
      } else if (cursor.phase === "replay") {
        const bytes = estimatedReplayBytes(config, checkpoint);
        if (bytes > config.maxReplayBytes) {
          issue(cursor, { bytes, kind: "replay-budget-exceeded" });
        } else {
          try {
            const loaded = loadBlockStore(config.nodeDirectory, genesis, loadOptions);
            if (loaded.checkpoint.checkpointHash !== checkpoint.checkpointHash) {
              throw new Error("checkpoint changed");
            }
            cursor.scannedBytes += bytes;
          } catch (error) {
            if (error.message === "checkpoint changed") break;
            issue(cursor, { kind: "remote-repair-required", scope: "full-replay" });
          }
        }
        cursor.phase = "complete";
        cursor.completedAt = now;
        advance();
      } else break;
    }
    cursor.updatedAt = now;
    stored = writeCursor(config, cursor);
    return integrityScrubberHealth(config, { now, cursor: stored });
  } finally { release(); }
}

export function integrityScrubberHealth(configInput, { cursor = null, now = Date.now() } = {}) {
  const config = validateIntegrityScrubberConfig(configInput);
  const value = cursor ? verifyCursor(cursor) : readCursor(config);
  const reasons = [];
  if (!value) reasons.push("never-started");
  else {
    if (value.updatedAt > now + 5 * 60 * 1000) reasons.push("clock-anomaly");
    if (value.totalIssues > 0) reasons.push("integrity-issues");
    if (value.phase !== "complete") reasons.push("sweep-incomplete");
    if (now - value.updatedAt > config.intervalMs + config.jitterMs) reasons.push("step-stale");
    if (value.completedAt !== null && now - value.completedAt > config.intervalMs + config.jitterMs) {
      reasons.push("sweep-stale");
    }
  }
  return {
    checkpointHash: value?.checkpointHash ?? null,
    completedAt: value?.completedAt ?? null,
    format: HEALTH_FORMAT,
    healthy: reasons.length === 0,
    issues: value?.issues ?? [],
    operatorId: config.operatorId,
    phase: value?.phase ?? null,
    reasons,
    scannedBytes: value?.scannedBytes ?? 0,
    scannedFiles: value?.scannedFiles ?? 0,
    sweep: value?.sweep ?? 0,
    totalIssues: value?.totalIssues ?? 0,
  };
}

function writeFileAtomicFromBuffer(path, contents) {
  ensureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.scrub`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function repairLocalIntegrityCopies(configInput, options = {}) {
  const config = validateIntegrityScrubberConfig(configInput);
  const releaseScrub = acquireScrubLock(config.stateDirectory, options);
  let releaseWriter;
  try {
    const cursor = readCursor(config, { repair: true });
    if (!cursor) throw new Error("integrity scrubber has no repair plan");
    const repairs = cursor.issues.filter(({ kind }) => kind === "repairable-local");
    if (repairs.length === 0) return { repaired: 0 };
    releaseWriter = acquireDataDirectoryLock(config.nodeDirectory);
    let repaired = 0;
    for (const item of repairs) {
      if (!isAllowedNodePath(item.source) || !isAllowedNodePath(item.target)) {
        throw new Error("local repair plan contains an unsafe path");
      }
      const source = fileState(config.nodeDirectory, item.source, config.maxBytesPerStep,
        options.afterFileLstat);
      if (!source.hash || source.hash !== item.expectedHash) {
        throw new Error("verified local repair source changed");
      }
      const target = join(config.nodeDirectory, ...item.target.split("/"));
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
        throw new Error("local repair target is a symbolic link");
      }
      (options.writeRepairFile ?? writeFileAtomicFromBuffer)(target, source.contents);
      if (sha256(readSafe(target, config.maxBytesPerStep, options.afterFileLstat)) !==
          item.expectedHash) {
        throw new Error("local repair verification failed");
      }
      repaired += 1;
    }
    for (const path of cursorPaths(config)) rmSync(path, { force: true });
    syncDirectory(config.stateDirectory);
    return { repaired };
  } finally {
    releaseWriter?.();
    releaseScrub();
  }
}

function componentState(root, name) {
  const path = join(root, name);
  if (!existsSync(path)) return "absent";
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
    throw new Error("integrity installation component is unsafe");
  }
  return metadata.isDirectory() ? "directory" : "file";
}

function retainQuarantines(parent, maximum, protectedPath) {
  const entries = readdirSync(parent).filter((name) => name.startsWith(".nir-scrub-quarantine-"))
    .map((name) => {
      const path = join(parent, name);
      const metadata = lstatSync(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("integrity quarantine is unsafe");
      }
      return { name, path, time: metadata.mtimeMs };
    })
    .sort((left, right) => right.time - left.time);
  const keep = new Set([basename(protectedPath)]);
  for (const entry of entries) {
    if (keep.size >= maximum) break;
    keep.add(entry.name);
  }
  for (const entry of entries) if (!keep.has(entry.name)) rmSync(entry.path, { recursive: true });
  syncDirectory(parent);
}

export async function repairIntegrityFromRemote(configInput, options = {}) {
  const config = validateIntegrityScrubberConfig(configInput);
  const now = options.now ?? Date.now();
  const releaseScrub = acquireScrubLock(config.stateDirectory, {
    now, pid: options.pid, processAlive: options.processAlive,
  });
  let releaseWriter;
  try {
    const { genesis, options: loadOptions } = loadContext(config);
    const trustedOperators = readBoundedJson(config.trustedOperatorsPath);
    const drill = await (options.restoreDrill ?? runRemoteBackupRestoreDrill)(
      dirname(config.stateDirectory), config.sources, genesis,
      { allowInsecureLocalhost: true, maxAgeMs: config.maxReceiptAgeMs, now, trustedOperators },
    );
    let anchor = readCursor(config, { repair: true });
    try {
      const current = boundedCheckpoint(config, genesis).checkpoint;
      anchor = { height: current.height, tipHash: current.tipHash };
    } catch {
      if (!anchor) throw new Error("remote repair has no trusted local rollback anchor");
    }
    if (drill.height < anchor.height ||
        (drill.height === anchor.height && drill.tipHash !== anchor.tipHash)) {
      throw new Error("remote repair would roll back the verified chain");
    }
    const inventory = createBackupInventory(drill.workspace, { ignoreDrillMarkers: true });
    if (inventory.inventoryRoot !== drill.inventoryRoot) {
      throw new Error("remote repair drill inventory changed");
    }
    const parent = dirname(config.nodeDirectory);
    const staging = join(parent, `.nir-scrub-staging-${inventory.inventoryRoot}`);
    const quarantine = join(parent, `.nir-scrub-quarantine-${inventory.inventoryRoot}`);
    const markerPath = join(config.nodeDirectory, INSTALL_MARKER);
    if (!existsSync(markerPath)) {
      rmSync(staging, { recursive: true, force: true });
      ensureDirectory(staging);
      for (const name of [...COMPONENTS, "genesis.json"]) {
        if (!existsSync(join(drill.workspace, name))) continue;
        (options.copyComponent ?? cpSync)(join(drill.workspace, name), join(staging, name), {
          errorOnExist: true, recursive: true, verbatimSymlinks: true,
        });
      }
      const stagedInventory = createBackupInventory(staging);
      if (stagedInventory.inventoryRoot !== inventory.inventoryRoot) {
        throw new Error("remote repair staging verification failed");
      }
      const staged = loadBlockStore(staging, genesis, loadOptions);
      if (staged.checkpoint.checkpointHash !== drill.checkpointHash ||
          staged.chain.tipHash !== drill.tipHash || staged.chain.stateRoot !== drill.stateRoot) {
        throw new Error("remote repair replay mismatch");
      }
    }
    releaseWriter = acquireDataDirectoryLock(config.nodeDirectory);
    let marker;
    if (existsSync(markerPath)) {
      marker = readBoundedJson(markerPath, MAX_CURSOR_BYTES);
      const { markerHash, ...payload } = marker ?? {};
      if (payload.format !== INSTALL_FORMAT || payload.inventoryRoot !== inventory.inventoryRoot ||
          !Array.isArray(payload.completed) || new Set(payload.completed).size !== payload.completed.length ||
          payload.completed.some((name) => !COMPONENTS.includes(name)) ||
          markerHash !== hashObject(payload, "INTEGRITY_INSTALL_MARKER")) {
        throw new Error("integrity install marker conflicts");
      }
    } else {
      ensureDirectory(quarantine);
      const payload = { completed: [], format: INSTALL_FORMAT,
        inventoryRoot: inventory.inventoryRoot };
      marker = { ...payload, markerHash: hashObject(payload, "INTEGRITY_INSTALL_MARKER") };
      writeAtomic(markerPath, marker);
    }
    for (const name of COMPONENTS) {
      if (marker.completed.includes(name)) continue;
      const desired = componentState(staging, name);
      const live = componentState(config.nodeDirectory, name);
      const saved = componentState(quarantine, name);
      if (live !== "absent" && saved === "absent") {
        renameSync(join(config.nodeDirectory, name), join(quarantine, name));
        syncDirectory(config.nodeDirectory); syncDirectory(quarantine);
      }
      if (desired !== "absent") {
        renameSync(join(staging, name), join(config.nodeDirectory, name));
        syncDirectory(staging); syncDirectory(config.nodeDirectory);
      }
      marker.completed.push(name);
      const { markerHash: _oldHash, ...payload } = marker;
      marker = { ...payload, markerHash: hashObject(payload, "INTEGRITY_INSTALL_MARKER") };
      writeAtomic(markerPath, marker);
      options.afterComponent?.(name);
    }
    const activated = readBlockStoreCheckpoint(config.nodeDirectory, genesis);
    if (activated.checkpointHash !== drill.checkpointHash || activated.tipHash !== drill.tipHash) {
      throw new Error("activated integrity generation checkpoint mismatch");
    }
    rmSync(markerPath);
    rmSync(staging, { recursive: true, force: true });
    syncDirectory(config.nodeDirectory); syncDirectory(parent);
    retainQuarantines(parent, config.maxQuarantines, quarantine);
    for (const path of cursorPaths(config)) rmSync(path, { force: true });
    return { checkpointHash: drill.checkpointHash, inventoryRoot: drill.inventoryRoot,
      quarantine, repaired: true };
  } finally {
    releaseWriter?.();
    releaseScrub();
  }
}

export function scheduledIntegrityTime(configInput, slot) {
  const config = validateIntegrityScrubberConfig(configInput);
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("integrity schedule slot is invalid");
  const digest = createHash("sha256").update(`${config.operatorId}:${slot}`).digest();
  return slot * config.intervalMs + Number(digest.readBigUInt64BE() % BigInt(config.jitterMs + 1));
}

export async function runIntegrityScrubScheduler(configInput, options = {}) {
  const config = validateIntegrityScrubberConfig(configInput);
  const now = options.now ?? (() => Date.now());
  const signal = options.signal;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolveSleep) => {
    if (signal?.aborted) { resolveSleep(); return; }
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => { clearTimeout(timer); finish(); };
    signal?.addEventListener("abort", onAbort, { once: true });
  }));
  let runs = 0;
  while (!signal?.aborted) {
    const current = now();
    let slot = Math.floor(current / config.intervalMs);
    const cursor = readCursor(config);
    const latestSlot = cursor ? Math.floor(cursor.updatedAt / config.intervalMs) : -1;
    if (latestSlot >= slot) slot = latestSlot + 1;
    const scheduled = scheduledIntegrityTime(config, slot);
    if (scheduled <= current) {
      runIntegrityScrubStep(config, { ...options, now: now() });
      runs += 1;
      if (options.maximumRuns && runs >= options.maximumRuns) return runs;
      continue;
    }
    await sleep(Math.max(1, scheduled - now()));
  }
  return runs;
}

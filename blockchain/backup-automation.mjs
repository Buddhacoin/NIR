import { createHash, randomBytes } from "node:crypto";
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
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import { exportBlockStoreBackup } from "./block-store.mjs";
import { runRemoteBackupRestoreDrill } from "./backup-recovery.mjs";
import {
  addressFromPublicKey,
  canonicalJson,
  hashObject,
  publicWallet,
  signObject,
  verifyObject,
} from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";

const CONFIG_FORMAT = "nir-backup-automation-config-v1";
const RESULT_FORMAT = "nir-backup-automation-result-v1";
const HEAD_FORMAT = "nir-backup-automation-head-v1";
const LOCK_FORMAT = "nir-backup-automation-lock-v1";
const PENDING_FORMAT = "nir-backup-automation-pending-v1";
const ZERO_HASH = "0".repeat(64);
const HASH = /^[0-9a-f]{64}$/;
const NAME = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const JOURNAL_NAME = "BACKUP-DRILLS.jsonl";
const HEAD_NAMES = ["BACKUP-DRILLS.head.json", "BACKUP-DRILLS.head.backup.json"];
const LOCK_NAME = ".backup-automation-lock";
const PENDING_NAME = "BACKUP-DRILLS.pending.json";
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_JOURNAL_RECORDS = 100_000;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_ERROR_CODE_BYTES = 96;
const ALLOWED_CONFIG_KEYS = new Set([
  "backupRoot", "drillRoot", "format", "genesisPath", "intervalMs", "jitterMs",
  "liveDirectory", "maxBackups", "maxDrillWorkspaces", "maxReceiptAgeMs",
  "maxSuccessAgeMs", "operatorId", "resultSigner", "sources", "stateDirectory",
  "trustedOperatorsPath",
]);
const SENSITIVE_KEY = /(password|passphrase|private|secret|mnemonic|seed|bearer|token)/i;

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("backup automation directory is unsafe");
  }
}

function writeAtomic(path, value) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
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

function readBoundedJson(path, maximumBytes = MAX_CONFIG_BYTES) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw new Error("automation JSON input is invalid");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertNoSecrets(value, path = "config") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`${path} contains a forbidden secret field`);
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function validatePublicWallet(wallet) {
  if (wallet?.algorithm !== SIGNATURE_ALGORITHM ||
      addressFromPublicKey(wallet.publicKey ?? "") !== wallet.address) {
    throw new Error("automation result signer is invalid");
  }
  return structuredClone(wallet);
}

function canonicalSource(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("automation source URL is invalid"); }
  const local = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("automation source URL is unsafe");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href.replace(/\/$/, "");
}

export function validateBackupAutomationConfig(input) {
  assertNoSecrets(input);
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !ALLOWED_CONFIG_KEYS.has(key)) ||
      input.format !== CONFIG_FORMAT || !NAME.test(input.operatorId ?? "")) {
    throw new Error("backup automation configuration is invalid");
  }
  const integer = (value, minimum, maximum) => Number.isSafeInteger(value) &&
    value >= minimum && value <= maximum;
  if (!integer(input.intervalMs, 60_000, 31 * 24 * 60 * 60 * 1000) ||
      !integer(input.jitterMs, 0, Math.min(input.intervalMs / 4, 6 * 60 * 60 * 1000)) ||
      !integer(input.maxSuccessAgeMs, input.intervalMs, 365 * 24 * 60 * 60 * 1000) ||
      !integer(input.maxReceiptAgeMs, 60_000, 365 * 24 * 60 * 60 * 1000) ||
      !integer(input.maxBackups, 2, 128) || !integer(input.maxDrillWorkspaces, 1, 128)) {
    throw new Error("backup automation timing or retention policy is invalid");
  }
  const paths = ["backupRoot", "drillRoot", "genesisPath", "liveDirectory",
    "stateDirectory", "trustedOperatorsPath"];
  if (paths.some((key) => typeof input[key] !== "string" || input[key].length < 1 ||
      Buffer.byteLength(input[key]) > 4096)) throw new Error("backup automation path is invalid");
  if (!Array.isArray(input.sources) || input.sources.length < 2 || input.sources.length > 128) {
    throw new Error("backup automation sources are invalid");
  }
  const sources = input.sources.map(canonicalSource);
  if (new Set(sources).size !== sources.length) throw new Error("backup sources must be unique");
  return {
    ...structuredClone(input),
    ...Object.fromEntries(paths.map((key) => [key, resolve(input[key])])),
    resultSigner: validatePublicWallet(input.resultSigner),
    sources,
  };
}

export function readBackupAutomationConfig(path) {
  return validateBackupAutomationConfig(readBoundedJson(path));
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function acquireAutomationLock(stateDirectory, { now = Date.now(), pid = process.pid,
  processAlive = processExists } = {}) {
  const root = resolve(stateDirectory);
  const lock = join(root, LOCK_NAME);
  ensureDirectory(root);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      const owner = { format: LOCK_FORMAT, pid, startedAt: now,
        token: randomBytes(32).toString("hex") };
      writeFileSync(join(lock, "owner.json"), `${JSON.stringify(owner)}\n`, {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
      syncDirectory(lock);
      let released = false;
      return () => {
        if (released) return false;
        let current;
        try { current = readBoundedJson(join(lock, "owner.json"), 16 * 1024); }
        catch { return false; }
        if (current.token !== owner.token || current.pid !== pid) return false;
        rmSync(lock, { recursive: true });
        syncDirectory(root);
        released = true;
        return true;
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      const owner = readBoundedJson(join(lock, "owner.json"), 16 * 1024);
      if (owner?.format !== LOCK_FORMAT || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
          !HASH.test(owner.token ?? "") || !Number.isSafeInteger(owner.startedAt)) {
        throw new Error("backup automation lock is invalid");
      }
      if (processAlive(owner.pid)) throw new Error("backup automation is already running");
      const stale = `${lock}.stale-${owner.token}`;
      renameSync(lock, stale);
      rmSync(stale, { recursive: true });
      syncDirectory(root);
    }
  }
  throw new Error("backup automation lock could not be acquired");
}

function journalPath(config) { return join(config.stateDirectory, JOURNAL_NAME); }
function headPaths(config) { return HEAD_NAMES.map((name) => join(config.stateDirectory, name)); }
function pendingPath(config) { return join(config.stateDirectory, PENDING_NAME); }

function readHead(path) {
  if (!existsSync(path)) return null;
  const value = readBoundedJson(path, MAX_RECORD_BYTES);
  if (value?.format !== HEAD_FORMAT || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !HASH.test(value.resultHash ?? "") || !HASH.test(value.journalHash ?? "")) {
    throw new Error("backup automation head is invalid");
  }
  return value;
}

function journalHash(records) {
  return hashObject(records.map(({ payload }) => payload.resultHash), "BACKUP_AUTOMATION_JOURNAL");
}

function readPending(config) {
  const path = pendingPath(config);
  if (!existsSync(path)) return null;
  const pending = readBoundedJson(path, MAX_RECORD_BYTES);
  if (pending?.format !== PENDING_FORMAT || !Number.isSafeInteger(pending.sequence) ||
      pending.sequence < 1 || !Number.isSafeInteger(pending.previousBytes) ||
      pending.previousBytes < 0 || !HASH.test(pending.previousHash ?? "") ||
      !HASH.test(pending.resultHash ?? "") ||
      canonicalJson(pending.signer) !== canonicalJson(config.resultSigner) ||
      !verifyObject({ resultHash: pending.resultHash }, pending.signature,
        config.resultSigner.publicKey, "BACKUP_AUTOMATION_RESULT")) {
    throw new Error("backup automation pending append is invalid");
  }
  return pending;
}

export function readBackupAutomationJournal(configInput, { repairCrash = false } = {}) {
  const config = validateBackupAutomationConfig(configInput);
  const path = journalPath(config);
  let pending = readPending(config);
  let contents = "";
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_JOURNAL_BYTES) {
      throw new Error("backup automation journal is invalid or too large");
    }
    contents = readFileSync(path, "utf8");
  }
  if (contents && !contents.endsWith("\n")) {
    if (!repairCrash || !pending || pending.previousBytes > Buffer.byteLength(contents)) {
      throw new Error("backup automation journal is incomplete");
    }
    truncateSync(path, pending.previousBytes);
    const descriptor = openSync(path, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    syncDirectory(config.stateDirectory);
    contents = readFileSync(path, "utf8");
    if (contents && !contents.endsWith("\n")) {
      throw new Error("backup automation journal is incomplete");
    }
  }
  const lines = contents ? contents.trimEnd().split("\n") : [];
  if (lines.length > MAX_JOURNAL_RECORDS) throw new Error("backup automation journal is too long");
  const records = [];
  let previousHash = ZERO_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    if (Buffer.byteLength(lines[index]) > MAX_RECORD_BYTES) throw new Error("backup result is too large");
    let record;
    try { record = JSON.parse(lines[index]); } catch { throw new Error("backup journal JSON is invalid"); }
    const { resultHash, ...payload } = record?.payload ?? {};
    const success = payload.status === "success";
    const expectedKeys = (success ? [
      "backupName", "checkpointHash", "completedAt", "drillName", "format", "height",
      "inventoryRoot", "localHeight", "localTipHash", "networkId", "operatorId", "previousHash",
      "sequence", "startedAt", "status", "tipHash",
    ] : [
      "backupName", "completedAt", "errorCode", "format", "networkId", "operatorId",
      "previousHash", "sequence", "startedAt", "status",
    ]).sort();
    if (payload.format !== RESULT_FORMAT || payload.operatorId !== config.operatorId ||
        Object.keys(payload).sort().join(":") !== expectedKeys.join(":") ||
        typeof payload.networkId !== "string" || payload.networkId.length < 1 ||
        Buffer.byteLength(payload.networkId) > 256 || payload.sequence !== index + 1 ||
        payload.previousHash !== previousHash || !Number.isSafeInteger(payload.startedAt) ||
        payload.startedAt < 0 || !Number.isSafeInteger(payload.completedAt) ||
        payload.completedAt < payload.startedAt ||
        !["success", "failure"].includes(payload.status) ||
        (success && (!/^backup-[a-z0-9-]+$/.test(payload.backupName ?? "") ||
          !/^drill-[0-9a-f]{64}$/.test(payload.drillName ?? "") ||
          !Number.isSafeInteger(payload.height) || payload.height < 0 ||
          !Number.isSafeInteger(payload.localHeight) || payload.localHeight < 0 ||
          !HASH.test(payload.checkpointHash ?? "") || !HASH.test(payload.inventoryRoot ?? "") ||
          !HASH.test(payload.localTipHash ?? "") || !HASH.test(payload.tipHash ?? ""))) ||
        (!success && (!/^[a-z][a-z-]{2,95}$/.test(payload.errorCode ?? "") ||
          (payload.backupName !== null && !/^backup-[a-z0-9-]+$/.test(payload.backupName ?? "")))) ||
        resultHash !== hashObject(payload, "BACKUP_AUTOMATION_RESULT") ||
        canonicalJson(record.signer) !== canonicalJson(config.resultSigner) ||
        !verifyObject({ resultHash }, record.signature, config.resultSigner.publicKey,
          "BACKUP_AUTOMATION_RESULT")) {
      throw new Error("backup automation journal signature or chain is invalid");
    }
    previousHash = resultHash;
    records.push(record);
  }
  const expectedHead = records.length ? {
    format: HEAD_FORMAT, journalHash: journalHash(records), resultHash: previousHash,
    sequence: records.length,
  } : null;
  const heads = headPaths(config).map(readHead);
  const headMatchesPrefix = (head) => {
    if (!head) return true;
    if (head.sequence > records.length) return false;
    const prefix = records.slice(0, head.sequence);
    return canonicalJson(head) === canonicalJson({
      format: HEAD_FORMAT,
      journalHash: journalHash(prefix),
      resultHash: prefix.at(-1)?.payload.resultHash,
      sequence: prefix.length,
    });
  };
  const complete = heads.every((head) => canonicalJson(head) === canonicalJson(expectedHead));
  const pendingMatchesTail = pending && pending.sequence === records.length &&
    pending.resultHash === records.at(-1)?.payload.resultHash &&
    pending.previousHash === (records.at(-2)?.payload.resultHash ?? ZERO_HASH);
  const pendingPrecedesTail = pending && pending.sequence === records.length + 1 &&
    pending.previousHash === (records.at(-1)?.payload.resultHash ?? ZERO_HASH);
  if (!complete && repairCrash && pendingMatchesTail && heads.every(headMatchesPrefix)) {
    for (const path of headPaths(config)) writeAtomic(path, expectedHead);
  } else if (!complete) {
    if (!heads.every(headMatchesPrefix)) {
      throw new Error("backup automation journal rollback or substitution detected");
    }
    throw new Error("backup automation head copies conflict or are incomplete");
  }
  if (pending) {
    if (!repairCrash || (!pendingMatchesTail && !pendingPrecedesTail)) {
      throw new Error("backup automation pending append conflicts with the journal");
    }
    rmSync(pendingPath(config));
    syncDirectory(config.stateDirectory);
    pending = null;
  }
  return { head: expectedHead, records };
}

function appendResult(config, wallet, payloadFields, io = {}) {
  const reader = io.readJournal ?? ((value) => readBackupAutomationJournal(value, {
    repairCrash: true,
  }));
  const state = reader(config);
  if (state.records.length >= MAX_JOURNAL_RECORDS) throw new Error("backup journal retention limit reached");
  if (canonicalJson(publicWallet(wallet)) !== canonicalJson(config.resultSigner)) {
    throw new Error("backup automation signing wallet does not match configuration");
  }
  const payload = {
    ...payloadFields,
    format: RESULT_FORMAT,
    operatorId: config.operatorId,
    previousHash: state.head?.resultHash ?? ZERO_HASH,
    sequence: state.records.length + 1,
  };
  const resultHash = hashObject(payload, "BACKUP_AUTOMATION_RESULT");
  const record = {
    payload: { ...payload, resultHash },
    signature: signObject({ resultHash }, wallet, "BACKUP_AUTOMATION_RESULT"),
    signer: publicWallet(wallet),
  };
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new Error("backup result is too large");
  ensureDirectory(config.stateDirectory);
  const path = journalPath(config);
  const currentBytes = existsSync(path) ? lstatSync(path).size : 0;
  if (currentBytes + Buffer.byteLength(line) > MAX_JOURNAL_BYTES) {
    throw new Error("backup journal retention limit reached");
  }
  writeAtomic(pendingPath(config), {
    format: PENDING_FORMAT,
    previousBytes: currentBytes,
    previousHash: payload.previousHash,
    resultHash,
    sequence: payload.sequence,
    signature: record.signature,
    signer: record.signer,
  });
  const descriptor = openSync(path, "a", 0o600);
  try { writeSync(descriptor, line); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  syncDirectory(config.stateDirectory);
  const nextRecords = [...state.records, record];
  const head = { format: HEAD_FORMAT, journalHash: journalHash(nextRecords), resultHash,
    sequence: payload.sequence };
  for (const path of headPaths(config)) writeAtomic(path, head);
  rmSync(pendingPath(config));
  syncDirectory(config.stateDirectory);
  return record;
}

function errorCode(error) {
  const message = String(error?.message ?? "operation failed").toLowerCase();
  const code = message.includes("stale") ? "stale-receipt"
    : message.includes("already running") ? "concurrent-run"
      : message.includes("no agreed") || message.includes("download") ? "restore-incomplete"
        : message.includes("space") || ["ENOSPC", "EDQUOT", "EIO"].includes(error?.code) ? "storage-error"
          : "operation-failed";
  if (Buffer.byteLength(code) > MAX_ERROR_CODE_BYTES) throw new Error("invalid error code");
  return code;
}

function safeChildren(root, prefix) {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.startsWith(prefix)).map((name) => {
    const path = join(root, name);
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("backup retention encountered an unsafe entry");
    }
    return { modifiedAt: metadata.mtimeMs, name, path };
  }).sort((left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name));
}

function clearCrashStaging(root) {
  if (!existsSync(root)) return;
  for (const entry of safeChildren(root, ".staging-")) rmSync(entry.path, { recursive: true });
  syncDirectory(root);
}

function childName(root, path, prefix) {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  const name = basename(absolutePath);
  if (dirname(absolutePath) !== absoluteRoot || !name.startsWith(prefix)) {
    throw new Error("automation operation returned an unsafe workspace");
  }
  return name;
}

function applyRetention(root, prefix, maximum, protectedNames = new Set()) {
  const entries = safeChildren(root, prefix);
  const present = new Set(entries.map(({ name }) => name));
  const keep = new Set([...protectedNames].filter((name) => present.has(name)));
  for (const { name } of entries) {
    if (keep.size >= maximum) break;
    keep.add(name);
  }
  if (keep.size === 0 && entries[0]) keep.add(entries[0].name);
  for (const entry of entries) {
    if (!keep.has(entry.name)) rmSync(entry.path, { recursive: true });
  }
  if (existsSync(root)) syncDirectory(root);
  return safeChildren(root, prefix).map(({ name }) => name);
}

function lastSuccessfulRecord(records) {
  return [...records].reverse().find(({ payload }) => payload.status === "success") ?? null;
}

function validateCompletedDrill(config, drill, expectedNetworkId) {
  if (drill?.networkId !== expectedNetworkId || !Number.isSafeInteger(drill.height) ||
      drill.height < 0 || !HASH.test(drill.checkpointHash ?? "") ||
      !HASH.test(drill.inventoryRoot ?? "") || !HASH.test(drill.tipHash ?? "")) {
    throw new Error("restore drill result is invalid");
  }
  const drillName = childName(config.drillRoot, drill.workspace, "drill-");
  const markerPath = join(config.drillRoot, drillName, "DRILL-COMPLETE.json");
  const marker = readBoundedJson(markerPath, MAX_RECORD_BYTES);
  if (marker?.format !== "nir-backup-restore-drill-v1" ||
      marker.networkId !== drill.networkId || marker.height !== drill.height ||
      marker.checkpointHash !== drill.checkpointHash || marker.inventoryRoot !== drill.inventoryRoot ||
      marker.tipHash !== drill.tipHash) throw new Error("restore drill completion marker is invalid");
  return drillName;
}

export function scheduledBackupTime(configInput, slot) {
  const config = validateBackupAutomationConfig(configInput);
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("backup schedule slot is invalid");
  const base = slot * config.intervalMs;
  if (config.jitterMs === 0) return base;
  const digest = createHash("sha256").update(`${config.operatorId}:${config.resultSigner.address}:${slot}`)
    .digest();
  const jitter = Number(digest.readBigUInt64BE() % BigInt(config.jitterMs + 1));
  return base + jitter;
}

export function backupAutomationDryRun(configInput, now = Date.now()) {
  const config = validateBackupAutomationConfig(configInput);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("automation clock is invalid");
  const slot = Math.floor(now / config.intervalMs) + 1;
  return {
    format: "nir-backup-automation-dry-run-v1",
    nextRunAt: scheduledBackupTime(config, slot),
    operatorId: config.operatorId,
    sources: config.sources.length,
    writesPerformed: false,
  };
}

export async function runBackupAutomationCycle(configInput, wallet, options = {}) {
  const config = validateBackupAutomationConfig(configInput);
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error("automation clock is invalid");
  const release = acquireAutomationLock(config.stateDirectory, {
    now: startedAt, pid: options.pid, processAlive: options.processAlive,
  });
  let backupName = null;
  let staging = null;
  let networkId = "unknown";
  try {
    const genesis = (options.readJson ?? readBoundedJson)(config.genesisPath);
    const trustedOperators = (options.readJson ?? readBoundedJson)(config.trustedOperatorsPath);
    if (typeof genesis.networkId !== "string" || genesis.networkId.length < 1 ||
        Buffer.byteLength(genesis.networkId) > 256) throw new Error("automation genesis is invalid");
    networkId = genesis.networkId;
    const suffix = `${String(startedAt).padStart(13, "0")}-${randomBytes(6).toString("hex")}`;
    backupName = `backup-${suffix}`;
    const finalBackup = join(config.backupRoot, backupName);
    staging = join(config.backupRoot, `.staging-${suffix}`);
    ensureDirectory(config.backupRoot);
    ensureDirectory(config.drillRoot);
    clearCrashStaging(config.backupRoot);
    const localBackup = (options.exportBackup ?? exportBlockStoreBackup)(
      config.liveDirectory, staging, genesis,
    );
    const exported = lstatSync(staging);
    if (!exported.isDirectory() || exported.isSymbolicLink() ||
        localBackup?.networkId !== genesis.networkId ||
        !Number.isSafeInteger(localBackup.height) || localBackup.height < 0 ||
        !HASH.test(localBackup.tipHash ?? "") || localBackup.privateKeysIncluded !== false) {
      throw new Error("local backup export is invalid");
    }
    renameSync(staging, finalBackup);
    staging = null;
    syncDirectory(config.backupRoot);
    const drill = await (options.restoreDrill ?? runRemoteBackupRestoreDrill)(
      config.drillRoot, config.sources, genesis,
      { allowInsecureLocalhost: true, maxAgeMs: config.maxReceiptAgeMs,
        now: startedAt, trustedOperators },
    );
    const drillName = validateCompletedDrill(config, drill, genesis.networkId);
    const completedAt = now();
    const record = appendResult(config, wallet, {
      backupName,
      checkpointHash: drill.checkpointHash,
      completedAt,
      drillName,
      height: drill.height,
      inventoryRoot: drill.inventoryRoot,
      localHeight: localBackup.height,
      localTipHash: localBackup.tipHash,
      networkId: drill.networkId,
      startedAt,
      status: "success",
      tipHash: drill.tipHash,
    }, options);
    const journal = readBackupAutomationJournal(config);
    const lastSuccess = lastSuccessfulRecord(journal.records);
    applyRetention(config.backupRoot, "backup-", config.maxBackups,
      new Set([lastSuccess?.payload.backupName].filter(Boolean)));
    applyRetention(config.drillRoot, "drill-", config.maxDrillWorkspaces,
      new Set([lastSuccess?.payload.drillName].filter(Boolean)));
    return record;
  } catch (error) {
    if (staging) rmSync(staging, { recursive: true, force: true });
    const completedAt = now();
    try {
      return appendResult(config, wallet, {
        backupName,
        completedAt,
        errorCode: errorCode(error),
        networkId,
        startedAt,
        status: "failure",
      }, options);
    } catch (journalError) {
      journalError.cause = error;
      throw journalError;
    }
  } finally { release(); }
}

export function backupAutomationHealth(configInput, {
  minimumSequence = 0, now = Date.now(), expectedHeadHash = null,
} = {}) {
  const config = validateBackupAutomationConfig(configInput);
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(minimumSequence) ||
      minimumSequence < 0 || (expectedHeadHash !== null && !HASH.test(expectedHeadHash))) {
    throw new Error("backup health policy is invalid");
  }
  const { head, records } = readBackupAutomationJournal(config);
  const latest = records.at(-1) ?? null;
  const lastSuccess = lastSuccessfulRecord(records);
  const reasons = [];
  if (minimumSequence > 0 && (!head || head.sequence < minimumSequence)) {
    reasons.push("journal-rollback");
  }
  if (expectedHeadHash && head?.resultHash !== expectedHeadHash) reasons.push("head-mismatch");
  if (!latest) reasons.push("never-run");
  else {
    if (latest.payload.startedAt > now + 5 * 60 * 1000 ||
        latest.payload.completedAt > now + 5 * 60 * 1000) reasons.push("clock-anomaly");
    if (latest.payload.status !== "success") reasons.push("latest-run-failed");
    if (now - latest.payload.completedAt > config.intervalMs + config.jitterMs) {
      reasons.push("scheduled-run-missed");
    }
  }
  if (!lastSuccess || now - lastSuccess.payload.completedAt > config.maxSuccessAgeMs) {
    reasons.push("successful-drill-stale");
  } else {
    const backupPath = join(config.backupRoot, lastSuccess.payload.backupName);
    const drillPath = join(config.drillRoot, lastSuccess.payload.drillName);
    const safeDirectory = (path) => {
      try {
        const metadata = lstatSync(path);
        return metadata.isDirectory() && !metadata.isSymbolicLink();
      } catch { return false; }
    };
    if (!safeDirectory(backupPath)) reasons.push("confirmed-backup-missing");
    if (!safeDirectory(drillPath) || !existsSync(join(drillPath, "DRILL-COMPLETE.json"))) {
      reasons.push("confirmed-drill-missing");
    }
  }
  return {
    format: "nir-backup-automation-health-v1",
    healthy: reasons.length === 0,
    lastAttemptAt: latest?.payload.completedAt ?? null,
    lastSuccessAt: lastSuccess?.payload.completedAt ?? null,
    operatorId: config.operatorId,
    reasons,
    resultHash: head?.resultHash ?? null,
    sequence: head?.sequence ?? 0,
  };
}

export async function runBackupAutomationScheduler(configInput, wallet, options = {}) {
  const config = validateBackupAutomationConfig(configInput);
  const now = options.now ?? (() => Date.now());
  const signal = options.signal;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolveSleep) => {
    if (signal?.aborted) { resolveSleep(); return; }
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  }));
  let runs = 0;
  while (!signal?.aborted) {
    const current = now();
    let slot = Math.floor(current / config.intervalMs);
    const latest = readBackupAutomationJournal(config).records.at(-1);
    const latestSlot = latest ? Math.floor(latest.payload.startedAt / config.intervalMs) : -1;
    if (latestSlot >= slot) slot = latestSlot + 1;
    let scheduled = scheduledBackupTime(config, slot);
    if (scheduled <= current) {
      await runBackupAutomationCycle(config, wallet, options);
      runs += 1;
      if (options.maximumRuns && runs >= options.maximumRuns) return runs;
      slot += 1;
      scheduled = scheduledBackupTime(config, slot);
    }
    await sleep(Math.max(1, scheduled - now()));
  }
  return runs;
}

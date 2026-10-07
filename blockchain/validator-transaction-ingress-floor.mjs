import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { canonicalJson, hashObject } from "./crypto.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";

const FORMAT = "nir-transaction-ingress-floor-v1";
const PRIMARY = "FLOOR.primary.json";
const SECONDARY = "FLOOR.secondary.json";
const LOCK = ".floor.lock";
const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const MAX_BYTES = 4096;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}
function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function safeNumber(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}
function requireFilesystem() {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0 ||
      !Number.isInteger(constants.O_DIRECTORY) || constants.O_DIRECTORY === 0 ||
      !Number.isInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK === 0) {
    throw new Error("transaction ingress floor requires secure filesystem opens");
  }
}
function openRoot(pathValue, create = false) {
  requireFilesystem();
  if (typeof pathValue !== "string" || !pathValue || pathValue.includes("\0")) {
    throw new Error("transaction ingress floor directory is invalid");
  }
  const path = resolve(pathValue);
  if (create) mkdirSync(path, { mode: 0o700 });
  const linked = lstatSync(path);
  if (!linked.isDirectory() || linked.isSymbolicLink() || (linked.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && linked.uid !== process.getuid())) {
    throw new Error("transaction ingress floor directory is unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY |
    constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  if (!opened.isDirectory() || !same(linked, opened)) {
    closeSync(descriptor); throw new Error("transaction ingress floor directory changed");
  }
  return { descriptor, metadata: opened, path };
}
function assertRoot(root) {
  const opened = fstatSync(root.descriptor); const linked = lstatSync(root.path);
  if (!opened.isDirectory() || !linked.isDirectory() || linked.isSymbolicLink() ||
      !same(root.metadata, opened) || !same(root.metadata, linked) ||
      (opened.mode & 0o077) !== 0 || (linked.mode & 0o077) !== 0 ||
      opened.uid !== root.metadata.uid || linked.uid !== root.metadata.uid) {
    throw new Error("transaction ingress floor directory changed");
  }
}
function identity(value) {
  exact(value, ["expectedGenesisHash", "expectedNetworkId", "expectedPolicyId",
    "validatorAddress"], "transaction ingress floor identity");
  if (!HASH.test(value.expectedGenesisHash ?? "") ||
      !TAGGED_HASH.test(value.expectedPolicyId ?? "") ||
      !ADDRESS.test(value.validatorAddress ?? "") ||
      typeof value.expectedNetworkId !== "string" || value.expectedNetworkId.length < 3 ||
      value.expectedNetworkId.length > 128) {
    throw new Error("transaction ingress floor identity is invalid");
  }
  return structuredClone(value);
}
function recordPayload(value) {
  exact(value, ["expectedGenesisHash", "expectedNetworkId", "expectedPolicyId", "format",
    "height", "historyCount", "historyHead", "observedAt", "packageHash",
    "previousRecordHash", "revision", "sequence", "tipHash", "validatorAddress",
    "version"], "transaction ingress floor record");
  identity({ expectedGenesisHash: value.expectedGenesisHash,
    expectedNetworkId: value.expectedNetworkId, expectedPolicyId: value.expectedPolicyId,
    validatorAddress: value.validatorAddress });
  if (value.format !== FORMAT || value.version !== 1 ||
      !safeNumber(value.revision) || !safeNumber(value.height) ||
      !safeNumber(value.sequence) || !safeNumber(value.historyCount) ||
      !safeNumber(value.observedAt) ||
      (value.revision === 0) !== (value.previousRecordHash === null) ||
      (value.previousRecordHash !== null && !HASH.test(value.previousRecordHash ?? "")) ||
      (value.height === 0) !== (value.tipHash === null) ||
      (value.height === 0) !== (value.packageHash === null) ||
      (value.historyCount === 0) !== (value.historyHead === null) ||
      (value.tipHash !== null && !HASH.test(value.tipHash ?? "")) ||
      (value.packageHash !== null && !TAGGED_HASH.test(value.packageHash ?? "")) ||
      (value.historyHead !== null && !HASH.test(value.historyHead ?? "")) ||
      (value.revision === 0 && (value.height !== 0 || value.sequence !== 0 ||
        value.historyCount !== 0 || value.observedAt !== 0))) {
    throw new Error("transaction ingress floor record is invalid");
  }
  return structuredClone(value);
}
function seal(payload) {
  const valid = recordPayload(payload);
  return { ...valid, recordHash: hashObject(valid, "TRANSACTION_INGRESS_FLOOR_V1") };
}
function validateRecord(value) {
  exact(value, ["expectedGenesisHash", "expectedNetworkId", "expectedPolicyId", "format",
    "height", "historyCount", "historyHead", "observedAt", "packageHash",
    "previousRecordHash", "recordHash", "revision", "sequence", "tipHash",
    "validatorAddress", "version"], "transaction ingress floor envelope");
  const { recordHash, ...payload } = value;
  const sealed = seal(payload);
  if (recordHash !== sealed.recordHash) throw new Error("transaction ingress floor hash is invalid");
  return sealed;
}
function readCopy(path) {
  const linked = lstatSync(path);
  if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1 ||
      (linked.mode & 0o077) !== 0 || linked.size < 2 || linked.size > MAX_BYTES ||
      (typeof process.getuid === "function" && linked.uid !== process.getuid())) {
    throw new Error("transaction ingress floor copy is unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    constants.O_NONBLOCK);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !same(linked, opened) || opened.nlink !== 1 ||
        (opened.mode & 0o077) !== 0) {
      throw new Error("transaction ingress floor copy changed during open");
    }
    const bytes = Buffer.alloc(opened.size); let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("transaction ingress floor copy was truncated");
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(descriptor, extra, 0, 1, bytes.length) !== 0) {
      throw new Error("transaction ingress floor copy expanded during read");
    }
    const after = fstatSync(descriptor); const finalLink = lstatSync(path);
    if (!same(opened, after) || !same(opened, finalLink) ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs || (after.mode & 0o077) !== 0 ||
        (finalLink.mode & 0o077) !== 0 ||
        after.uid !== opened.uid || finalLink.uid !== opened.uid) {
      throw new Error("transaction ingress floor copy changed during read");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = parseConsensusJson(text);
    if (text !== `${canonicalJson(value)}\n`) {
      throw new Error("transaction ingress floor copy is not canonical JSON");
    }
    return validateRecord(value);
  } finally { closeSync(descriptor); }
}
function loadCopies(root) {
  assertRoot(root);
  const a = readCopy(join(root.path, PRIMARY));
  const b = readCopy(join(root.path, SECONDARY));
  if (a.recordHash === b.recordHash) return a;
  const [older, newer] = a.revision < b.revision ? [a, b] : [b, a];
  if (newer.revision !== older.revision + 1 ||
      newer.previousRecordHash !== older.recordHash ||
      newer.expectedGenesisHash !== older.expectedGenesisHash ||
      newer.expectedNetworkId !== older.expectedNetworkId ||
      newer.expectedPolicyId !== older.expectedPolicyId ||
      newer.validatorAddress !== older.validatorAddress) {
    throw new Error("transaction ingress floor copies diverged");
  }
  assertMonotonic(older, newer);
  return newer;
}
function assertMonotonic(old, next) {
  if (next.height < old.height || next.sequence < old.sequence ||
      next.historyCount < old.historyCount || next.observedAt < old.observedAt ||
      (next.height > old.height && next.sequence <= old.sequence) ||
      (next.sequence > old.sequence && next.packageHash === old.packageHash) ||
      (next.height === old.height && next.tipHash !== old.tipHash) ||
      (next.sequence === old.sequence && next.packageHash !== old.packageHash) ||
      (next.historyCount === old.historyCount && next.historyHead !== old.historyHead)) {
    throw new Error("transaction ingress floor rollback or divergence is rejected");
  }
}
function validateIdentity(record, expected) {
  if (record.expectedGenesisHash !== expected.expectedGenesisHash ||
      record.expectedNetworkId !== expected.expectedNetworkId ||
      record.expectedPolicyId !== expected.expectedPolicyId ||
      record.validatorAddress !== expected.validatorAddress) {
    throw new Error("transaction ingress floor identity does not match pins");
  }
}
function readLock(path) {
  const linked = lstatSync(path);
  if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1 ||
      (linked.mode & 0o077) !== 0 || linked.size < 2 || linked.size > 256) {
    throw new Error("transaction ingress floor lock is unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    constants.O_NONBLOCK);
  try {
    const opened = fstatSync(descriptor);
    if (!same(linked, opened) || !opened.isFile() || opened.nlink !== 1 ||
        (opened.mode & 0o077) !== 0) {
      throw new Error("transaction ingress floor lock changed");
    }
    const bytes = Buffer.alloc(opened.size);
    if (readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) {
      throw new Error("transaction ingress floor lock is truncated");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = parseConsensusJson(text);
    exact(value, ["pid", "token"], "transaction ingress floor lock");
    if (!safeNumber(value.pid, 1) || !HASH.test(value.token ?? "") ||
        text !== `${canonicalJson(value)}\n`) {
      throw new Error("transaction ingress floor lock is invalid");
    }
    const after = fstatSync(descriptor); const finalLink = lstatSync(path);
    if (!same(opened, after) || !same(opened, finalLink) ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs) {
      throw new Error("transaction ingress floor lock changed during read");
    }
    return { identity: opened, value };
  } finally { closeSync(descriptor); }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}
function acquireLock(root) {
  const path = join(root.path, LOCK); assertRoot(root);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const value = { pid: process.pid, token: randomBytes(32).toString("hex") };
    let descriptor;
    try {
      descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) throw error;
      const stale = readLock(path);
      if (processAlive(stale.value.pid)) {
        throw new Error("transaction ingress floor is held by a live writer");
      }
      assertRoot(root);
      const linked = lstatSync(path);
      if (!same(stale.identity, linked) || processAlive(stale.value.pid)) {
        throw new Error("transaction ingress floor stale lock changed");
      }
      unlinkSync(path); fsyncSync(root.descriptor);
      continue;
    }
    let opened = null;
    try {
      opened = fstatSync(descriptor);
      writeFileSync(descriptor, `${canonicalJson(value)}\n`); fsyncSync(descriptor);
      const linked = lstatSync(path);
      if (!same(opened, linked) || (opened.mode & 0o077) !== 0) {
        throw new Error("transaction ingress floor lock changed after creation");
      }
      fsyncSync(root.descriptor);
      return { descriptor, identity: opened, path, value };
    } catch (error) {
      closeSync(descriptor);
      if (opened !== null) {
        try {
          const linked = lstatSync(path);
          if (same(opened, linked) && linked.isFile() && !linked.isSymbolicLink()) {
            unlinkSync(path); fsyncSync(root.descriptor);
          }
        } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") throw cleanupError; }
      }
      throw error;
    }
  }
  throw new Error("transaction ingress floor lock cannot be acquired");
}
function releaseLock(root, lock) {
  closeSync(lock.descriptor);
  assertRoot(root);
  const current = readLock(lock.path);
  if (!same(current.identity, lock.identity) || current.value.token !== lock.value.token) {
    throw new Error("transaction ingress floor writer lock changed");
  }
  unlinkSync(lock.path); fsyncSync(root.descriptor);
}
function writeCopy(root, name, record, hook) {
  assertRoot(root);
  const target = join(root.path, name);
  const temporary = join(root.path, `.${name}.${randomBytes(16).toString("hex")}.tmp`);
  let created = false;
  try {
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { writeFileSync(descriptor, `${canonicalJson(record)}\n`); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    hook?.({ name, target, temporary });
    const linked = lstatSync(temporary);
    if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1 ||
        (linked.mode & 0o077) !== 0) {
      throw new Error("transaction ingress floor temporary file is unsafe");
    }
    assertRoot(root);
    renameSync(temporary, target); created = false;
    fsyncSync(root.descriptor); assertRoot(root);
    if (readCopy(target).recordHash !== record.recordHash) {
      throw new Error("transaction ingress floor installed copy differs");
    }
  } finally {
    if (created) {
      const linked = lstatSync(temporary);
      if (!linked.isFile() || linked.isSymbolicLink()) {
        throw new Error("transaction ingress floor temporary path was replaced");
      }
      unlinkSync(temporary);
    }
  }
}
const observed = new Map();
function rejectInProcessRollback(root, record) {
  const prior = observed.get(root.path);
  if (prior && (record.revision < prior.revision ||
      (record.revision === prior.revision && record.recordHash !== prior.recordHash))) {
    throw new Error("transaction ingress floor in-process rollback is rejected");
  }
  observed.set(root.path, { revision: record.revision, recordHash: record.recordHash });
}

/** Explicit one-time initialization. Ordinary gate startup never recreates missing state. */
export function initializeTransactionIngressFloor(directory, expectedIdentity) {
  const pins = identity(expectedIdentity);
  const root = openRoot(directory, true); let lock;
  try {
    lock = acquireLock(root);
    const record = seal({ ...pins, format: FORMAT, height: 0, historyCount: 0,
      historyHead: null, observedAt: 0, packageHash: null,
      previousRecordHash: null, revision: 0, sequence: 0, tipHash: null, version: 1 });
    for (const name of [PRIMARY, SECONDARY]) {
      try { lstatSync(join(root.path, name)); }
      catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      throw new Error("transaction ingress floor is already initialized");
    }
    writeCopy(root, PRIMARY, record);
    writeCopy(root, SECONDARY, record);
    rejectInProcessRollback(root, record);
    return structuredClone(record);
  } finally { if (lock) releaseLock(root, lock); closeSync(root.descriptor); }
}

export function loadTransactionIngressFloor(directory, expectedIdentity) {
  const pins = identity(expectedIdentity);
  const root = openRoot(directory);
  try {
    const record = loadCopies(root); validateIdentity(record, pins);
    rejectInProcessRollback(root, record);
    return structuredClone(record);
  } finally { closeSync(root.descriptor); }
}

/** Persist the verified evidence floor before forwarding any transaction. */
export function advanceTransactionIngressFloor(directory, expectedIdentity, candidate, {
  _afterFirstCopy, _beforeCopyRename,
} = {}) {
  const pins = identity(expectedIdentity);
  const root = openRoot(directory); let lock;
  try {
    lock = acquireLock(root);
    const old = loadCopies(root); validateIdentity(old, pins);
    rejectInProcessRollback(root, old);
    exact(candidate, ["height", "historyCount", "historyHead", "observedAt",
      "packageHash", "sequence", "tipHash"], "transaction ingress floor candidate");
    const unchanged = ["height", "historyCount", "historyHead", "observedAt",
      "packageHash", "sequence", "tipHash"].every((key) => old[key] === candidate[key]);
    if (unchanged) return structuredClone(old);
    const next = seal({ ...pins, ...candidate, format: FORMAT,
      previousRecordHash: old.recordHash, revision: old.revision + 1, version: 1 });
    assertMonotonic(old, next);
    writeCopy(root, PRIMARY, next, _beforeCopyRename);
    rejectInProcessRollback(root, next);
    _afterFirstCopy?.();
    writeCopy(root, SECONDARY, next, _beforeCopyRename);
    return structuredClone(next);
  } finally { if (lock) releaseLock(root, lock); closeSync(root.descriptor); }
}

import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

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
const LOCK_TEMP = /^\.floor-lock\.[0-9a-f]{32}\.tmp$/;

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
function readCopy(path, afterOpen) {
  const linked = lstatSync(path);
  if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1 ||
      (linked.mode & 0o077) !== 0 || linked.size < 2 || linked.size > MAX_BYTES ||
      (typeof process.getuid === "function" && linked.uid !== process.getuid())) {
    throw new Error("transaction ingress floor copy is unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    constants.O_NONBLOCK);
  try {
    afterOpen?.({ descriptor, path });
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !same(linked, opened) || opened.nlink !== 1 ||
        opened.size !== linked.size || opened.size < 2 || opened.size > MAX_BYTES ||
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
function loadCopies(root, afterOpen) {
  assertRoot(root);
  const a = readCopy(join(root.path, PRIMARY), afterOpen);
  const b = readCopy(join(root.path, SECONDARY), afterOpen);
  if (a.recordHash === b.recordHash) return { record: a, staleCopy: null };
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
  return { record: newer, staleCopy: newer === a ? SECONDARY : PRIMARY };
}
function assertMonotonic(old, next) {
  const firstPackage = old.revision === 0 && old.height === 0 &&
    old.packageHash === null && next.height > 0;
  if (next.height < old.height || next.sequence < old.sequence ||
      next.historyCount < old.historyCount || next.observedAt < old.observedAt ||
      (!firstPackage && next.height > old.height && next.sequence <= old.sequence) ||
      (next.sequence > old.sequence && next.packageHash === old.packageHash) ||
      (next.height === old.height && next.tipHash !== old.tipHash) ||
      (!firstPackage && next.sequence === old.sequence &&
        next.packageHash !== old.packageHash) ||
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
function readLock(path, afterOpen) {
  const linked = lstatSync(path);
  if (!linked.isFile() || linked.isSymbolicLink() || ![1, 2].includes(linked.nlink) ||
      (linked.mode & 0o077) !== 0 || linked.size < 2 || linked.size > 256) {
    throw new Error("transaction ingress floor lock is unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    constants.O_NONBLOCK);
  try {
    afterOpen?.({ descriptor, path });
    const opened = fstatSync(descriptor);
    if (!same(linked, opened) || !opened.isFile() || opened.nlink !== linked.nlink ||
        opened.size !== linked.size || opened.size < 2 || opened.size > 256 ||
        (opened.mode & 0o077) !== 0) {
      throw new Error("transaction ingress floor lock changed");
    }
    const bytes = Buffer.alloc(opened.size);
    if (readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) {
      throw new Error("transaction ingress floor lock is truncated");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = parseConsensusJson(text);
    exact(value, ["pid", "temporaryName", "token"], "transaction ingress floor lock");
    if (!safeNumber(value.pid, 1) || !HASH.test(value.token ?? "") ||
        !LOCK_TEMP.test(value.temporaryName ?? "") ||
        text !== `${canonicalJson(value)}\n`) {
      throw new Error("transaction ingress floor lock is invalid");
    }
    if (opened.nlink === 2) {
      const temporary = lstatSync(join(dirname(path), value.temporaryName));
      if (!temporary.isFile() || temporary.isSymbolicLink() ||
          !same(opened, temporary) || temporary.nlink !== 2) {
        throw new Error("transaction ingress floor linked lock temporary is invalid");
      }
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
function acquireLock(root, afterLockPublish, afterLockTemporaryOpen) {
  const path = join(root.path, LOCK); assertRoot(root);
  const temporaryName = `.floor-lock.${randomBytes(16).toString("hex")}.tmp`;
  const temporary = join(root.path, temporaryName);
  const value = { pid: process.pid, temporaryName,
    token: randomBytes(32).toString("hex") };
  let descriptor; let opened = null; let published = false;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    opened = fstatSync(descriptor);
    afterLockTemporaryOpen?.();
    writeFileSync(descriptor, `${canonicalJson(value)}\n`); fsyncSync(descriptor);
    const ready = lstatSync(temporary);
    if (!same(opened, ready) || !ready.isFile() || ready.isSymbolicLink() ||
        ready.nlink !== 1 || (ready.mode & 0o077) !== 0) {
      throw new Error("transaction ingress floor temporary lock changed");
    }
    assertRoot(root);
    // linkSync is create-only. An existing lock, including one from a dead
    // process, remains untouched and requires deliberate operator recovery.
    linkSync(temporary, path); published = true;
    fsyncSync(root.descriptor);
    afterLockPublish?.();
    const linked = lstatSync(path);
    if (!same(opened, linked) || linked.nlink !== 2) {
      throw new Error("transaction ingress floor published lock changed");
    }
    unlinkSync(temporary);
    fsyncSync(root.descriptor);
    return { descriptor, identity: opened, path, value };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (opened !== null) {
      try {
        if (published) {
          const linked = lstatSync(path);
          if (!same(opened, linked) || linked.isSymbolicLink()) {
            throw new Error("transaction ingress floor published lock changed");
          }
          unlinkSync(path); fsyncSync(root.descriptor);
        }
      } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") throw cleanupError; }
      try {
        const linked = lstatSync(temporary);
        if (!same(opened, linked) || linked.isSymbolicLink()) {
          throw new Error("transaction ingress floor temporary lock changed");
        }
        unlinkSync(temporary); fsyncSync(root.descriptor);
      } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") throw cleanupError; }
    }
    throw error;
  }
}
function releaseLock(root, lock, afterLockOpen) {
  closeSync(lock.descriptor);
  assertRoot(root);
  const current = readLock(lock.path, afterLockOpen);
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
export function initializeTransactionIngressFloor(directory, expectedIdentity, {
  _afterFirstCopy,
} = {}) {
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
    _afterFirstCopy?.();
    writeCopy(root, SECONDARY, record);
    rejectInProcessRollback(root, record);
    return structuredClone(record);
  } finally { if (lock) releaseLock(root, lock); closeSync(root.descriptor); }
}

export function loadTransactionIngressFloor(directory, expectedIdentity, {
  _afterCopyOpen,
} = {}) {
  const pins = identity(expectedIdentity);
  const root = openRoot(directory);
  try {
    const { record } = loadCopies(root, _afterCopyOpen); validateIdentity(record, pins);
    rejectInProcessRollback(root, record);
    return structuredClone(record);
  } finally { closeSync(root.descriptor); }
}

/** Persist the verified evidence floor before forwarding any transaction. */
export function advanceTransactionIngressFloor(directory, expectedIdentity, candidate, {
  _afterFirstCopy, _afterLockOpen, _afterLockPublish, _afterLockTemporaryOpen,
  _afterRepair, _beforeCopyRename,
} = {}) {
  const pins = identity(expectedIdentity);
  const root = openRoot(directory); let lock;
  try {
    lock = acquireLock(root, _afterLockPublish, _afterLockTemporaryOpen);
    const { record: old, staleCopy } = loadCopies(root); validateIdentity(old, pins);
    rejectInProcessRollback(root, old);
    // Normalize a one-step crash pair before starting another revision. Otherwise a
    // second crash could leave r+2 next to r, which cannot be safely reconciled.
    if (staleCopy !== null) {
      writeCopy(root, staleCopy, old, _beforeCopyRename);
      _afterRepair?.();
    }
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
  } finally { if (lock) releaseLock(root, lock, _afterLockOpen); closeSync(root.descriptor); }
}

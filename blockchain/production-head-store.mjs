import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { canonicalJson, hashObject } from "./crypto.mjs";
import {
  readNodeProductionProvenance, readWalletProductionProvenance,
} from "./release-artifact.mjs";
import { verifyProductionInstallation } from "./production-release-gate.mjs";

const STORE_FORMAT = "nir-production-head-store-v1";
const RECORD_FORMAT = "nir-production-head-record-v1";
const ANCHOR_FORMAT = "nir-production-head-anchor-v1";
const PRIMARY = "HEAD.primary.json";
const BACKUP = "HEAD.backup.json";
const LOCK = ".writer.lock";
const ZERO = "0".repeat(64);
const HASH = /^[0-9a-f]{64}$/;
const MAX_RECORDS = 4096;
const MAX_STORE_BYTES = 4 * 1024 * 1024;

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}
function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function stableVersion(value) {
  if (typeof value !== "string" ||
      !/^(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})$/.test(value)) {
    throw new Error("production head release version is invalid");
  }
  return value;
}
function compareVersions(left, right) {
  const a = stableVersion(left).split(".").map(Number);
  const b = stableVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}
function requireFs() {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY) ||
      !Number.isInteger(constants.O_NONBLOCK) || constants.O_NOFOLLOW === 0 ||
      constants.O_DIRECTORY === 0) throw new Error("secure production head filesystem is unavailable");
}
function openRoot(pathValue, create = false) {
  requireFs(); const path = resolve(pathValue);
  if (create) try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const linked = lstatSync(path);
  if (!linked.isDirectory() || linked.isSymbolicLink() || (linked.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && linked.uid !== process.getuid())) {
    throw new Error("production head root is unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  if (!opened.isDirectory() || !same(linked, opened)) {
    closeSync(descriptor); throw new Error("production head root changed during open");
  }
  return { descriptor, metadata: opened, path };
}
function assertRoot(root) {
  const descriptor = fstatSync(root.descriptor); const linked = lstatSync(root.path);
  if (!linked.isDirectory() || linked.isSymbolicLink() || !same(root.metadata, descriptor) ||
      !same(root.metadata, linked) || descriptor.mode !== root.metadata.mode ||
      descriptor.uid !== root.metadata.uid) throw new Error("production head root changed");
}
function recordPayload(value) {
  exact(value, ["format", "genesisHash", "kind", "networkId", "packageHash",
    "previousRecordHash", "releaseVersion", "sequence", "version"], "production head record");
  if (value.format !== RECORD_FORMAT || value.version !== 1 ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !["node", "wallet"].includes(value.kind) || typeof value.networkId !== "string" ||
      value.networkId.length < 1 || value.networkId.length > 128 ||
      /[\x00-\x1f\x7f]/.test(value.networkId) ||
      !/^(?:sha3-256:)?[0-9a-f]{64}$/.test(value.genesisHash ?? "") ||
      !HASH.test(value.packageHash ?? "") || !HASH.test(value.previousRecordHash ?? "")) {
    throw new Error("production head record is invalid");
  }
  stableVersion(value.releaseVersion);
  return structuredClone(value);
}
function validateStore(value) {
  exact(value, ["checksum", "count", "format", "headHash", "records", "version"],
    "production head store");
  if (value.format !== STORE_FORMAT || value.version !== 1 || !Array.isArray(value.records) ||
      value.records.length > MAX_RECORDS || value.count !== value.records.length ||
      !Number.isSafeInteger(value.count) || value.count < 0 || !HASH.test(value.headHash ?? "")) {
    throw new Error("production head store header is invalid");
  }
  let prior = ZERO; let context = null; const packages = new Set();
  const records = value.records.map((envelope, index) => {
    exact(envelope, ["record", "recordHash"], "production head envelope");
    const record = recordPayload(envelope.record);
    const recordHash = hashObject(record, "PRODUCTION_HEAD_RECORD_V1");
    if (envelope.recordHash !== recordHash || record.sequence !== index + 1 ||
        record.previousRecordHash !== prior || packages.has(record.packageHash)) {
      throw new Error("production head hash chain, sequence, or replay is invalid");
    }
    if (context === null) context = record;
    else if (record.networkId !== context.networkId || record.genesisHash !== context.genesisHash ||
        record.kind !== context.kind || compareVersions(record.releaseVersion,
          value.records[index - 1].record.releaseVersion) <= 0) {
      throw new Error("production head context changed or version did not increase");
    }
    packages.add(record.packageHash); prior = recordHash;
    return { record, recordHash };
  });
  const headHash = records.at(-1)?.recordHash ?? ZERO;
  const payload = { count: records.length, format: STORE_FORMAT, headHash, records, version: 1 };
  if (value.headHash !== headHash || value.checksum !== hashObject(payload, "PRODUCTION_HEAD_STORE_V1")) {
    throw new Error("production head checksum is invalid");
  }
  return { ...payload, checksum: value.checksum };
}
function emptyStore() {
  const payload = { count: 0, format: STORE_FORMAT, headHash: ZERO, records: [], version: 1 };
  return { ...payload, checksum: hashObject(payload, "PRODUCTION_HEAD_STORE_V1") };
}
function readCopy(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 ||
        before.size > MAX_STORE_BYTES || (before.mode & 0o077) !== 0) {
      throw new Error("production head copy is unsafe");
    }
    const contents = readFileSync(descriptor); const after = fstatSync(descriptor);
    const linked = lstatSync(path);
    if (!same(before, after) || !same(before, linked) || contents.length !== before.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("production head copy changed during read");
    }
    const text = contents.toString("utf8"); const value = JSON.parse(text);
    if (text !== `${canonicalJson(value)}\n`) throw new Error("production head copy is not canonical");
    return validateStore(value);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function loadCopies(root) {
  const paths = [join(root.path, PRIMARY), join(root.path, BACKUP)];
  const present = []; const valid = [];
  for (const path of paths) {
    try { lstatSync(path); present.push(path); valid.push(readCopy(path)); }
    catch (error) { if (error?.code !== "ENOENT") present.push(path); }
  }
  if (present.length === 0) return { copiesSynchronized: false, copiesValid: 0, store: emptyStore() };
  if (valid.length === 0) throw new Error("both production head copies are invalid");
  valid.sort((a, b) => b.count - a.count);
  const selected = valid[0];
  for (const candidate of valid.slice(1)) {
    if (candidate.count === selected.count && candidate.headHash !== selected.headHash ||
        candidate.records.some((entry, index) =>
          entry.recordHash !== selected.records[index]?.recordHash)) {
      throw new Error("production head copies diverged");
    }
  }
  return { copiesSynchronized: valid.length === 2 &&
    valid.every((candidate) => candidate.headHash === selected.headHash),
  copiesValid: valid.length, store: selected };
}
function acquireLock(root) {
  assertRoot(root); const path = join(root.path, LOCK);
  let descriptor; let identity = null;
  try {
    descriptor = openSync(path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(descriptor, 0o600); writeFileSync(descriptor, `${process.pid}\n`); fsyncSync(descriptor);
    identity = fstatSync(descriptor); closeSync(descriptor); descriptor = undefined;
    assertRoot(root); const linked = lstatSync(path);
    if (!linked.isFile() || linked.isSymbolicLink() || !same(identity, linked)) {
      throw new Error("production head writer lock is unsafe");
    }
    return { identity, path };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (identity !== null) try {
      const linked = lstatSync(path);
      if (linked.isFile() && !linked.isSymbolicLink() && same(identity, linked)) unlinkSync(path);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError.message;
    }
    throw error;
  }
}
function assertLock(lock) {
  const linked = lstatSync(lock.path);
  if (!linked.isFile() || linked.isSymbolicLink() || !same(lock.identity, linked)) {
    throw new Error("production head writer lock changed");
  }
}
function releaseLock(root, lock) {
  try {
    assertLock(lock);
    unlinkSync(lock.path); fsyncSync(root.descriptor);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("production head writer lock changed");
    throw error;
  }
}
function writeCopy(root, name, store, hook) {
  assertRoot(root); const target = join(root.path, name);
  const temporary = join(root.path, `.${name}.${randomBytes(16).toString("hex")}.tmp`);
  let identity = null;
  try {
    const descriptor = openSync(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const contents = `${canonicalJson(store)}\n`; writeFileSync(descriptor, contents);
      fchmodSync(descriptor, 0o600); fsyncSync(descriptor); identity = fstatSync(descriptor);
    } finally { closeSync(descriptor); }
    if (typeof hook === "function") hook({ name, root: root.path, target, temporary });
    assertRoot(root); const linked = lstatSync(temporary);
    if (!linked.isFile() || linked.isSymbolicLink() || !same(identity, linked)) {
      throw new Error("production head temporary changed");
    }
    renameSync(temporary, target); identity = null; fsyncSync(root.descriptor); assertRoot(root);
    const installed = readCopy(target);
    if (installed.headHash !== store.headHash || installed.count !== store.count) {
      throw new Error("production head copy verification failed");
    }
  } finally {
    if (identity !== null) try {
      const linked = lstatSync(temporary);
      if (linked.isFile() && !linked.isSymbolicLink() && same(identity, linked)) unlinkSync(temporary);
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}
function validateAnchor(value) {
  exact(value, ["checksum", "count", "format", "genesisHash", "headHash", "kind", "networkId",
    "packageHash", "releaseVersion", "version"], "production head anchor");
  const payload = { count: value.count, format: value.format, genesisHash: value.genesisHash,
    headHash: value.headHash, kind: value.kind, networkId: value.networkId,
    packageHash: value.packageHash, releaseVersion: value.releaseVersion, version: value.version };
  if (value.format !== ANCHOR_FORMAT || value.version !== 1 ||
      !Number.isSafeInteger(value.count) || value.count < 1 || !HASH.test(value.headHash ?? "") ||
      !HASH.test(value.packageHash ?? "") || !["node", "wallet"].includes(value.kind) ||
      typeof value.networkId !== "string" || !/^(?:sha3-256:)?[0-9a-f]{64}$/.test(value.genesisHash ?? "") ||
      value.checksum !== hashObject(payload, "PRODUCTION_HEAD_ANCHOR_V1")) {
    throw new Error("production head anchor is invalid");
  }
  stableVersion(value.releaseVersion); return structuredClone(value);
}
function requireAnchorPrefix(store, anchorValue) {
  if (anchorValue === undefined || anchorValue === null) return;
  const anchor = validateAnchor(anchorValue); const record = store.records[anchor.count - 1];
  if (!record || record.recordHash !== anchor.headHash || record.record.packageHash !== anchor.packageHash ||
      record.record.networkId !== anchor.networkId || record.record.genesisHash !== anchor.genesisHash ||
      record.record.kind !== anchor.kind || record.record.releaseVersion !== anchor.releaseVersion) {
    throw new Error("production head store is below or not on the external anchor prefix");
  }
}

export function loadProductionHeadStore(pathValue, { externalAnchor } = {}) {
  const root = openRoot(pathValue); try {
    const loaded = loadCopies(root); assertRoot(root); requireAnchorPrefix(loaded.store, externalAnchor);
    return { ...loaded.store, copiesSynchronized: loaded.copiesSynchronized,
      copiesValid: loaded.copiesValid };
  } finally { closeSync(root.descriptor); }
}

export function advanceProductionHead(pathValue, installationTarget, {
  expectedPreviousPackageHash = null, externalAnchor, kind, newPackageHash,
  signedRelease, trustedAddress, _afterCandidateVerification, _afterFirstCopy, _beforeCopyRename,
} = {}) {
  if (!HASH.test(newPackageHash ?? "") || !["node", "wallet"].includes(kind)) {
    throw new Error("production head advance candidate is invalid");
  }
  let verified = verifyProductionInstallation(installationTarget, {
    expectedPackageHash: newPackageHash, kind, signedRelease, trustedAddress,
  });
  const root = openRoot(pathValue, true); let lock;
  try {
    lock = acquireLock(root); const current = loadCopies(root).store;
    requireAnchorPrefix(current, externalAnchor);
    if (typeof _afterCandidateVerification === "function") _afterCandidateVerification();
    verified = verifyProductionInstallation(installationTarget, {
      expectedPackageHash: newPackageHash, kind, signedRelease, trustedAddress,
    });
    const previous = current.records.at(-1)?.record ?? null;
    if ((previous?.packageHash ?? null) !== expectedPreviousPackageHash) {
      throw new Error("production head expected previous package does not match");
    }
    if (current.records.some(({ record }) => record.packageHash === newPackageHash)) {
      throw new Error("production head package replay is forbidden");
    }
    if (previous && (previous.networkId !== verified.productionTarget.networkId ||
        previous.genesisHash !== verified.productionTarget.genesisHash || previous.kind !== kind ||
        compareVersions(verified.productionTarget.releaseVersion, previous.releaseVersion) <= 0)) {
      throw new Error("production head refuses rollback, downgrade, or mixed context");
    }
    const record = recordPayload({ format: RECORD_FORMAT,
      genesisHash: verified.productionTarget.genesisHash, kind,
      networkId: verified.productionTarget.networkId, packageHash: newPackageHash,
      previousRecordHash: current.headHash, releaseVersion: verified.productionTarget.releaseVersion,
      sequence: current.count + 1, version: 1 });
    const envelope = { record, recordHash: hashObject(record, "PRODUCTION_HEAD_RECORD_V1") };
    const records = [...current.records, envelope];
    const payload = { count: records.length, format: STORE_FORMAT,
      headHash: envelope.recordHash, records, version: 1 };
    const next = { ...payload, checksum: hashObject(payload, "PRODUCTION_HEAD_STORE_V1") };
    assertLock(lock); writeCopy(root, BACKUP, next, _beforeCopyRename);
    if (typeof _afterFirstCopy === "function") _afterFirstCopy();
    assertLock(lock); writeCopy(root, PRIMARY, next, _beforeCopyRename);
    return { ...next, copiesSynchronized: true, copiesValid: 2 };
  } finally {
    if (lock !== undefined) releaseLock(root, lock);
    closeSync(root.descriptor);
  }
}

export function exportProductionHeadAnchor(pathValue) {
  const store = loadProductionHeadStore(pathValue); const record = store.records.at(-1)?.record;
  if (!record) throw new Error("production head store is empty");
  const payload = { count: store.count, format: ANCHOR_FORMAT, genesisHash: record.genesisHash,
    headHash: store.headHash, kind: record.kind, networkId: record.networkId,
    packageHash: record.packageHash, releaseVersion: record.releaseVersion, version: 1 };
  return { ...payload, checksum: hashObject(payload, "PRODUCTION_HEAD_ANCHOR_V1") };
}

export function repairProductionHeadCopies(pathValue, { externalAnchor, _beforeCopyRename } = {}) {
  const root = openRoot(pathValue); let lock;
  try {
    lock = acquireLock(root); const loaded = loadCopies(root);
    requireAnchorPrefix(loaded.store, externalAnchor);
    assertLock(lock); writeCopy(root, BACKUP, loaded.store, _beforeCopyRename);
    assertLock(lock); writeCopy(root, PRIMARY, loaded.store, _beforeCopyRename);
    return { ...loaded.store, copiesSynchronized: true, copiesValid: 2 };
  } finally {
    if (lock !== undefined) releaseLock(root, lock);
    closeSync(root.descriptor);
  }
}

export function verifyProductionStartupFromHead(pathValue, installationTarget, {
  externalAnchor, signedRelease, trustedAddress,
} = {}) {
  const store = loadProductionHeadStore(pathValue, { externalAnchor });
  const head = store.records.at(-1)?.record;
  if (!head) throw new Error("production startup head is empty");
  const verified = verifyProductionInstallation(installationTarget, {
    expectedPackageHash: head.packageHash, kind: head.kind, signedRelease, trustedAddress,
  });
  return { anchorHead: store.headHash, copiesSynchronized: store.copiesSynchronized,
    copiesValid: store.copiesValid,
    count: store.count, ...verified };
}

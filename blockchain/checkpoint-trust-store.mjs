import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { parseConsensusJson } from "./consensus-json.mjs";
import { canonicalJson, hashObject } from "./crypto.mjs";
import { verifyCheckpointTrustPackage } from "./checkpoint-trust-package.mjs";

const FORMAT = "nir-checkpoint-trust-store-v1";
const RECORD_FORMAT = "nir-checkpoint-trust-record-v1";
const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/;
const MAX_STORE_BYTES = 64 * 1024;
const MAX_LOCK_BYTES = 1024;
const LOCK_FORMAT = "nir-checkpoint-trust-store-lock-v1";
const TOKEN = /^[0-9a-f]{64}$/;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function recordPayload(value) {
  exact(value, ["chainIdentityGenesisHash", "format", "height", "networkId", "packageHash",
    "policyId", "previousRecordHash", "revision", "sequence", "version"],
  "checkpoint trust record");
  if (value.format !== RECORD_FORMAT || value.version !== 1 ||
      !NETWORK.test(value.networkId ?? "") || !HASH.test(value.chainIdentityGenesisHash ?? "") ||
      !TAGGED_HASH.test(value.policyId ?? "") || !TAGGED_HASH.test(value.packageHash ?? "") ||
      (value.previousRecordHash !== null && !TAGGED_HASH.test(value.previousRecordHash ?? "")) ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      !Number.isSafeInteger(value.height) || value.height < 1) {
    throw new Error("checkpoint trust record is invalid");
  }
  if ((value.revision === 0) !== (value.previousRecordHash === null)) {
    throw new Error("checkpoint trust record chain is invalid");
  }
  return structuredClone(value);
}

function sealRecord(payload) {
  const normalized = recordPayload(payload);
  return { ...normalized, recordHash:
    `sha3-256:${hashObject(normalized, "CHECKPOINT_TRUST_STORE_RECORD_V1")}` };
}

function validateRecord(value) {
  exact(value, ["chainIdentityGenesisHash", "format", "height", "networkId", "packageHash",
    "policyId", "previousRecordHash", "recordHash", "revision", "sequence", "version"],
  "checkpoint trust record envelope");
  const { recordHash, ...payload } = value;
  const normalized = recordPayload(payload);
  if (recordHash !== `sha3-256:${hashObject(normalized, "CHECKPOINT_TRUST_STORE_RECORD_V1")}`) {
    throw new Error("checkpoint trust record hash is invalid");
  }
  return { ...normalized, recordHash };
}

function storeFor(record) {
  return { format: FORMAT, record, version: 1 };
}

function validateStore(value) {
  exact(value, ["format", "record", "version"], "checkpoint trust store");
  if (value.format !== FORMAT || value.version !== 1) {
    throw new Error("checkpoint trust store is invalid");
  }
  return storeFor(validateRecord(value.record));
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function ownedAndPrivate(metadata) {
  return (typeof process.getuid !== "function" || metadata.uid === process.getuid()) &&
    (metadata.mode & 0o077) === 0;
}

function canonicalTarget(path, { createDirectory = false } = {}) {
  if (typeof path !== "string" || path.length < 1 || path.length > 4096 || path.includes("\0")) {
    throw new Error("checkpoint trust store path is invalid");
  }
  const requested = resolve(path);
  if (createDirectory) mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  return join(realpathSync(dirname(requested)), basename(requested));
}

const pinnedRoots = new Map();
const observedHeads = new Map();

function pinnedRoot(path) {
  const directory = dirname(path);
  let root = pinnedRoots.get(directory);
  if (!root) {
    if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
      throw new Error("checkpoint trust store requires secure directory opens");
    }
    const canonical = realpathSync(directory);
    if (canonical !== directory) throw new Error("checkpoint trust store root must be canonical");
    const descriptor = openSync(directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = fstatSync(descriptor);
    const linked = lstatSync(directory);
    if (!identity.isDirectory() || linked.isSymbolicLink() || !linked.isDirectory() ||
        !sameIdentity(identity, linked) || !ownedAndPrivate(identity) ||
        !ownedAndPrivate(linked)) {
      closeSync(descriptor);
      throw new Error("checkpoint trust store root is unsafe");
    }
    root = { descriptor, identity, poisoned: false };
    pinnedRoots.set(directory, root);
  }
  return {
    assert(stage) {
      if (root.poisoned) throw new Error("checkpoint trust store root was replaced");
      try {
        const opened = fstatSync(root.descriptor);
        const linked = lstatSync(directory);
        if (!opened.isDirectory() || linked.isSymbolicLink() || !linked.isDirectory() ||
            !sameIdentity(opened, root.identity) || !sameIdentity(linked, root.identity) ||
            !ownedAndPrivate(opened) || !ownedAndPrivate(linked) ||
            realpathSync(directory) !== directory) {
          throw new Error(`checkpoint trust store root changed ${stage}`);
        }
      } catch (error) {
        root.poisoned = true;
        if (error?.message?.startsWith("checkpoint trust store root changed")) throw error;
        throw new Error(`checkpoint trust store root changed ${stage}`, { cause: error });
      }
    },
    descriptor: root.descriptor,
    get poisoned() { return root.poisoned; },
  };
}

function copyPaths(path) { return [`${path}.primary`, `${path}.secondary`]; }

function readCopy(path, root) {
  root.assert("before copy read");
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      !ownedAndPrivate(metadata) ||
      metadata.size < 2 || metadata.size > MAX_STORE_BYTES) {
    throw new Error("checkpoint trust store copy is unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!sameIdentity(metadata, opened) || opened.nlink !== 1 || !ownedAndPrivate(opened)) {
      throw new Error("checkpoint trust store copy changed during open");
    }
    const bytes = readFileSync(descriptor);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("checkpoint trust store copy is not canonical UTF-8 JSON"); }
    if (!text.endsWith("\n")) throw new Error("checkpoint trust store copy is not canonical JSON");
    let parsed;
    try { parsed = parseConsensusJson(text.slice(0, -1)); }
    catch { throw new Error("checkpoint trust store copy is not valid JSON"); }
    const value = validateStore(parsed);
    if (`${canonicalJson(value)}\n` !== text) {
      throw new Error("checkpoint trust store copy is not canonical JSON");
    }
    root.assert("after copy read");
    const finalMetadata = lstatSync(path);
    if (!sameIdentity(opened, finalMetadata) || finalMetadata.nlink !== 1 ||
        !ownedAndPrivate(finalMetadata)) {
      throw new Error("checkpoint trust store copy changed during read");
    }
    return value;
  } finally { closeSync(descriptor); }
}

function reconcileCopies(first, second) {
  const left = first.record; const right = second.record;
  if (left.recordHash === right.recordHash) return first;
  const [older, newer] = left.revision < right.revision ? [left, right] : [right, left];
  if (newer.revision === older.revision + 1 && newer.previousRecordHash === older.recordHash &&
      newer.networkId === older.networkId &&
      newer.chainIdentityGenesisHash === older.chainIdentityGenesisHash &&
      newer.policyId === older.policyId) {
    return storeFor(newer);
  }
  throw new Error("checkpoint trust store copies diverged");
}

function loadAtTarget(target, root) {
  const [primary, secondary] = copyPaths(target);
  const value = reconcileCopies(readCopy(primary, root), readCopy(secondary, root));
  const observed = observedHeads.get(target);
  if (observed && (value.record.revision < observed.revision ||
      (value.record.revision === observed.revision &&
       value.record.recordHash !== observed.recordHash))) {
    throw new Error("checkpoint trust store rollback or head replacement is rejected");
  }
  observedHeads.set(target,
    { recordHash: value.record.recordHash, revision: value.record.revision });
  return value;
}

function lockOwner(pid = process.pid) {
  return { format: LOCK_FORMAT, pid, token: randomBytes(32).toString("hex"), version: 1 };
}

function validateLockOwner(value) {
  exact(value, ["format", "pid", "token", "version"], "checkpoint trust store lock owner");
  if (value.format !== LOCK_FORMAT || value.version !== 1 ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 || !TOKEN.test(value.token ?? "")) {
    throw new Error("checkpoint trust store lock owner is invalid");
  }
  return structuredClone(value);
}

function readLock(path, root) {
  root.assert("before lock read");
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      !ownedAndPrivate(metadata) || metadata.size < 2 || metadata.size > MAX_LOCK_BYTES) {
    throw new Error("checkpoint trust store lock is unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!sameIdentity(metadata, opened) || opened.nlink !== 1 || !ownedAndPrivate(opened)) {
      throw new Error("checkpoint trust store lock changed during open");
    }
    const bytes = readFileSync(descriptor);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("checkpoint trust store lock owner is not canonical UTF-8 JSON"); }
    if (!text.endsWith("\n")) throw new Error("checkpoint trust store lock owner is not canonical");
    let parsed;
    try { parsed = parseConsensusJson(text.slice(0, -1)); }
    catch { throw new Error("checkpoint trust store lock owner is not valid JSON"); }
    const owner = validateLockOwner(parsed);
    if (`${canonicalJson(owner)}\n` !== text) {
      throw new Error("checkpoint trust store lock owner is not canonical");
    }
    root.assert("after lock read");
    const linked = lstatSync(path);
    if (!sameIdentity(opened, linked) || linked.nlink !== 1 || !ownedAndPrivate(linked)) {
      throw new Error("checkpoint trust store lock changed during read");
    }
    return { identity: opened, owner };
  } finally { closeSync(descriptor); }
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function removeStaleLock(lockPath, root) {
  const first = readLock(lockPath, root);
  if (processIsAlive(first.owner.pid)) {
    throw new Error("checkpoint trust store lock is held by a live owner");
  }
  root.assert("before stale lock recheck");
  const second = readLock(lockPath, root);
  if (!sameIdentity(first.identity, second.identity) || first.owner.token !== second.owner.token ||
      first.owner.pid !== second.owner.pid || processIsAlive(second.owner.pid)) {
    throw new Error("checkpoint trust store stale lock changed or became live");
  }
  const stalePath = `${lockPath}.stale.${randomBytes(16).toString("hex")}`;
  linkSync(lockPath, stalePath);
  try {
    const source = lstatSync(lockPath);
    const moved = lstatSync(stalePath);
    if (!sameIdentity(second.identity, source) || !sameIdentity(second.identity, moved) ||
        source.nlink !== 2 || moved.nlink !== 2 || processIsAlive(second.owner.pid)) {
      throw new Error("checkpoint trust store stale lock changed before removal");
    }
    unlinkSync(lockPath);
    fsyncSync(root.descriptor);
    root.assert("after stale lock removal");
  } finally {
    try {
      const linked = lstatSync(stalePath);
      if (!sameIdentity(second.identity, linked)) {
        throw new Error("checkpoint trust store stale lock quarantine changed");
      }
      unlinkSync(stalePath);
      fsyncSync(root.descriptor);
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function acquireLock(lockPath, root, owner) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    root.assert("before lock acquire");
    let descriptor;
    try {
      descriptor = openSync(lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) throw error;
      removeStaleLock(lockPath, root);
      continue;
    }
    const identity = fstatSync(descriptor);
    try {
      if (!identity.isFile() || identity.nlink !== 1 || !ownedAndPrivate(identity) ||
          !sameIdentity(identity, lstatSync(lockPath))) {
        throw new Error("checkpoint trust store lock is unsafe");
      }
      writeFileSync(descriptor, `${canonicalJson(owner)}\n`);
      fsyncSync(descriptor);
      root.assert("after lock acquire");
      return { descriptor, identity, owner };
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }
  throw new Error("checkpoint trust store lock acquisition failed");
}

function withExclusiveLock(path, root, action) {
  const lockPath = `${path}.lock`;
  const lock = acquireLock(lockPath, root, lockOwner());
  try { return action(); }
  finally {
    closeSync(lock.descriptor);
    if (!root.poisoned) {
      root.assert("before lock release");
      const current = readLock(lockPath, root);
      if (!sameIdentity(lock.identity, current.identity) ||
          current.owner.token !== lock.owner.token || current.owner.pid !== lock.owner.pid) {
        throw new Error("checkpoint trust store lock ownership changed");
      }
      unlinkSync(lockPath);
      fsyncSync(root.descriptor);
      root.assert("after lock release");
    }
  }
}

function writeAtomic(path, value, root, { noReplace = false } = {}) {
  const temporary = `${path}.${process.pid}.tmp`;
  let descriptor;
  let identity;
  try {
    root.assert("before temporary create");
    descriptor = openSync(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    identity = fstatSync(descriptor);
    writeFileSync(descriptor, `${canonicalJson(value)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    root.assert("before copy activation");
    if (noReplace) {
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else {
      const current = lstatSync(path);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
          !ownedAndPrivate(current)) {
        throw new Error("checkpoint trust store destination is unsafe");
      }
      renameSync(temporary, path);
    }
    const activated = lstatSync(path);
    if (!activated.isFile() || activated.isSymbolicLink() || activated.nlink !== 1 ||
        !ownedAndPrivate(activated) ||
        !sameIdentity(activated, identity)) {
      throw new Error("checkpoint trust store activation identity changed");
    }
    root.assert("after copy activation");
    fsyncSync(root.descriptor);
    root.assert("after directory sync");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!root.poisoned && identity) {
      try {
        const linked = lstatSync(temporary);
        if (linked.isSymbolicLink() || !sameIdentity(linked, identity)) {
          throw new Error("checkpoint trust store temporary identity changed");
        }
        unlinkSync(temporary);
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }
}

function verificationOptions(record, options = {}) {
  return {
    ...options,
    expectedChainIdentityGenesisHash: record.chainIdentityGenesisHash,
    expectedNetworkId: record.networkId,
    expectedPolicyId: record.policyId,
    minimumCheckpointHeight: record.height,
    minimumSequence: record.sequence,
  };
}

function recordFromVerified(verified, identity, revision, previousRecordHash) {
  return sealRecord({ chainIdentityGenesisHash: identity.chainIdentityGenesisHash,
    format: RECORD_FORMAT, height: verified.checkpoint.height, networkId: identity.networkId,
    packageHash: verified.packageHash, policyId: identity.policyId, previousRecordHash,
    revision, sequence: verified.sequence, version: 1 });
}

export function createCheckpointTrustStore(path, packageValue, {
  expectedChainIdentityGenesisHash, expectedNetworkId, expectedPolicyId,
  maxAgeMs = null, maxFutureSkewMs = 0, minimumCheckpointHeight = 1,
  minimumSequence = 0, now = null,
} = {}) {
  const verified = verifyCheckpointTrustPackage(packageValue, {
    expectedChainIdentityGenesisHash, expectedNetworkId, expectedPolicyId,
    maxAgeMs, maxFutureSkewMs, minimumCheckpointHeight, minimumSequence, now,
  });
  const target = canonicalTarget(path, { createDirectory: true });
  const root = pinnedRoot(target);
  const record = recordFromVerified(verified, {
    chainIdentityGenesisHash: expectedChainIdentityGenesisHash,
    networkId: expectedNetworkId, policyId: expectedPolicyId,
  }, 0, null);
  const value = storeFor(record);
  return withExclusiveLock(target, root, () => {
    const paths = copyPaths(target);
    writeAtomic(paths[0], value, root, { noReplace: true });
    try { writeAtomic(paths[1], value, root, { noReplace: true }); }
    catch (error) {
      const metadata = lstatSync(paths[0]);
      if (!metadata.isSymbolicLink() && metadata.isFile() && metadata.nlink === 1) unlinkSync(paths[0]);
      fsyncSync(root.descriptor);
      throw error;
    }
    observedHeads.set(target, { recordHash: record.recordHash, revision: record.revision });
    return structuredClone(value);
  });
}

export function loadCheckpointTrustStore(path, {
  expectedChainIdentityGenesisHash = null, expectedNetworkId = null, expectedPolicyId = null,
} = {}) {
  const target = canonicalTarget(path);
  const root = pinnedRoot(target);
  const value = loadAtTarget(target, root);
  const record = value.record;
  if ((expectedChainIdentityGenesisHash !== null &&
       record.chainIdentityGenesisHash !== expectedChainIdentityGenesisHash) ||
      (expectedNetworkId !== null && record.networkId !== expectedNetworkId) ||
      (expectedPolicyId !== null && record.policyId !== expectedPolicyId)) {
    throw new Error("checkpoint trust store does not match pinned identity");
  }
  return structuredClone(value);
}

export function acceptCheckpointTrustPackage(path, packageValue, options = {}) {
  const target = canonicalTarget(path);
  const root = pinnedRoot(target);
  return withExclusiveLock(target, root, () => {
    const current = loadAtTarget(target, root);
    const old = current.record;
    const verified = verifyCheckpointTrustPackage(packageValue,
      verificationOptions(old, options));
    if (verified.sequence === old.sequence) {
      if (verified.checkpoint.height === old.height && verified.packageHash === old.packageHash) {
        return structuredClone(current);
      }
      throw new Error("checkpoint trust package sequence divergence is rejected");
    }
    if (verified.sequence <= old.sequence || verified.checkpoint.height < old.height) {
      throw new Error("checkpoint trust package rollback is rejected");
    }
    const next = storeFor(recordFromVerified(verified, old, old.revision + 1, old.recordHash));
    const [primary, secondary] = copyPaths(target);
    writeAtomic(primary, next, root);
    writeAtomic(secondary, next, root);
    observedHeads.set(target,
      { recordHash: next.record.recordHash, revision: next.record.revision });
    return structuredClone(next);
  });
}

export const CHECKPOINT_TRUST_STORE_MAX_BYTES = MAX_STORE_BYTES;

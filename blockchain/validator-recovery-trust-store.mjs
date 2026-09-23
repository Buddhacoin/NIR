import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson } from "./crypto.mjs";
import { validatorRecoveryStateCommitment } from "./validator-recovery.mjs";

const FORMAT = "nir-validator-recovery-trust-store-v1";
const HASH = /^[0-9a-f]{64}$/;
const MAX_USED = 1_024;
const MAX_BYTES = 512 * 1024;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function validateCheckpoint(value, networkId) {
  exact(value, ["height", "recoveryGeneration", "recoveryStateCommitment", "stateRoot", "tipHash"],
    "validator recovery trust checkpoint");
  if (!Number.isSafeInteger(value.height) || value.height < 0 ||
      !Number.isSafeInteger(value.recoveryGeneration) || value.recoveryGeneration < 0 ||
      !HASH.test(value.recoveryStateCommitment ?? "") || !HASH.test(value.stateRoot ?? "") ||
      !HASH.test(value.tipHash ?? "") || typeof networkId !== "string" || networkId.length < 1) {
    throw new Error("validator recovery trust checkpoint is invalid");
  }
  return structuredClone(value);
}

function validateStore(value, networkId) {
  exact(value, ["checkpoint", "format", "networkId", "usedEvidenceHashes", "usedPlanHashes"],
    "validator recovery trust store");
  if (value.format !== FORMAT || value.networkId !== networkId ||
      !Array.isArray(value.usedEvidenceHashes) || !Array.isArray(value.usedPlanHashes) ||
      value.usedEvidenceHashes.length > MAX_USED || value.usedPlanHashes.length > MAX_USED ||
      value.usedEvidenceHashes.some((hash) => !HASH.test(hash ?? "")) ||
      value.usedPlanHashes.some((hash) => !HASH.test(hash ?? "")) ||
      new Set(value.usedEvidenceHashes).size !== value.usedEvidenceHashes.length ||
      new Set(value.usedPlanHashes).size !== value.usedPlanHashes.length) {
    throw new Error("validator recovery trust store is invalid");
  }
  validateCheckpoint(value.checkpoint, networkId);
  return structuredClone(value);
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function canonicalTarget(path, { createDirectory = false } = {}) {
  const requested = resolve(path);
  if (createDirectory) mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  return join(realpathSync(dirname(requested)), basename(requested));
}

const pinnedRoots = new Map();

function pinnedRoot(path) {
  const directory = dirname(path);
  let root = pinnedRoots.get(directory);
  if (!root) {
    if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
      throw new Error("validator recovery trust store requires secure directory opens");
    }
    const canonical = realpathSync(directory);
    if (canonical !== directory) {
      throw new Error("validator recovery trust store root must be canonical");
    }
    const descriptor = openSync(directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = fstatSync(descriptor);
    const linked = lstatSync(directory);
    if (!identity.isDirectory() || linked.isSymbolicLink() || !linked.isDirectory() ||
        !sameIdentity(identity, linked)) {
      closeSync(descriptor);
      throw new Error("validator recovery trust store root is unsafe");
    }
    root = { descriptor, identity, poisoned: false };
    pinnedRoots.set(directory, root);
  }
  return {
    assert(stage) {
      if (root.poisoned) throw new Error("validator recovery trust store root was replaced");
      try {
        const opened = fstatSync(root.descriptor);
        const linked = lstatSync(directory);
        if (!opened.isDirectory() || linked.isSymbolicLink() || !linked.isDirectory() ||
            !sameIdentity(opened, root.identity) || !sameIdentity(linked, root.identity) ||
            realpathSync(directory) !== directory) {
          throw new Error(`validator recovery trust store root changed ${stage}`);
        }
      } catch (error) {
        root.poisoned = true;
        if (error?.message?.startsWith("validator recovery trust store root changed")) throw error;
        throw new Error(`validator recovery trust store root changed ${stage}`, { cause: error });
      }
    },
    descriptor: root.descriptor,
    get poisoned() { return root.poisoned; },
  };
}

function withExclusiveLock(path, root, action) {
  const lockPath = `${path}.lock`;
  root.assert("before lock acquire");
  const descriptor = openSync(lockPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${process.pid}\n`);
    fsyncSync(descriptor);
    root.assert("after lock acquire");
    return action();
  } finally {
    closeSync(descriptor);
    if (!root.poisoned) {
      root.assert("before lock release");
      unlinkSync(lockPath);
      root.assert("after lock release");
    }
  }
}

function writeAtomic(path, value, root, { noReplace = false } = {}) {
  const temporary = `${path}.${process.pid}.tmp`;
  let descriptor;
  let temporaryIdentity;
  try {
    root.assert("before temporary create");
    descriptor = openSync(temporary, "wx", 0o600);
    temporaryIdentity = fstatSync(descriptor);
    writeFileSync(descriptor, `${canonicalJson(value)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    root.assert("before store activation");
    if (noReplace) {
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else {
      renameSync(temporary, path);
    }
    root.assert("after store activation");
    fsyncSync(root.descriptor);
    root.assert("after store directory sync");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!root.poisoned && temporaryIdentity) {
      root.assert("before temporary cleanup");
      try {
        const linked = lstatSync(temporary);
        if (linked.isSymbolicLink() || !sameIdentity(linked, temporaryIdentity)) {
          throw new Error("validator recovery trust temporary identity changed");
        }
        unlinkSync(temporary);
        root.assert("after temporary cleanup");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

export function createValidatorRecoveryTrustStore(path, { checkpoint, networkId }) {
  const target = canonicalTarget(path, { createDirectory: true });
  const value = validateStore({ checkpoint: validateCheckpoint(checkpoint, networkId),
    format: FORMAT, networkId, usedEvidenceHashes: [], usedPlanHashes: [] }, networkId);
  const root = pinnedRoot(target);
  withExclusiveLock(target, root, () => writeAtomic(target, value, root, { noReplace: true }));
  return value;
}

export function loadValidatorRecoveryTrustStore(path, { networkId }) {
  const target = canonicalTarget(path);
  const root = pinnedRoot(target);
  root.assert("before store read");
  const metadata = lstatSync(target);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      metadata.size > MAX_BYTES) throw new Error("validator recovery trust store is unsafe");
  const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!sameIdentity(metadata, opened)) {
      throw new Error("validator recovery trust store changed during open");
    }
    const value = validateStore(JSON.parse(readFileSync(descriptor, "utf8")), networkId);
    root.assert("after store read");
    if (!sameIdentity(opened, lstatSync(target))) {
      throw new Error("validator recovery trust store changed during read");
    }
    return value;
  } finally { closeSync(descriptor); }
}

export function advanceValidatorRecoveryTrustStore(path, currentValue, {
  checkpoint, transition = null,
} = {}) {
  const target = canonicalTarget(path);
  const root = pinnedRoot(target);
  root.assert("before advance");
  const current = validateStore(currentValue, currentValue?.networkId);
  const nextCheckpoint = validateCheckpoint(checkpoint, current.networkId);
  const old = current.checkpoint;
  if (nextCheckpoint.height < old.height ||
      nextCheckpoint.recoveryGeneration < old.recoveryGeneration) {
    throw new Error("validator recovery trust checkpoint rollback is rejected");
  }
  if (nextCheckpoint.height === old.height) {
    if (canonicalJson(nextCheckpoint) !== canonicalJson(old)) {
      throw new Error("validator recovery trust checkpoint fork is rejected");
    }
    if (transition !== null) throw new Error("validator recovery transition was already applied");
    return current;
  }
  const usedEvidenceHashes = [...current.usedEvidenceHashes];
  const usedPlanHashes = [...current.usedPlanHashes];
  if (nextCheckpoint.recoveryGeneration === old.recoveryGeneration) {
    if (transition !== null) throw new Error("validator recovery transition generation did not advance");
  } else {
    exact(transition, ["recoveryGeneration", "usedEvidenceHash", "usedPlanHash"],
      "validator recovery trust transition");
    if (nextCheckpoint.recoveryGeneration !== old.recoveryGeneration + 1 ||
        transition.recoveryGeneration !== nextCheckpoint.recoveryGeneration ||
        nextCheckpoint.recoveryStateCommitment !== validatorRecoveryStateCommitment({
          activePlanHash: null, generation: nextCheckpoint.recoveryGeneration,
          networkId: current.networkId,
        }) ||
        !HASH.test(transition.usedEvidenceHash ?? "") || !HASH.test(transition.usedPlanHash ?? "") ||
        usedEvidenceHashes.includes(transition.usedEvidenceHash) ||
        usedPlanHashes.includes(transition.usedPlanHash)) {
      throw new Error("validator recovery trust transition is invalid or replayed");
    }
    if (usedEvidenceHashes.length >= MAX_USED || usedPlanHashes.length >= MAX_USED) {
      throw new Error("validator recovery trust replay state is full");
    }
    usedEvidenceHashes.push(transition.usedEvidenceHash);
    usedPlanHashes.push(transition.usedPlanHash);
  }
  const next = validateStore({ ...current, checkpoint: nextCheckpoint,
    usedEvidenceHashes, usedPlanHashes }, current.networkId);
  return withExclusiveLock(target, root, () => {
    const persisted = loadValidatorRecoveryTrustStore(target, { networkId: current.networkId });
    if (canonicalJson(persisted) !== canonicalJson(current)) {
      throw new Error("validator recovery trust store compare-and-swap failed");
    }
    root.assert("after compare-and-swap read");
    writeAtomic(target, next, root);
    return next;
  });
}

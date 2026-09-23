import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

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

function withExclusiveLock(path, action) {
  const lockPath = `${path}.lock`;
  const descriptor = openSync(lockPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${process.pid}\n`);
    fsyncSync(descriptor);
    return action();
  } finally {
    closeSync(descriptor);
    unlinkSync(lockPath);
  }
}

function writeAtomic(path, value, { noReplace = false } = {}) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${canonicalJson(value)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (noReplace) {
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else {
      renameSync(temporary, path);
    }
    const directoryDescriptor = openSync(directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function createValidatorRecoveryTrustStore(path, { checkpoint, networkId }) {
  const target = resolve(path);
  const value = validateStore({ checkpoint: validateCheckpoint(checkpoint, networkId),
    format: FORMAT, networkId, usedEvidenceHashes: [], usedPlanHashes: [] }, networkId);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  withExclusiveLock(target, () => writeAtomic(target, value, { noReplace: true }));
  return value;
}

export function loadValidatorRecoveryTrustStore(path, { networkId }) {
  const target = resolve(path);
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
    if (!sameIdentity(opened, lstatSync(target))) {
      throw new Error("validator recovery trust store changed during read");
    }
    return value;
  } finally { closeSync(descriptor); }
}

export function advanceValidatorRecoveryTrustStore(path, currentValue, {
  checkpoint, transition = null,
} = {}) {
  const target = resolve(path);
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
  return withExclusiveLock(target, () => {
    const persisted = loadValidatorRecoveryTrustStore(target, { networkId: current.networkId });
    if (canonicalJson(persisted) !== canonicalJson(current)) {
      throw new Error("validator recovery trust store compare-and-swap failed");
    }
    writeAtomic(target, next);
    return next;
  });
}

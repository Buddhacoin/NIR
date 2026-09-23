import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson, hashObject, signObject } from "./crypto.mjs";
import {
  validatorRecoveryCheckpointPayload, validatorRecoveryVotePayload,
} from "./validator-recovery.mjs";

const MAX_LOCKS = 1_024;
const MAX_STORE_BYTES = 8 * 1024 * 1024;

function emptyStore() {
  return { checkpointLocks: {}, format: "nir-validator-recovery-lock-store-v1",
    recoveryLocks: {} };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readStore(path, assertRoot) {
  assertRoot("before store read");
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    const linked = lstatSync(path);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_STORE_BYTES ||
        linked.isSymbolicLink() || !sameIdentity(metadata, linked)) {
      throw new Error("validator recovery lock store is unsafe or oversized");
    }
    const value = JSON.parse(readFileSync(descriptor, "utf8"));
    assertRoot("after store read");
    if (!sameIdentity(metadata, lstatSync(path))) {
      throw new Error("validator recovery lock store identity changed during read");
    }
    const validLocks = (locks) => locks && Object.getPrototypeOf(locks) === Object.prototype &&
      Object.keys(locks).length <= MAX_LOCKS && Object.entries(locks).every(([generation, digest]) =>
        /^[1-9][0-9]*$/.test(generation) && Number.isSafeInteger(Number(generation)) &&
        /^[0-9a-f]{64}$/.test(digest));
    if (!value || value.format !== "nir-validator-recovery-lock-store-v1" ||
        Object.keys(value).sort().join("\0") !== "checkpointLocks\0format\0recoveryLocks" ||
        !validLocks(value.checkpointLocks) || !validLocks(value.recoveryLocks)) {
      throw new Error("validator recovery lock store is invalid");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") {
      assertRoot("after missing store read");
      return emptyStore();
    }
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function persist(path, value, directoryDescriptor, assertRoot) {
  assertRoot("before store persist");
  const temporary = `${path}.tmp-${process.pid}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${canonicalJson(value)}\n`);
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o600);
  } finally { closeSync(descriptor); }
  assertRoot("before store activation");
  renameSync(temporary, path);
  assertRoot("after store activation");
  fsyncSync(directoryDescriptor);
  assertRoot("after store directory sync");
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function acquireSignerLock(path, assertRoot) {
  const owner = String(process.pid);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertRoot("before signer lock acquire");
    try {
      symlinkSync(owner, path);
      assertRoot("after signer lock acquire");
      return owner;
    }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      assertRoot("before signer lock inspection");
      const existing = readlinkSync(path);
      if (!/^[1-9][0-9]*$/.test(existing) || processIsAlive(Number(existing))) {
        throw new Error("validator recovery signer is already locked");
      }
      assertRoot("before stale signer lock removal");
      unlinkSync(path);
      assertRoot("after stale signer lock removal");
    }
  }
  throw new Error("validator recovery signer lock could not be acquired");
}

function releaseSignerLock(path, owner, assertRoot) {
  assertRoot("before signer lock release");
  if (readlinkSync(path) !== owner) throw new Error("validator recovery signer lock owner changed");
  unlinkSync(path);
  assertRoot("after signer lock release");
}

export class ValidatorRecoveryLockStore {
  #directory;
  #directoryDescriptor;
  #directoryIdentity;
  #path;
  #poisoned = false;
  #store;
  #wallet;

  constructor(path, wallet) {
    const requested = resolve(path);
    const requestedDirectory = dirname(requested);
    mkdirSync(requestedDirectory, { recursive: true, mode: 0o700 });
    this.#directory = realpathSync(requestedDirectory);
    this.#path = join(this.#directory, basename(requested));
    if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
      throw new Error("validator recovery lock store requires secure directory opens");
    }
    this.#directoryDescriptor = openSync(this.#directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    this.#directoryIdentity = fstatSync(this.#directoryDescriptor);
    if (!this.#directoryIdentity.isDirectory() ||
        !sameIdentity(this.#directoryIdentity, lstatSync(this.#directory))) {
      closeSync(this.#directoryDescriptor);
      throw new Error("validator recovery lock store root is unsafe");
    }
    this.#wallet = wallet;
    this.#store = readStore(this.#path, (stage) => this.#assertRoot(stage));
  }

  #assertRoot(stage) {
    if (this.#poisoned) throw new Error("validator recovery lock store root was replaced");
    try {
      const descriptor = fstatSync(this.#directoryDescriptor);
      const linked = lstatSync(this.#directory);
      if (!descriptor.isDirectory() || linked.isSymbolicLink() || !linked.isDirectory() ||
          !sameIdentity(descriptor, this.#directoryIdentity) ||
          !sameIdentity(linked, this.#directoryIdentity) ||
          realpathSync(this.#directory) !== this.#directory) {
        throw new Error(`validator recovery lock store root changed ${stage}`);
      }
    } catch (error) {
      this.#poisoned = true;
      if (error?.message?.startsWith("validator recovery lock store root changed")) throw error;
      throw new Error(`validator recovery lock store root changed ${stage}`, { cause: error });
    }
  }

  #lock(kind, context) {
    if (!Number.isSafeInteger(context?.generation) || context.generation < 1) {
      throw new Error("validator recovery lock generation is invalid");
    }
    const lockPath = `${this.#path}.signer-lock`;
    this.#assertRoot("before signing");
    const owner = acquireSignerLock(lockPath, (stage) => this.#assertRoot(stage));
    try {
      const current = readStore(this.#path, (stage) => this.#assertRoot(stage));
      const locks = kind === "checkpoint" ? current.checkpointLocks : current.recoveryLocks;
      const key = String(context.generation);
      const digest = hashObject(context, kind === "checkpoint" ?
        "VALIDATOR_RECOVERY_CHECKPOINT_LOCK_V1" : "VALIDATOR_RECOVERY_BLOCK_LOCK_V1");
      if (locks[key] && locks[key] !== digest) {
        throw new Error(`validator recovery ${kind} lock conflicts with a persisted vote`);
      }
      if (!locks[key]) {
        if (Object.keys(locks).length >= MAX_LOCKS) throw new Error("validator recovery lock store is full");
        locks[key] = digest;
        persist(this.#path, current, this.#directoryDescriptor,
          (stage) => this.#assertRoot(stage));
      }
      this.#assertRoot("before vote authorization");
      this.#store = current;
    } finally {
      if (!this.#poisoned) {
        releaseSignerLock(lockPath, owner, (stage) => this.#assertRoot(stage));
      }
    }
  }

  checkpointVote(context, phase) {
    if (phase !== "prepare" && phase !== "commit") throw new Error("recovery vote phase is invalid");
    this.#lock("checkpoint", context);
    return { phase, reserve: this.#wallet.address,
      signature: signObject(validatorRecoveryCheckpointPayload(context), this.#wallet,
        phase === "prepare" ? "VALIDATOR_RECOVERY_CHECKPOINT_PREPARE_V1" :
          "VALIDATOR_RECOVERY_CHECKPOINT_COMMIT_V1") };
  }

  recoveryVote(context, phase) {
    if (phase !== "prepare" && phase !== "commit") throw new Error("recovery vote phase is invalid");
    this.#lock("recovery", context);
    return { phase, reserve: this.#wallet.address,
      signature: signObject(validatorRecoveryVotePayload(context), this.#wallet,
        phase === "prepare" ? "VALIDATOR_RECOVERY_BLOCK_PREPARE_V1" :
          "VALIDATOR_RECOVERY_BLOCK_COMMIT_V1") };
  }

  snapshot() { return structuredClone(this.#store); }
}

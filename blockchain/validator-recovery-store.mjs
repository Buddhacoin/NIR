import {
  chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

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

function readStore(path) {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_STORE_BYTES) {
      throw new Error("validator recovery lock store is unsafe or oversized");
    }
    const value = JSON.parse(readFileSync(path, "utf8"));
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
    if (error?.code === "ENOENT") return emptyStore();
    throw error;
  }
}

function persist(path, value) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${canonicalJson(value)}\n`);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  const directoryDescriptor = openSync(directory, "r");
  try { fsyncSync(directoryDescriptor); }
  finally { closeSync(directoryDescriptor); }
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function acquireSignerLock(path) {
  const owner = String(process.pid);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { symlinkSync(owner, path); return owner; }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readlinkSync(path);
      if (!/^[1-9][0-9]*$/.test(existing) || processIsAlive(Number(existing))) {
        throw new Error("validator recovery signer is already locked");
      }
      unlinkSync(path);
    }
  }
  throw new Error("validator recovery signer lock could not be acquired");
}

function releaseSignerLock(path, owner) {
  if (readlinkSync(path) !== owner) throw new Error("validator recovery signer lock owner changed");
  unlinkSync(path);
}

export class ValidatorRecoveryLockStore {
  #path;
  #store;
  #wallet;

  constructor(path, wallet) {
    this.#path = resolve(path);
    this.#wallet = wallet;
    this.#store = readStore(this.#path);
  }

  #lock(kind, context) {
    if (!Number.isSafeInteger(context?.generation) || context.generation < 1) {
      throw new Error("validator recovery lock generation is invalid");
    }
    const lockPath = `${this.#path}.signer-lock`;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const owner = acquireSignerLock(lockPath);
    try {
      const current = readStore(this.#path);
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
        persist(this.#path, current);
      }
      this.#store = current;
    } finally { releaseSignerLock(lockPath, owner); }
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

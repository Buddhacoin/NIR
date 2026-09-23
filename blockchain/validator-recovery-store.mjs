import {
  chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { canonicalJson, hashObject } from "./crypto.mjs";
import {
  createValidatorRecoveryCheckpointVote, createValidatorRecoveryVote,
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
    if (!value || value.format !== "nir-validator-recovery-lock-store-v1" ||
        Object.keys(value).sort().join("\0") !== "checkpointLocks\0format\0recoveryLocks" ||
        Object.keys(value.checkpointLocks ?? {}).length > MAX_LOCKS ||
        Object.keys(value.recoveryLocks ?? {}).length > MAX_LOCKS) {
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
    const locks = kind === "checkpoint" ? this.#store.checkpointLocks : this.#store.recoveryLocks;
    const key = `${context.generation}:${context.height}`;
    const digest = hashObject(context, kind === "checkpoint" ?
      "VALIDATOR_RECOVERY_CHECKPOINT_LOCK_V1" : "VALIDATOR_RECOVERY_BLOCK_LOCK_V1");
    if (locks[key] && locks[key] !== digest) {
      throw new Error(`validator recovery ${kind} lock conflicts with a persisted vote`);
    }
    if (!locks[key]) {
      if (Object.keys(locks).length >= MAX_LOCKS) throw new Error("validator recovery lock store is full");
      locks[key] = digest;
      persist(this.#path, this.#store);
    }
  }

  checkpointVote(context, phase) {
    if (phase !== "prepare" && phase !== "commit") throw new Error("recovery vote phase is invalid");
    this.#lock("checkpoint", context);
    return createValidatorRecoveryCheckpointVote(context, this.#wallet, phase);
  }

  recoveryVote(context, phase) {
    if (phase !== "prepare" && phase !== "commit") throw new Error("recovery vote phase is invalid");
    this.#lock("recovery", context);
    return createValidatorRecoveryVote(context, this.#wallet, phase);
  }

  snapshot() { return structuredClone(this.#store); }
}

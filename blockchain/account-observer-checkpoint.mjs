import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync,
  rmSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { SUPPORTED_PROTOCOL_VERSIONS } from "./constants.mjs";
import { normalizePendingProtocolUpgrade } from "./protocol-upgrade.mjs";

const FORMAT = "nir-account-observer-checkpoint-v1";
const HASH = /^[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const MAX_BYTES = 16 * 1024;

export function acquireAccountObserverSession(path) {
  const lockPath = `${resolve(path)}.session.lock`;
  // One observer process owns the checkpoint for its entire lifetime. An
  // orphaned lock after a crash is fail-closed until an operator investigates.
  const descriptor = openSync(lockPath, "wx", 0o600);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(descriptor);
    rmSync(lockPath);
  };
}

function validate(value, { address, genesisHash, networkId }) {
  if (!ADDRESS.test(address ?? "") || !HASH.test(genesisHash ?? "") ||
      typeof networkId !== "string" || networkId.length < 3 || networkId.length > 128 ||
      !value || Object.keys(value).sort().join(",") !==
        "address,format,genesisHash,lastTimestamp,networkId,tip" ||
      value.format !== FORMAT || value.address !== address ||
      value.genesisHash !== genesisHash || value.networkId !== networkId ||
      !Number.isSafeInteger(value.lastTimestamp) || value.lastTimestamp < 0) {
    throw new Error("observer checkpoint identity or envelope is invalid");
  }
  const tip = value.tip;
  if (!tip || tip.networkId !== networkId || !Number.isSafeInteger(tip.height) ||
      tip.height < 1 || !HASH.test(tip.tipHash ?? "") ||
      !HASH.test(tip.stateRoot ?? "") || !HASH.test(tip.accountStateRoot ?? "") ||
      !HASH.test(tip.validatorSetId ?? "") ||
      !SUPPORTED_PROTOCOL_VERSIONS.includes(tip.protocolVersion) ||
      (tip.chainIdentityGenesisHash !== undefined &&
       tip.chainIdentityGenesisHash !== genesisHash)) {
    throw new Error("observer checkpoint tip is invalid");
  }
  normalizePendingProtocolUpgrade(tip.pendingProtocolUpgrade, {
    currentHeight: tip.height, currentVersion: tip.protocolVersion,
  });
  return structuredClone(value);
}

export function loadAccountObserverCheckpoint(path, binding) {
  const target = resolve(path);
  let metadata;
  try { metadata = lstatSync(target); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_BYTES ||
      metadata.mode & 0o077) {
    throw new Error("observer checkpoint file is unsafe");
  }
  try { return validate(JSON.parse(readFileSync(target, "utf8")), binding); }
  catch (error) {
    if (error.message.includes("observer checkpoint")) throw error;
    throw new Error("observer checkpoint file is invalid");
  }
}

export function saveAccountObserverCheckpoint(path, binding, tip, lastTimestamp) {
  const target = resolve(path);
  const next = validate({ ...binding, format: FORMAT, lastTimestamp, tip }, binding);
  const contents = `${JSON.stringify(next)}\n`;
  if (Buffer.byteLength(contents) > MAX_BYTES) {
    throw new Error("observer checkpoint file is too large");
  }
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const lockPath = `${target}.lock`;
  let lock;
  let descriptor;
  try {
    // An exclusive sibling lock covers re-read, comparison and atomic rename.
    // An orphaned lock is deliberately not reclaimed automatically: after a
    // crash, operator intervention is safer than racing another live process.
    lock = openSync(lockPath, "wx", 0o600);
    const previous = loadAccountObserverCheckpoint(target, binding);
    if (previous && (tip.height < previous.tip.height ||
        tip.height === previous.tip.height && tip.tipHash !== previous.tip.tipHash ||
        lastTimestamp < previous.lastTimestamp)) {
      throw new Error("observer checkpoint would roll back or conflict");
    }
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    const directory = openSync(dirname(target), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    if (lock !== undefined) {
      closeSync(lock);
      rmSync(lockPath);
    }
  }
  return next;
}

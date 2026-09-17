import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { validateFinalityHeader } from "./light-client.mjs";

const FORMAT = "nir-wallet-finality-headers-v1";
const HASH = /^[0-9a-f]{64}$/;
export const MAX_WALLET_HEADER_STORE_BYTES = 256 * 1024 * 1024;

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeAtomic(target, contents) {
  const temporary = `${target}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    syncDirectory(dirname(target));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function validateAnchor(checkpoint, networkId, label) {
  if (!checkpoint || checkpoint.networkId !== undefined && checkpoint.networkId !== networkId ||
      !Number.isSafeInteger(checkpoint.height) || checkpoint.height < 0 ||
      !HASH.test(checkpoint.tipHash ?? "") || !HASH.test(checkpoint.stateRoot ?? "") ||
      (checkpoint.accountStateRoot !== undefined && checkpoint.accountStateRoot !== null &&
       !HASH.test(checkpoint.accountStateRoot))) {
    throw new Error(`wallet header ${label} is invalid`);
  }
}

function validateStore(store, {
  checkpoint, genesisCheckpoint, networkId, retainUncheckpointed = false,
}) {
  validateAnchor(genesisCheckpoint, networkId, "genesis anchor");
  if (genesisCheckpoint.height !== 0) throw new Error("wallet header genesis height is invalid");
  if (checkpoint) validateAnchor(checkpoint, networkId, "checkpoint");
  if (!store || store.format !== FORMAT || store.networkId !== networkId ||
      Object.keys(store).sort().join(",") !== "format,headers,networkId" ||
      !Array.isArray(store.headers)) {
    throw new Error("wallet header store is invalid");
  }
  let height = 0;
  let previousHash = genesisCheckpoint.tipHash;
  let previousTimestamp = null;
  const seen = new Set();
  for (const entry of store.headers) {
    if (!entry || Object.keys(entry).sort().join(",") !== "hash,header" ||
        seen.has(entry.hash)) throw new Error("wallet header store is invalid");
    const header = validateFinalityHeader(entry.header, entry.hash, networkId);
    if (header.height !== height + 1 || header.previousHash !== previousHash ||
        (previousTimestamp !== null && header.timestamp < previousTimestamp)) {
      throw new Error("wallet header store is discontinuous");
    }
    seen.add(entry.hash);
    height = header.height;
    previousHash = entry.hash;
    previousTimestamp = header.timestamp;
  }
  const trustedHeight = checkpoint?.height ?? genesisCheckpoint.height;
  if (checkpoint && checkpoint.height > 0) {
    const entry = store.headers[checkpoint.height - 1];
    if (!entry || entry.hash !== checkpoint.tipHash ||
        entry.header.stateRoot !== checkpoint.stateRoot ||
        (checkpoint.accountStateRoot !== null && checkpoint.accountStateRoot !== undefined &&
         entry.header.accountStateRoot !== checkpoint.accountStateRoot)) {
      throw new Error("wallet header store does not contain its trust checkpoint");
    }
  }
  // A crash can leave headers written just before the account checkpoint. They
  // were verified in the previous process, but are not durably authenticated
  // after restart. Discard that tail and request its certificates again.
  return {
    format: FORMAT,
    headers: structuredClone(store.headers.slice(
      0, retainUncheckpointed ? store.headers.length : trustedHeight,
    )),
    networkId,
  };
}

export function loadWalletHeaderStore(path, options) {
  const target = resolve(path);
  let metadata;
  try { metadata = lstatSync(target); }
  catch (error) {
    if (error.code === "ENOENT") {
      if (options.checkpoint?.height > 0) {
        throw new Error("wallet header store is missing behind its trust checkpoint");
      }
      return validateStore({ format: FORMAT, headers: [], networkId: options.networkId }, options);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || statSync(target).size > MAX_WALLET_HEADER_STORE_BYTES) {
    throw new Error("wallet header store file is unsafe");
  }
  try {
    return validateStore(JSON.parse(readFileSync(target, "utf8")), options);
  } catch (error) {
    if (error.message.includes("wallet header")) throw error;
    throw new Error("wallet header store is invalid");
  }
}

export function appendWalletHeaders(path, store, entries, options) {
  if (!Array.isArray(entries) || entries.length < 1) {
    throw new Error("wallet header append is invalid");
  }
  const next = structuredClone(store);
  for (const entry of entries) {
    const known = next.headers[entry.header?.height - 1];
    if (known) {
      if (known.hash !== entry.hash) throw new Error("wallet header append conflicts with history");
      continue;
    }
    next.headers.push({ hash: entry.hash, header: structuredClone(entry.header) });
  }
  const validated = validateStore(next, { ...options, retainUncheckpointed: true });
  const contents = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(contents) > MAX_WALLET_HEADER_STORE_BYTES) {
    throw new Error("wallet header store is too large");
  }
  writeAtomic(resolve(path), contents);
  return validated;
}

export function walletHeaderAt(store, height) {
  if (!Number.isSafeInteger(height) || height < 1) return null;
  const entry = store.headers[height - 1];
  return entry ? structuredClone(entry) : null;
}

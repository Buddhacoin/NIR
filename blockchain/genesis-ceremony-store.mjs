import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { parseConsensusJson } from "./consensus-json.mjs";
import { canonicalJson, hashObject } from "./crypto.mjs";
import { compileGenesis, verifyGenesisCeremony } from "./genesis-ceremony.mjs";

const PRIMARY = "GENESIS-CEREMONIES.json";
const BACKUP = "GENESIS-CEREMONIES.backup.json";
const LOCK = ".GENESIS-CEREMONY.writer.lock";
const FORMAT = "nir-genesis-ceremony-registry-record-v1";
const ZERO_HASH = "0".repeat(64);
const RECORD_FIELDS = [
  "envelope", "format", "genesisHash", "plan", "previousRecordHash", "recordHash", "sequence",
];
const MAX_RECORDS = 1_024;
const MAX_BYTES = 64 * 1024 * 1024;

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function recordPayload(record) {
  return {
    envelope: record.envelope,
    format: FORMAT,
    genesisHash: record.genesisHash,
    plan: record.plan,
    previousRecordHash: record.previousRecordHash,
    sequence: record.sequence,
  };
}

function serialized(records) {
  const contents = `${canonicalJson(records)}\n`;
  if (Buffer.byteLength(contents) > MAX_BYTES) {
    throw new Error("genesis ceremony registry exceeds its size limit");
  }
  return contents;
}

function verifyHistory(records) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS) {
    throw new Error("genesis ceremony registry is invalid");
  }
  const plans = [];
  let previousRecordHash = ZERO_HASH;
  const verified = records.map((record, index) => {
    exactObject(record, RECORD_FIELDS, "genesis ceremony registry record");
    if (record.format !== FORMAT || record.sequence !== index ||
        record.previousRecordHash !== previousRecordHash ||
        record.recordHash !== hashObject(recordPayload(record), "GENESIS_CEREMONY_REGISTRY_V1")) {
      throw new Error("genesis ceremony registry hash chain is invalid");
    }
    verifyGenesisCeremony(record.plan, record.envelope, { priorPlans: plans });
    const compiled = compileGenesis(record.plan, record.envelope, { priorPlans: plans });
    if (compiled.genesisHash !== record.genesisHash) {
      throw new Error("genesis ceremony registry genesis hash is invalid");
    }
    plans.push(record.plan);
    previousRecordHash = record.recordHash;
    return structuredClone(record);
  });
  return verified;
}

function securityFlags() {
  if (!Number.isInteger(constants.O_DIRECTORY) || !Number.isInteger(constants.O_NOFOLLOW)) {
    throw new Error("genesis ceremony registry requires no-follow directory support");
  }
  return constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

function openRoot(directory, { create = false, allowMissing = false } = {}) {
  const flags = securityFlags();
  const root = resolve(directory);
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  let before;
  try {
    before = lstatSync(root);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("genesis ceremony registry directory is unsafe");
  }
  const descriptor = openSync(root, flags);
  const opened = fstatSync(descriptor);
  if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
    closeSync(descriptor);
    throw new Error("genesis ceremony registry directory changed during open");
  }
  return { descriptor, metadata: opened, root };
}

function assertRootIdentity(handle) {
  const linked = lstatSync(handle.root);
  const opened = fstatSync(handle.descriptor);
  if (!linked.isDirectory() || linked.isSymbolicLink() ||
      linked.dev !== handle.metadata.dev || linked.ino !== handle.metadata.ino ||
      opened.dev !== handle.metadata.dev || opened.ino !== handle.metadata.ino) {
    throw new Error("genesis ceremony registry root changed during operation");
  }
}

function writeAtomic(handle, name, contents) {
  assertRootIdentity(handle);
  const path = join(handle.root, name);
  const temporary = `${path}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    chmodSync(temporary, 0o600);
    assertRootIdentity(handle);
    renameSync(temporary, path);
    assertRootIdentity(handle);
    fsyncSync(handle.descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      assertRootIdentity(handle);
      rmSync(temporary, { force: true });
    } catch {
      // A swapped root is never followed for cleanup. The exclusive temporary
      // remains in the original directory for operator inspection.
    }
  }
}

function readCopy(path) {
  let descriptor;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) return null;
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size) return null;
    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const length = readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (length === 0) return null;
      offset += length;
    }
    const after = fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs) return null;
    const records = verifyHistory(parseConsensusJson(contents.toString("utf8")));
    return { contents: serialized(records), records };
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function existing(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function copies(handle) {
  assertRootIdentity(handle);
  const paths = [join(handle.root, PRIMARY), join(handle.root, BACKUP)];
  const result = { candidates: paths.map(readCopy), paths, present: paths.map(existing) };
  assertRootIdentity(handle);
  return result;
}

function acquireLock(handle) {
  assertRootIdentity(handle);
  const lock = join(handle.root, LOCK);
  mkdirSync(lock, { mode: 0o700 });
  assertRootIdentity(handle);
  const identity = lstatSync(lock);
  if (!identity.isDirectory() || identity.isSymbolicLink()) {
    throw new Error("genesis ceremony registry writer lock is unsafe");
  }
  return () => {
    try {
      assertRootIdentity(handle);
      const current = lstatSync(lock);
      if (current.dev !== identity.dev || current.ino !== identity.ino ||
          !current.isDirectory() || current.isSymbolicLink() || readdirSync(lock).length !== 0) {
        throw new Error("genesis ceremony registry writer lock changed");
      }
      rmdirSync(lock);
      assertRootIdentity(handle);
      fsyncSync(handle.descriptor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}

function verifiedRegistry(handle) {
  const { candidates, present } = copies(handle);
  if (!present[0] && !present[1]) return { count: 0, head: ZERO_HASH, records: [] };
  if (!present[0] || !present[1] || !candidates[0] || !candidates[1]) {
    throw new Error("genesis ceremony registry copy is missing or invalid; explicit repair required");
  }
  if (candidates[0].contents !== candidates[1].contents) {
    throw new Error("genesis ceremony registry copies diverged or rolled back");
  }
  const records = candidates[0].records;
  return {
    count: records.length,
    head: records.at(-1)?.recordHash ?? ZERO_HASH,
    records: structuredClone(records),
  };
}

export function verifyCeremonyRegistry(directory, { _afterRootOpen } = {}) {
  const handle = openRoot(directory, { allowMissing: true });
  if (handle === null) return { count: 0, head: ZERO_HASH, records: [] };
  try {
    if (_afterRootOpen !== undefined) _afterRootOpen({ root: handle.root });
    return verifiedRegistry(handle);
  } finally { closeSync(handle.descriptor); }
}

export function appendCeremonyRegistry(directory, plan, envelope, { _afterRootOpen } = {}) {
  const handle = openRoot(directory, { create: true });
  let release = null;
  try {
    if (_afterRootOpen !== undefined) _afterRootOpen({ root: handle.root });
    release = acquireLock(handle);
    const current = verifiedRegistry(handle);
    const priorPlans = current.records.map((record) => record.plan);
    const compiled = compileGenesis(plan, envelope, { priorPlans });
    const payload = {
      envelope: structuredClone(envelope),
      format: FORMAT,
      genesisHash: compiled.genesisHash,
      plan: structuredClone(plan),
      previousRecordHash: current.head,
      sequence: current.count,
    };
    const record = {
      ...payload, recordHash: hashObject(payload, "GENESIS_CEREMONY_REGISTRY_V1"),
    };
    const records = verifyHistory([...current.records, record]);
    const contents = serialized(records);
    writeAtomic(handle, BACKUP, contents);
    writeAtomic(handle, PRIMARY, contents);
    return { count: records.length, genesisHash: record.genesisHash, head: record.recordHash };
  } finally {
    try { if (release !== null) release(); } finally { closeSync(handle.descriptor); }
  }
}

function isPrefix(shorter, longer) {
  return shorter.length < longer.length && shorter.every(
    ({ recordHash }, index) => longer[index]?.recordHash === recordHash,
  );
}

export function repairCeremonyRegistryOneCopy(directory, { _afterRootOpen } = {}) {
  const handle = openRoot(directory, { create: true });
  let release = null;
  try {
    if (_afterRootOpen !== undefined) _afterRootOpen({ root: handle.root });
    release = acquireLock(handle);
    const { candidates } = copies(handle);
    let source;
    let targetIndex;
    if (candidates[0] && candidates[1]) {
      if (candidates[0].contents === candidates[1].contents) {
        return { count: candidates[0].records.length, repaired: false };
      }
      if (isPrefix(candidates[0].records, candidates[1].records)) {
        source = candidates[1]; targetIndex = 0;
      } else if (isPrefix(candidates[1].records, candidates[0].records)) {
        source = candidates[0]; targetIndex = 1;
      } else {
        throw new Error("genesis ceremony registry copies conflict; repair is ambiguous");
      }
    } else if (candidates[0] || candidates[1]) {
      targetIndex = candidates[0] ? 1 : 0;
      source = candidates[candidates[0] ? 0 : 1];
    } else {
      throw new Error("genesis ceremony registry has no verified copy to repair from");
    }
    writeAtomic(handle, targetIndex === 0 ? PRIMARY : BACKUP, source.contents);
    const verified = verifiedRegistry(handle);
    return { count: verified.count, head: verified.head, repaired: true };
  } finally {
    try { if (release !== null) release(); } finally { closeSync(handle.descriptor); }
  }
}

export function ceremonyRegistryPaths(directory) {
  const root = resolve(directory);
  return { backup: join(root, BACKUP), primary: join(root, PRIMARY) };
}

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

import { parseConsensusJson } from "./consensus-json.mjs";
import { canonicalJson } from "./crypto.mjs";

const FORMAT = "nir-beacon-state-log-v1";
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;

function requireSecureFs() {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0 ||
      !Number.isInteger(constants.O_DIRECTORY) || constants.O_DIRECTORY === 0) {
    throw new Error("beacon state requires secure no-follow filesystem support");
  }
}

function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function openParent(path) {
  requireSecureFs();
  const before = lstatSync(path);
  const uid = process.getuid?.();
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o022) !== 0 ||
      uid !== undefined && before.uid !== uid) throw new Error("beacon state parent is unsafe");
  const descriptor = openSync(path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  if (!opened.isDirectory() || !same(before, opened)) {
    closeSync(descriptor); throw new Error("beacon state parent changed during open");
  }
  return { descriptor, metadata: opened, path };
}

function assertParent(parent) {
  const opened = fstatSync(parent.descriptor);
  const linked = lstatSync(parent.path);
  if (!opened.isDirectory() || !linked.isDirectory() || linked.isSymbolicLink() ||
      !same(opened, parent.metadata) || !same(linked, parent.metadata) ||
      opened.uid !== parent.metadata.uid || opened.mode !== parent.metadata.mode) {
    throw new Error("beacon state parent changed");
  }
}

function secureReadJson(path, maximumBytes) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 ||
        before.size > maximumBytes || (before.mode & 0o777) !== 0o600 ||
        uid !== undefined && before.uid !== uid) throw new Error("legacy beacon state is unsafe");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const linked = lstatSync(path);
    if (bytes.length !== before.size || !same(before, after) || !same(before, linked) ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs) throw new Error("legacy beacon state changed during read");
    return parseConsensusJson(bytes.toString("utf8"));
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
}

function readAll(descriptor, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(descriptor, bytes, offset, size - offset, offset);
    if (read === 0) throw new Error("beacon state log changed during read");
    offset += read;
  }
  return bytes;
}

function recordLine(value) {
  const line = Buffer.from(`${canonicalJson(value)}\n`);
  if (line.length > MAX_RECORD_BYTES) throw new Error("beacon state record is too large");
  return line;
}

function acquireLock(parent, path) {
  assertParent(parent);
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const identity = fstatSync(descriptor);
  try {
    fchmodSync(descriptor, 0o600);
    writeAll(descriptor, Buffer.from(`${process.pid}:${randomBytes(16).toString("hex")}\n`));
    fsyncSync(descriptor);
    fsyncSync(parent.descriptor);
    assertParent(parent);
    if (!identity.isFile() || identity.nlink !== 1 || !same(identity, lstatSync(path))) {
      throw new Error("beacon state writer lock is unsafe");
    }
  } catch (error) {
    closeSync(descriptor);
    try {
      if (identity && same(identity, lstatSync(path))) unlinkSync(path);
    } catch { /* Preserve the primary failure and never unlink an unverified replacement. */ }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return false;
    released = true;
    closeSync(descriptor);
    try {
      assertParent(parent);
      const current = lstatSync(path);
      if (!same(current, identity) || !current.isFile() || current.nlink !== 1) return false;
      unlinkSync(path);
      fsyncSync(parent.descriptor);
      return true;
    } catch {
      return false;
    }
  };
}

function header(address, networkId) {
  return { address, format: FORMAT, networkId };
}

function parseLog(bytes, address, networkId, maxEntries) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("beacon state log is truncated");
  const lines = text.slice(0, -1).split("\n");
  const first = parseConsensusJson(lines.shift() ?? "");
  if (canonicalJson(first) !== canonicalJson(header(address, networkId))) {
    throw new Error("beacon state log header does not match wallet or network");
  }
  const issued = new Map();
  for (const line of lines) {
    if (Buffer.byteLength(line) + 1 > MAX_RECORD_BYTES) throw new Error("beacon state record is too large");
    const record = parseConsensusJson(line);
    if (record === null || typeof record !== "object" || Array.isArray(record) ||
        Object.keys(record).sort().join(",") !== "key,share" ||
        typeof record.key !== "string" || record.key.length < 1 || record.key.length > 160 ||
        record.share === null || typeof record.share !== "object" || Array.isArray(record.share) ||
        issued.has(record.key)) throw new Error("beacon state record is invalid or duplicated");
    issued.set(record.key, record.share);
    if (issued.size > maxEntries) throw new Error("beacon state exceeds its entry bound");
  }
  return issued;
}

export function openBeaconStateStore({ address, maxEntries = 10_000, networkId, vaultPath }) {
  if (typeof address !== "string" || typeof networkId !== "string" || networkId.length < 1 ||
      Buffer.byteLength(networkId) > 64 || !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 || maxEntries > 1_000_000 || typeof vaultPath !== "string") {
    throw new Error("beacon state store configuration is invalid");
  }
  const resolvedVault = resolve(vaultPath);
  const parent = openParent(dirname(resolvedVault));
  const legacyPath = `${resolvedVault}.beacon-state.json`;
  const logPath = `${resolvedVault}.beacon-state.log`;
  const lockPath = `${logPath}.lock`;
  let descriptor;
  let releaseLock;
  try {
    assertParent(parent);
    releaseLock = acquireLock(parent, lockPath);
    if (existsSync(logPath)) {
      descriptor = openSync(logPath, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    } else {
      let initial = new Map();
      if (existsSync(legacyPath)) {
        const legacy = secureReadJson(legacyPath, MAX_FILE_BYTES);
        if (legacy?.address !== address || legacy.networkId !== networkId ||
            legacy.shares === null || typeof legacy.shares !== "object" ||
            Array.isArray(legacy.shares)) throw new Error("legacy beacon state does not match wallet or network");
        initial = new Map(Object.entries(legacy.shares));
        if (initial.size > maxEntries) throw new Error("legacy beacon state exceeds its entry bound");
      }
      descriptor = openSync(logPath, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      fchmodSync(descriptor, 0o600);
      writeAll(descriptor, recordLine(header(address, networkId)));
      for (const [key, share] of initial) writeAll(descriptor, recordLine({ key, share }));
      fsyncSync(descriptor);
      fsyncSync(parent.descriptor);
    }
    const opened = fstatSync(descriptor);
    const linked = lstatSync(logPath);
    const uid = process.getuid?.();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size < 2 ||
        opened.size > MAX_FILE_BYTES || (opened.mode & 0o777) !== 0o600 ||
        uid !== undefined && opened.uid !== uid || !same(opened, linked)) {
      throw new Error("beacon state log is unsafe");
    }
    const bytes = readAll(descriptor, opened.size);
    const readAfter = fstatSync(descriptor);
    if (bytes.length !== opened.size || !same(readAfter, opened) ||
        readAfter.size !== opened.size || readAfter.mtimeMs !== opened.mtimeMs ||
        readAfter.ctimeMs !== opened.ctimeMs) throw new Error("beacon state log changed during read");
    const issued = parseLog(bytes, address, networkId, maxEntries);
    const identity = { dev: opened.dev, ino: opened.ino };
    assertParent(parent);
    let closed = false;
    return {
      issued,
      append(key, share) {
        if (closed) throw new Error("beacon state store is closed");
        if (issued.has(key) || issued.size >= maxEntries) throw new Error("beacon state append is invalid");
        assertParent(parent);
        const linkedNow = lstatSync(logPath);
        const openedNow = fstatSync(descriptor);
        if (!same(linkedNow, identity) || !same(openedNow, identity) ||
            openedNow.size > MAX_FILE_BYTES) throw new Error("beacon state log changed");
        const line = recordLine({ key, share });
        if (openedNow.size + line.length > MAX_FILE_BYTES) throw new Error("beacon state log is full");
        writeAll(descriptor, line);
        fsyncSync(descriptor);
        fsyncSync(parent.descriptor);
        assertParent(parent);
        const after = fstatSync(descriptor);
        if (!same(after, identity) || after.size !== openedNow.size + line.length ||
            !same(lstatSync(logPath), identity)) throw new Error("beacon state append was not durable");
        issued.set(key, structuredClone(share));
      },
      close() {
        if (closed) return;
        closed = true;
        closeSync(descriptor);
        releaseLock();
        closeSync(parent.descriptor);
      },
      path: logPath,
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { releaseLock?.(); } catch { /* Preserve primary failure. */ }
    closeSync(parent.descriptor);
    throw error;
  }
}

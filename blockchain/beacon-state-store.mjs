import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, resolve } from "node:path";

import { parseConsensusJson } from "./consensus-json.mjs";
import { canonicalJson } from "./crypto.mjs";

const FORMAT = "nir-beacon-state-log-v1";
const CHECKPOINT_FORMAT = "nir-beacon-state-checkpoint-v1";
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_GENERATIONS = 64;
const MAX_CHAIN_BYTES = 1024 * 1024 * 1024;

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

function checkpointHeader(address, generation, highWater, networkId, previousHash) {
  return { address, format: CHECKPOINT_FORMAT, generation, highWater, networkId, previousHash };
}

function digest(bytes) { return createHash("sha3-256").update(bytes).digest("hex"); }

function generationPath(logPath, generation) {
  return generation === 0 ? logPath :
    `${logPath.slice(0, -4)}.g${String(generation).padStart(8, "0")}.log`;
}

function parseLog(bytes, address, networkId, maxEntries, maxNonces, {
  generation = 0, previousHash = null,
} = {}) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("beacon state log is truncated");
  const lines = text.slice(0, -1).split("\n");
  const first = parseConsensusJson(lines.shift() ?? "");
  const expectedHeader = generation === 0 ? header(address, networkId) :
    checkpointHeader(address, generation, first?.highWater, networkId, previousHash);
  if (generation > 0 && (!Number.isSafeInteger(first?.highWater) || first.highWater < 0) ||
      canonicalJson(first) !== canonicalJson(expectedHeader)) {
    throw new Error("beacon state log header does not match wallet or network");
  }
  const issued = new Map();
  const nonces = new Map();
  let highWater = generation === 0 ? 0 : first.highWater;
  let sealed = generation === 0;
  for (const line of lines) {
    if (Buffer.byteLength(line) + 1 > MAX_RECORD_BYTES) throw new Error("beacon state record is too large");
    const record = parseConsensusJson(line);
    if (record?.type === "checkpoint-seal") {
      if (generation === 0 || sealed ||
          Object.keys(record).sort().join(",") !== "generation,issuedShares,retainedNonces,type" ||
          record.generation !== generation || record.issuedShares !== issued.size ||
          record.retainedNonces !== nonces.size) {
        throw new Error("beacon checkpoint seal is missing or invalid");
      }
      sealed = true;
      continue;
    } else if (record?.type === "nonce") {
      const nonceFields = Object.keys(record).sort().join(",");
      if (!['expiresAt,nonceKey,type', 'expiresAt,nonceKey,type,verifiedAt'].includes(nonceFields) ||
          typeof record.nonceKey !== "string" || record.nonceKey.length > 160 ||
          !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0 ||
          (record.verifiedAt !== undefined && (!Number.isSafeInteger(record.verifiedAt) ||
            record.verifiedAt < highWater || record.expiresAt <= record.verifiedAt)) ||
          nonces.has(record.nonceKey)) throw new Error("beacon nonce record is invalid or duplicated");
      nonces.set(record.nonceKey, record.expiresAt);
      highWater = Math.max(highWater, record.verifiedAt ?? 0);
    } else {
      const combined = record?.type === "share-and-nonce";
      if (record === null || typeof record !== "object" || Array.isArray(record) ||
          Object.keys(record).sort().join(",") !==
            (combined ? "auth,key,share,type" : "key,share") ||
          typeof record.key !== "string" || record.key.length < 1 || record.key.length > 160 ||
          record.share === null || typeof record.share !== "object" || Array.isArray(record.share) ||
          issued.has(record.key)) throw new Error("beacon state record is invalid or duplicated");
      if (combined) {
        if (record.auth === null || typeof record.auth !== "object" ||
            !["expiresAt,nonceKey", "expiresAt,nonceKey,verifiedAt"].includes(
              Object.keys(record.auth).sort().join(",")) ||
            typeof record.auth.nonceKey !== "string" || record.auth.nonceKey.length > 160 ||
            !Number.isSafeInteger(record.auth.expiresAt) || record.auth.expiresAt < 0 ||
            (record.auth.verifiedAt !== undefined && (!Number.isSafeInteger(record.auth.verifiedAt) ||
              record.auth.verifiedAt < highWater || record.auth.expiresAt <= record.auth.verifiedAt)) ||
            nonces.has(record.auth.nonceKey)) throw new Error("beacon nonce record is invalid or duplicated");
        nonces.set(record.auth.nonceKey, record.auth.expiresAt);
        highWater = Math.max(highWater, record.auth.verifiedAt ?? 0);
      }
      issued.set(record.key, record.share);
      if (issued.size > maxEntries) throw new Error("beacon state exceeds its entry bound");
    }
    if (nonces.size > maxNonces) throw new Error("beacon nonce state exceeds its entry bound");
  }
  if (!sealed) {
    throw new Error("beacon checkpoint seal is missing or invalid");
  }
  return { highWater, issued, nonces };
}

function openAndReadLog(parent, path) {
  assertParent(parent);
  const descriptor = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    const linked = lstatSync(path);
    const uid = process.getuid?.();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size < 2 ||
        opened.size > MAX_FILE_BYTES || (opened.mode & 0o777) !== 0o600 ||
        uid !== undefined && opened.uid !== uid || !same(opened, linked)) {
      throw new Error("beacon state log is unsafe");
    }
    const bytes = readAll(descriptor, opened.size);
    const after = fstatSync(descriptor);
    assertParent(parent);
    if (bytes.length !== opened.size || !same(after, opened) ||
        after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs || !same(lstatSync(path), opened)) {
      throw new Error("beacon state log changed during read");
    }
    return { bytes, descriptor, identity: { dev: opened.dev, ino: opened.ino } };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function openBeaconStateStore({
  address, maxEntries = 10_000, maxNonces = 100_000, networkId, vaultPath,
}) {
  if (typeof address !== "string" || typeof networkId !== "string" || networkId.length < 1 ||
      Buffer.byteLength(networkId) > 64 || !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 || maxEntries > 1_000_000 || !Number.isSafeInteger(maxNonces) ||
      maxNonces < 1 || maxNonces > 1_000_000 || typeof vaultPath !== "string") {
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
      // Opened below after the complete immutable generation chain is verified.
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
      closeSync(descriptor);
      descriptor = undefined;
    }

    const stem = basename(logPath.slice(0, -4)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const generationPattern = new RegExp(`^${stem}\\.g([0-9]{8})\\.log$`);
    const discovered = [];
    for (const name of readdirSync(parent.path)) {
      const match = generationPattern.exec(name);
      if (match) discovered.push(Number(match[1]));
    }
    discovered.sort((a, b) => a - b);
    if (discovered.length > MAX_GENERATIONS - 1) {
      throw new Error("beacon state generation chain exceeds its bound");
    }
    for (let index = 0; index < discovered.length; index += 1) {
      if (discovered[index] !== index + 1) {
        throw new Error("beacon state generation chain is incomplete or ambiguous");
      }
    }
    const generation = discovered.at(-1) ?? 0;
    let previousHash = null;
    let parsed;
    let activePath;
    let identity;
    let chainBytes = 0;
    for (let current = 0; current <= generation; current += 1) {
      const path = generationPath(logPath, current);
      const openedLog = openAndReadLog(parent, path);
      try {
        chainBytes += openedLog.bytes.length;
        if (chainBytes > MAX_CHAIN_BYTES) throw new Error("beacon state chain exceeds its byte bound");
        parsed = parseLog(openedLog.bytes, address, networkId, maxEntries, maxNonces, {
          generation: current, previousHash,
        });
        previousHash = digest(openedLog.bytes);
        if (current === generation) {
          descriptor = openedLog.descriptor;
          activePath = path;
          identity = openedLog.identity;
        } else {
          closeSync(openedLog.descriptor);
        }
      } catch (error) {
        closeSync(openedLog.descriptor);
        throw error;
      }
    }
    const { issued, nonces } = parsed;
    let highWater = parsed.highWater;
    assertParent(parent);
    let closed = false;
    let compacted = false;
    const appendRecord = (line) => {
      assertParent(parent);
      const linkedNow = lstatSync(activePath);
      const openedNow = fstatSync(descriptor);
      if (!same(linkedNow, identity) || !same(openedNow, identity) ||
          openedNow.size + line.length > MAX_FILE_BYTES) throw new Error("beacon state log changed or full");
      writeAll(descriptor, line); fsyncSync(descriptor); fsyncSync(parent.descriptor);
      assertParent(parent);
      const after = fstatSync(descriptor);
      if (!same(after, identity) || after.size !== openedNow.size + line.length ||
          !same(lstatSync(activePath), identity)) throw new Error("beacon state append was not durable");
      chainBytes += line.length;
    };
    const planCompaction = ({ observedNow, safetyMarginMs = 300_000 } = {}) => {
      if (closed || !Number.isSafeInteger(safetyMarginMs) || safetyMarginMs < 0 ||
          safetyMarginMs > 30 * 24 * 60 * 60 * 1000 ||
          !Number.isSafeInteger(observedNow) || observedNow < highWater) {
        throw new Error("beacon compaction safety margin is invalid");
      }
      const cutoff = observedNow >= safetyMarginMs ? observedNow - safetyMarginMs : -1;
      let prunableNonces = 0;
      for (const expiresAt of nonces.values()) if (expiresAt <= cutoff) prunableNonces += 1;
      const source = fstatSync(descriptor);
      if (!same(source, identity) || source.size > MAX_FILE_BYTES ||
          !same(lstatSync(activePath), identity)) throw new Error("beacon state log changed");
      const bytes = readAll(descriptor, source.size);
      const after = fstatSync(descriptor);
      if (!same(after, source) || after.size !== source.size ||
          after.mtimeMs !== source.mtimeMs || after.ctimeMs !== source.ctimeMs) {
        throw new Error("beacon state log changed during compaction planning");
      }
      return Object.freeze({
        activeNonces: nonces.size,
        generation,
        highWater: observedNow,
        issuedShares: issued.size,
        nextGeneration: generation + 1,
        prunableNonces,
        retainedNonces: nonces.size - prunableNonces,
        safetyMarginMs,
        sourceHash: digest(bytes),
        sourcePath: activePath,
        targetPath: generationPath(logPath, generation + 1),
      });
    };
    return {
      issued,
      nonces,
      get highWater() { return highWater; },
      get generation() { return generation; },
      get fileBytes() { return fstatSync(descriptor).size; },
      get chainBytes() { return chainBytes; },
      get maxNonces() { return maxNonces; },
      append(key, share) {
        if (closed || compacted) throw new Error("beacon state store requires restart after compaction");
        if (issued.has(key) || issued.size >= maxEntries) throw new Error("beacon state append is invalid");
        const line = recordLine({ key, share });
        appendRecord(line);
        issued.set(key, structuredClone(share));
      },
      appendNonce({ expiresAt, replayKey, verifiedAt }) {
        if (closed || compacted || typeof replayKey !== "string" || replayKey.length < 1 ||
            replayKey.length > 160 || !Number.isSafeInteger(expiresAt) || expiresAt < 0 ||
            !Number.isSafeInteger(verifiedAt) || verifiedAt < highWater || expiresAt <= verifiedAt ||
            nonces.has(replayKey) || nonces.size >= maxNonces) {
          throw new Error("beacon nonce append is invalid");
        }
        const line = recordLine({ expiresAt, nonceKey: replayKey, type: "nonce", verifiedAt });
        appendRecord(line);
        nonces.set(replayKey, expiresAt); highWater = verifiedAt;
      },
      appendShareAndNonce(key, share, { expiresAt, replayKey, verifiedAt }) {
        if (closed || compacted || typeof replayKey !== "string" || replayKey.length < 1 ||
            replayKey.length > 160 || !Number.isSafeInteger(expiresAt) || expiresAt < 0 ||
            !Number.isSafeInteger(verifiedAt) || verifiedAt < highWater || expiresAt <= verifiedAt ||
            issued.has(key) || issued.size >= maxEntries || nonces.has(replayKey) ||
            nonces.size >= maxNonces) throw new Error("beacon atomic append is invalid");
        const line = recordLine({
          auth: { expiresAt, nonceKey: replayKey, verifiedAt }, key, share, type: "share-and-nonce",
        });
        appendRecord(line);
        issued.set(key, structuredClone(share)); nonces.set(replayKey, expiresAt);
        highWater = verifiedAt;
      },
      planCompaction,
      compact(options = {}) {
        if (generation + 1 >= MAX_GENERATIONS || chainBytes + MAX_FILE_BYTES > MAX_CHAIN_BYTES) {
          throw new Error("beacon state compaction generation capacity is exhausted");
        }
        let plan = planCompaction(options);
        options.onAfterPlan?.(plan);
        const confirmed = planCompaction(options);
        if (confirmed.sourceHash !== plan.sourceHash || confirmed.sourcePath !== plan.sourcePath ||
            confirmed.generation !== plan.generation || confirmed.highWater !== plan.highWater) {
          throw new Error("beacon state changed after compaction plan");
        }
        plan = confirmed;
        const assertSourceStillMatches = () => {
          const current = planCompaction(options);
          if (current.sourceHash !== plan.sourceHash || current.sourcePath !== plan.sourcePath ||
              current.generation !== plan.generation || current.highWater !== plan.highWater) {
            throw new Error("beacon state changed during compaction");
          }
        };
        assertParent(parent);
        let targetDescriptor;
        try {
          targetDescriptor = openSync(plan.targetPath, constants.O_RDWR | constants.O_APPEND |
            constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          fchmodSync(targetDescriptor, 0o600);
          const targetIdentity = fstatSync(targetDescriptor);
          if (!targetIdentity.isFile() || targetIdentity.nlink !== 1 ||
              !same(targetIdentity, lstatSync(plan.targetPath))) {
            throw new Error("beacon checkpoint target is unsafe");
          }
          assertSourceStillMatches();
          writeAll(targetDescriptor, recordLine(checkpointHeader(
            address, plan.nextGeneration, plan.highWater, networkId, plan.sourceHash,
          )));
          fsyncSync(targetDescriptor);
          options.onAfterHeader?.({ descriptor: targetDescriptor, path: plan.targetPath });
          for (const [key, share] of [...issued].sort(([a], [b]) => a.localeCompare(b))) {
            writeAll(targetDescriptor, recordLine({ key, share }));
          }
          const cutoff = plan.highWater >= plan.safetyMarginMs ?
            plan.highWater - plan.safetyMarginMs : -1;
          for (const [nonceKey, expiresAt] of [...nonces].sort(([a], [b]) => a.localeCompare(b))) {
            if (expiresAt > cutoff) writeAll(targetDescriptor,
              recordLine({ expiresAt, nonceKey, type: "nonce" }));
          }
          assertSourceStillMatches();
          writeAll(targetDescriptor, recordLine({
            generation: plan.nextGeneration,
            issuedShares: plan.issuedShares,
            retainedNonces: plan.retainedNonces,
            type: "checkpoint-seal",
          }));
          fsyncSync(targetDescriptor);
          fsyncSync(parent.descriptor);
          assertParent(parent);
          const complete = fstatSync(targetDescriptor);
          if (!same(complete, targetIdentity) || complete.size > MAX_FILE_BYTES ||
              !same(lstatSync(plan.targetPath), targetIdentity)) {
            throw new Error("beacon checkpoint activation was not durable");
          }
          const verificationBytes = readAll(targetDescriptor, complete.size);
          parseLog(verificationBytes, address, networkId, maxEntries, maxNonces, {
            generation: plan.nextGeneration, previousHash: plan.sourceHash,
          });
          assertSourceStillMatches();
          compacted = true;
          return Object.freeze({ ...plan, checkpointBytes: complete.size });
        } finally {
          if (targetDescriptor !== undefined) closeSync(targetDescriptor);
          // Deliberately preserve any created checkpoint. A partial generation makes
          // restart fail closed instead of guessing whether activation succeeded.
        }
      },
      close() {
        if (closed) return;
        closed = true;
        closeSync(descriptor);
        releaseLock();
        closeSync(parent.descriptor);
      },
      path: activePath,
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { releaseLock?.(); } catch { /* Preserve primary failure. */ }
    closeSync(parent.descriptor);
    throw error;
  }
}

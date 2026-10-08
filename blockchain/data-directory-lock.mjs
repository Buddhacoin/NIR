import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";

const FORMAT = "nir-data-directory-lock-v1";
const LOCK_DIRECTORY = ".nir-writer-lock";
const OWNER_FILE = "owner.json";
const MAX_OWNER_BYTES = 16 * 1024;

function assertOwner(owner) {
  if (owner?.format !== FORMAT || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
      owner.pid > 2_147_483_647 || typeof owner.token !== "string" ||
      !/^[0-9a-f]{64}$/.test(owner.token) || !Number.isSafeInteger(owner.startedAt) ||
      owner.startedAt < 0) throw new Error("node writer lock is invalid");
  return owner;
}

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function ownerPath(lockDirectory) { return join(lockDirectory, OWNER_FILE); }

function readOwner(lockDirectory) {
  const lockStatBefore = lstatSync(lockDirectory);
  const path = ownerPath(lockDirectory);
  let descriptor;
  let owner;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const ownerStat = fstatSync(descriptor);
    if (!ownerStat.isFile() || ownerStat.size > MAX_OWNER_BYTES) {
      throw new Error("node writer lock is invalid");
    }
    const contents = readFileSync(descriptor);
    if (contents.length > MAX_OWNER_BYTES) throw new Error("node writer lock is invalid");
    owner = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("node writer lock is incomplete; stop writers before offline repair");
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const lockStatAfter = lstatSync(lockDirectory);
  if (!lockStatBefore.isDirectory() || lockStatBefore.isSymbolicLink() ||
      !lockStatAfter.isDirectory() || lockStatAfter.isSymbolicLink() ||
      lockStatBefore.dev !== lockStatAfter.dev || lockStatBefore.ino !== lockStatAfter.ino) {
    throw new Error("node writer lock is invalid");
  }
  return assertOwner(owner);
}

function readOwnerFile(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 2 ||
      before.size > MAX_OWNER_BYTES || (before.mode & 0o022) !== 0) {
    throw new Error("node writer lock is invalid");
  }
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size) throw new Error("node writer lock changed during open");
    const contents = Buffer.allocUnsafe(opened.size + 1);
    let length = 0;
    while (length < contents.length) {
      const count = readSync(descriptor, contents, length, contents.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    const linked = lstatSync(path);
    if (length !== opened.size || length > MAX_OWNER_BYTES ||
        after.dev !== opened.dev || after.ino !== opened.ino ||
        linked.dev !== opened.dev || linked.ino !== opened.ino ||
        after.size !== opened.size || linked.size !== opened.size) {
      throw new Error("node writer lock changed during read");
    }
    return assertOwner(JSON.parse(contents.subarray(0, length).toString("utf8")));
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function readLockOwner(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error("node writer lock is invalid");
  if (metadata.isDirectory()) return readOwner(path); // Legacy lock format.
  if (metadata.isFile()) return readOwnerFile(path);
  throw new Error("node writer lock is invalid");
}

function publishOwnerFile(root, lockPath, owner) {
  const temporary = join(root, `.nir-writer-lock.${randomBytes(16).toString("hex")}.next`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    const contents = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
    for (let offset = 0; offset < contents.length;) {
      const written = writeSync(descriptor, contents, offset, contents.length - offset);
      if (written < 1) throw new Error("node writer lock owner write failed");
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    linkSync(temporary, lockPath); // No replacement: the owner is complete before publication.
    syncDirectory(root);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function restoreMovedLock(moved, lockPath) {
  try {
    const metadata = lstatSync(moved);
    if (metadata.isFile()) {
      linkSync(moved, lockPath); // Never overwrite a newer owner.
      rmSync(moved);
    } else {
      if (lstatSync(lockPath, { throwIfNoEntry: false })) return false;
      renameSync(moved, lockPath); // Legacy directory format.
    }
    return true;
  } catch { return false; }
}

function moveVerifiedLock(lockPath, expected, label) {
  const moved = `${lockPath}.${label}-${randomBytes(16).toString("hex")}`;
  renameSync(lockPath, moved);
  let actual;
  try { actual = readLockOwner(moved); }
  catch (error) {
    restoreMovedLock(moved, lockPath);
    throw error;
  }
  if (actual.token !== expected.token || actual.pid !== expected.pid) {
    restoreMovedLock(moved, lockPath);
    throw new Error("node writer lock changed during recovery");
  }
  return moved;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

export function acquireDataDirectoryLock(directory) {
  const root = resolve(directory);
  const lockPath = join(root, LOCK_DIRECTORY);
  const token = randomBytes(32).toString("hex");
  const owner = { format: FORMAT, pid: process.pid, startedAt: Date.now(), token };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("node data directory is unsafe");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      publishOwnerFile(root, lockPath, owner);
      let released = false;
      return () => {
        if (released) return false;
        let current;
        try { current = readLockOwner(lockPath); } catch { return false; }
        if (current.token !== token || current.pid !== process.pid) return false;
        let moved;
        try { moved = moveVerifiedLock(lockPath, current, "release"); }
        catch { return false; }
        rmSync(moved, { recursive: true });
        syncDirectory(root);
        released = true;
        return true;
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      // An ownerless legacy directory is ambiguous with a live writer interrupted
      // between mkdir and owner write. It must be quarantined only while offline.
      const existing = readLockOwner(lockPath);
      if (processExists(existing.pid)) {
        throw new Error(`node data directory is already open by process ${existing.pid}`);
      }
      const stale = moveVerifiedLock(lockPath, existing, "stale");
      if (processExists(existing.pid)) {
        restoreMovedLock(stale, lockPath);
        throw new Error(`node data directory became active as process ${existing.pid}`);
      }
      rmSync(stale, { recursive: true });
      syncDirectory(root);
    }
  }
  throw new Error("node writer lock could not be acquired");
}

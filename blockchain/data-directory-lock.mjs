import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";

const FORMAT = "nir-data-directory-lock-v1";
const LOCK_DIRECTORY = ".nir-writer-lock";
const OWNER_FILE = "owner.json";
const MAX_OWNER_BYTES = 16 * 1024;

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
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const lockStatAfter = lstatSync(lockDirectory);
  if (!lockStatBefore.isDirectory() || lockStatBefore.isSymbolicLink() ||
      !lockStatAfter.isDirectory() || lockStatAfter.isSymbolicLink() ||
      lockStatBefore.dev !== lockStatAfter.dev || lockStatBefore.ino !== lockStatAfter.ino) {
    throw new Error("node writer lock is invalid");
  }
  if (owner?.format !== FORMAT || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
      owner.pid > 2_147_483_647 || typeof owner.token !== "string" ||
      !/^[0-9a-f]{64}$/.test(owner.token) || !Number.isSafeInteger(owner.startedAt) ||
      owner.startedAt < 0) throw new Error("node writer lock is invalid");
  return owner;
}

function restoreMovedLock(moved, lockDirectory) {
  try { renameSync(moved, lockDirectory); return true; }
  catch { return false; }
}

function moveVerifiedLock(lockDirectory, expected, label) {
  const moved = `${lockDirectory}.${label}-${randomBytes(16).toString("hex")}`;
  renameSync(lockDirectory, moved);
  let actual;
  try { actual = readOwner(moved); }
  catch (error) {
    restoreMovedLock(moved, lockDirectory);
    throw error;
  }
  if (actual.token !== expected.token || actual.pid !== expected.pid) {
    restoreMovedLock(moved, lockDirectory);
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
  const lockDirectory = join(root, LOCK_DIRECTORY);
  const token = randomBytes(32).toString("hex");
  const owner = { format: FORMAT, pid: process.pid, startedAt: Date.now(), token };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("node data directory is unsafe");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDirectory, { mode: 0o700 });
      writeFileSync(ownerPath(lockDirectory), `${JSON.stringify(owner)}\n`, {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
      let released = false;
      return () => {
        if (released) return false;
        let current;
        try { current = readOwner(lockDirectory); } catch { return false; }
        if (current.token !== token || current.pid !== process.pid) return false;
        let moved;
        try { moved = moveVerifiedLock(lockDirectory, current, "release"); }
        catch { return false; }
        rmSync(moved, { recursive: true });
        released = true;
        return true;
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const existing = readOwner(lockDirectory);
      if (processExists(existing.pid)) {
        throw new Error(`node data directory is already open by process ${existing.pid}`);
      }
      const stale = moveVerifiedLock(lockDirectory, existing, "stale");
      if (processExists(existing.pid)) {
        restoreMovedLock(stale, lockDirectory);
        throw new Error(`node data directory became active as process ${existing.pid}`);
      }
      rmSync(stale, { recursive: true });
    }
  }
  throw new Error("node writer lock could not be acquired");
}

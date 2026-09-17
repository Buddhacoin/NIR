import {
  lstatSync,
  mkdirSync,
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
  const lockStat = lstatSync(lockDirectory);
  const path = ownerPath(lockDirectory);
  const ownerStat = lstatSync(path);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink() || !ownerStat.isFile() ||
      ownerStat.isSymbolicLink() || ownerStat.size > MAX_OWNER_BYTES) {
    throw new Error("node writer lock is invalid");
  }
  const owner = JSON.parse(readFileSync(path, "utf8"));
  if (owner?.format !== FORMAT || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
      owner.pid > 2_147_483_647 || typeof owner.token !== "string" ||
      !/^[0-9a-f]{64}$/.test(owner.token) || !Number.isSafeInteger(owner.startedAt) ||
      owner.startedAt < 0) throw new Error("node writer lock is invalid");
  return owner;
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
        rmSync(lockDirectory, { recursive: true });
        released = true;
        return true;
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        rmSync(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      const existing = readOwner(lockDirectory);
      if (processExists(existing.pid)) {
        throw new Error(`node data directory is already open by process ${existing.pid}`);
      }
      const stale = `${lockDirectory}.stale-${existing.token}`;
      renameSync(lockDirectory, stale);
      rmSync(stale, { recursive: true });
    }
  }
  throw new Error("node writer lock could not be acquired");
}

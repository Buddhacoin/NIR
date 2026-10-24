// Wallet files on Windows. Windows has no POSIX file modes and no O_NOFOLLOW,
// and symbolic links need extra privileges, so the activation links that
// wallet-files.mjs uses elsewhere are not available. There the private JSON
// files are plain files in the per-user %LOCALAPPDATA%\NIR folder, which only
// the user, SYSTEM and administrators can open:
// - a new file is written under a fresh name and hard-linked into place, so it
//   appears whole or not at all and never replaces an existing one;
// - a replacement (a new wallet password) is renamed over the old file in one
//   atomic step;
// - a file is read only if it is a regular file with a single link that stayed
//   the same file while it was read.
// The functions use only calls every system has, so they are tested anywhere.
import { closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

export const PLAIN_PRIVATE_FILES = process.platform === "win32";

// POSIX keeps wallet folders and files private by mode; Windows by the
// per-user folder's access list, which has no mode bits to check.
export function privateMode(mode) {
  return PLAIN_PRIVATE_FILES || (Number(mode) & 0o077) === 0;
}

const sameFile = (left, right) => BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino);

export function readPlainPrivateJson(path, maxBytes) {
  const target = resolve(path);
  const linked = lstatSync(target, { bigint: true });
  if (!linked.isFile() || linked.isSymbolicLink()) throw new Error("private file is not a regular file");
  const descriptor = openSync(target, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!sameFile(before, linked) || before.nlink !== 1n || before.size < 2n || before.size > BigInt(maxBytes)) {
      throw new Error("private file is unsafe");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const again = lstatSync(target, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || BigInt(bytes.length) !== before.size ||
        !sameFile(again, before) || again.isSymbolicLink()) {
      throw new Error("private file changed while it was read");
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    closeSync(descriptor);
  }
}

function writeGeneration(target, value) {
  const generation = join(dirname(target), `.${basename(target)}.nir-private-${randomBytes(16).toString("hex")}`);
  const descriptor = openSync(generation, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return generation;
}

function realTarget(path) {
  const requested = resolve(path);
  const parent = realpathSync(dirname(requested));
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("wallet destination parent must be a direct regular directory");
  }
  return join(parent, basename(requested));
}

// A new file at path; fails with EEXIST if one is already there.
export function writePlainPrivateJsonExclusive(path, value, { beforeActivate } = {}) {
  const target = realTarget(path);
  const generation = writeGeneration(target, value);
  try {
    beforeActivate?.({ generation, target });
    linkSync(generation, target);
  } finally {
    rmSync(generation, { force: true });
  }
  const placed = lstatSync(target);
  if (!placed.isFile() || placed.isSymbolicLink() || placed.nlink !== 1) {
    throw new Error("wallet private file is inconsistent after activation");
  }
  return target;
}

// Replaces the file at path in one step. check(staged) runs on the written
// copy before it takes the old file's place.
export function replacePlainPrivateJson(path, value, { check, maxBytes, beforeActivate } = {}) {
  const target = realTarget(path);
  const original = lstatSync(target, { bigint: true });
  if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1n) {
    throw new Error("wallet private file is unsafe");
  }
  const generation = writeGeneration(target, value);
  try {
    check?.(readPlainPrivateJson(generation, maxBytes));
    beforeActivate?.({ generation, target });
    const current = lstatSync(target, { bigint: true });
    if (!sameFile(current, original) || current.mtimeNs !== original.mtimeNs) {
      throw new Error("wallet private file changed before activation");
    }
    renameSync(generation, target);
  } catch (error) {
    try { unlinkSync(generation); } catch { /* Already renamed or never written. */ }
    throw error;
  }
  return target;
}

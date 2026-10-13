#!/usr/bin/env node
// Operator-driven update for a source-built local rehearsal app on this Mac.
// This is not a public or remotely fetched auto-updater.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync,
  readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const OWN_BUNDLE_ID = "org.nir.wallet-setup-test";
const MAX_FILES = 256;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 256 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

function checkedPath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path ||
      basename(path) !== "NIR Wallet.app") throw new Error("app path must be an exact absolute NIR Wallet.app path");
  let current = sep;
  for (const component of path.split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current);
    const ownComponent = current === path || current === dirname(path);
    const stickyAncestor = !ownComponent && (stat.mode & 0o1000) !== 0 && stat.uid === 0;
    if (stat.isSymbolicLink() || (ownComponent && stat.uid !== process.getuid()) ||
        ((stat.mode & 0o022) !== 0 && !stickyAncestor)) {
      throw new Error("wallet app path has an unsafe component");
    }
  }
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== process.getuid()) {
    throw new Error("wallet app parent must be owned by the current user");
  }
}

function bundleHash(path) {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const entry = join(directory, name);
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink() || stat.uid !== process.getuid() ||
          (stat.mode & 0o022) !== 0) throw new Error("wallet bundle contains an unsafe entry");
      if (stat.isDirectory()) {
        hash.update(`D\0${relative}\0${stat.mode & 0o777}\0`);
        walk(entry, relative);
      } else if (stat.isFile() && stat.nlink === 1) {
        files++;
        bytes += stat.size;
        if (files > MAX_FILES || bytes > MAX_BYTES) throw new Error("wallet bundle is too large");
        hash.update(`F\0${relative}\0${stat.mode & 0o777}\0${stat.size}\0`);
        hash.update(readFileSync(entry));
      } else throw new Error("wallet bundle contains a non-regular entry");
    }
  };
  walk(path);
  if (files < 20) throw new Error("wallet bundle is incomplete");
  return hash.digest("hex");
}

function assertRuntime(path, { allowLegacyRuntime = false } = {}) {
  const runtime = JSON.parse(readFileSync(join(path, "Contents/Resources/NIR-RUNTIME.json"), "utf8"));
  const executable = runtime?.nodeExecutable;
  if (typeof executable !== "string" || !isAbsolute(executable) ||
      resolve(executable) !== executable) {
    throw new Error("wallet Node runtime path is invalid");
  }
  let component = sep;
  for (const part of executable.split(sep).filter(Boolean)) {
    component = join(component, part);
    if (lstatSync(component).isSymbolicLink()) {
      throw new Error("wallet Node runtime path contains a symlink");
    }
  }
  const node = lstatSync(executable);
  if (!node.isFile() || node.isSymbolicLink() || (node.mode & 0o111) === 0 ||
      node.size <= 0 || node.size > MAX_RUNTIME_BYTES) {
    throw new Error("wallet Node runtime is unavailable");
  }
  if (runtime?.nodeSha256 === undefined && allowLegacyRuntime) return false;
  if (!SHA256.test(runtime?.nodeSha256 ?? "")) {
    throw new Error("wallet Node runtime has no signed byte pin");
  }
  const bytes = readFileSync(executable);
  if (createHash("sha256").update(bytes).digest("hex") !== runtime.nodeSha256) {
    throw new Error("wallet Node runtime bytes differ from the signed app pin");
  }
  return true;
}

export function inspectLocalMacWallet(path, { allowLegacyRuntime = false } = {}) {
  if (process.platform !== "darwin") throw new Error("local Mac wallet updates require macOS");
  checkedPath(path);
  const app = lstatSync(path);
  if (!app.isDirectory() || app.uid !== process.getuid()) throw new Error("wallet app is not owned by this user");
  const marker = JSON.parse(readFileSync(join(path, "Contents/Resources/NIR-LOCAL-BUILD.json"), "utf8"));
  if (marker?.distribution !== "not-a-public-installer" ||
      !(["nir-local-test-build-v1", "nir-local-test-build-v2"].includes(marker.format))) {
    throw new Error("not a NIR local rehearsal app");
  }
  const sequence = marker.format === "nir-local-test-build-v1" ? 0 : marker.sequence;
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("wallet build sequence is invalid");
  const identifier = execFileSync("/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", join(path, "Contents/Info.plist")],
    { encoding: "utf8", timeout: 5_000 }).trim();
  if (identifier !== OWN_BUNDLE_ID) throw new Error("wallet bundle identifier differs");
  const runtimeBound = assertRuntime(path, { allowLegacyRuntime });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", path],
    { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  return { hash: bundleHash(path), sequence, runtimeBound };
}

function noWalletProcess(target, candidate) {
  const running = execFileSync("/bin/ps", ["-axo", "command="],
    { encoding: "utf8", timeout: 5_000 });
  if (running.split("\n").some((line) =>
    line.includes(`${target}/Contents/`) || line.includes(`${candidate}/Contents/`))) {
    throw new Error("close every NIR Wallet instance before updating");
  }
  try {
    const listeners = execFileSync("/usr/sbin/lsof", ["-nP", "-iTCP:8788", "-sTCP:LISTEN"],
      { encoding: "utf8", timeout: 5_000 });
    if (listeners.trim()) throw new Error("wallet bridge port is in use");
  } catch (error) {
    if (error?.message === "wallet bridge port is in use") throw error;
    if (error?.status !== 1) throw error;
  }
}

function syncDirectory(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function installLocalMacWallet({ target, candidate, expectedOldHash, expectedNewHash,
  exchangeExecutable, allowLegacyTarget = false }) {
  if (!SHA256.test(expectedOldHash ?? "") || !SHA256.test(expectedNewHash ?? "") ||
      expectedOldHash === expectedNewHash) throw new Error("distinct pinned bundle hashes are required");
  checkedPath(target);
  checkedPath(candidate);
  if (target === candidate || dirname(target) === dirname(candidate) ||
      statSync(dirname(target)).dev !== statSync(dirname(candidate)).dev) {
    throw new Error("candidate must be in a different private folder on the same volume");
  }
  const stagingParent = lstatSync(dirname(candidate));
  if ((stagingParent.mode & 0o077) !== 0) throw new Error("staging folder must be private");
  if (typeof exchangeExecutable !== "string" || !isAbsolute(exchangeExecutable)) {
    throw new Error("atomic exchange helper is required");
  }
  noWalletProcess(target, candidate);
  const old = inspectLocalMacWallet(target, { allowLegacyRuntime: allowLegacyTarget });
  const next = inspectLocalMacWallet(candidate);
  if (old.hash !== expectedOldHash || next.hash !== expectedNewHash ||
      next.sequence <= old.sequence) throw new Error("wallet update pins or build sequence differ");
  // Recheck immediately before the atomic same-volume exchange. No PID is
  // accepted or signalled; the old app remains recoverable at candidate.
  noWalletProcess(target, candidate);
  if (inspectLocalMacWallet(target, { allowLegacyRuntime: allowLegacyTarget }).hash !== expectedOldHash ||
      inspectLocalMacWallet(candidate).hash !== expectedNewHash) {
    throw new Error("wallet app changed during update preflight");
  }
  try {
    execFileSync(exchangeExecutable, [target, candidate], { timeout: 10_000 });
    syncDirectory(dirname(target));
    syncDirectory(dirname(candidate));
    if (inspectLocalMacWallet(target).hash !== expectedNewHash ||
        inspectLocalMacWallet(candidate, { allowLegacyRuntime: allowLegacyTarget }).hash !== expectedOldHash) {
      throw new Error("wallet update postcondition failed");
    }
  } catch (error) {
    // A helper can exchange successfully and then exit nonzero; fsync can
    // also fail after the exchange. Inspect both complete generations before
    // deciding whether rollback is required. Never delete either bundle.
    let current;
    let previous;
    try {
      current = inspectLocalMacWallet(target, { allowLegacyRuntime: allowLegacyTarget }).hash;
      previous = inspectLocalMacWallet(candidate, { allowLegacyRuntime: allowLegacyTarget }).hash;
    } catch (inspectionError) {
      throw new AggregateError([error, inspectionError],
        "wallet update state is uncertain; preserve both app bundles for recovery");
    }
    if (current === expectedOldHash && previous === expectedNewHash) throw error;
    if (current !== expectedNewHash || previous !== expectedOldHash) {
      throw new AggregateError([error],
        "wallet update state is uncertain; preserve both app bundles for recovery");
    }
    try {
      execFileSync(exchangeExecutable, [target, candidate], { timeout: 10_000 });
      syncDirectory(dirname(target));
      syncDirectory(dirname(candidate));
    } catch (rollbackError) {
      let restored = false;
      try {
        restored = inspectLocalMacWallet(target, { allowLegacyRuntime: allowLegacyTarget }).hash === expectedOldHash &&
          inspectLocalMacWallet(candidate).hash === expectedNewHash;
      } catch { /* An unreadable generation requires manual recovery. */ }
      if (restored) throw error;
      throw new AggregateError([error, rollbackError],
        "wallet update failed and rollback needs manual recovery");
    }
    if (inspectLocalMacWallet(target, { allowLegacyRuntime: allowLegacyTarget }).hash !== expectedOldHash ||
        inspectLocalMacWallet(candidate).hash !== expectedNewHash) {
      throw new AggregateError([error], "wallet rollback needs manual recovery");
    }
    throw error;
  }
  return { current: target, previous: candidate, hash: expectedNewHash };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (["inspect", "inspect-legacy"].includes(process.argv[2]) && process.argv.length === 4) {
      process.stdout.write(`${JSON.stringify(inspectLocalMacWallet(process.argv[3],
        { allowLegacyRuntime: process.argv[2] === "inspect-legacy" }))}\n`);
    } else if (["install", "install-legacy"].includes(process.argv[2]) && process.argv.length === 7) {
      const scratch = mkdtempSync(join(tmpdir(), "nir-wallet-swap-"));
      try {
        const exchangeExecutable = join(scratch, "wallet-app-exchange");
        execFileSync("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror",
          fileURLToPath(new URL("../macos/wallet-app-exchange.c", import.meta.url)),
          "-o", exchangeExecutable], { timeout: 30_000 });
        const result = installLocalMacWallet({ target: process.argv[3], candidate: process.argv[4],
          expectedOldHash: process.argv[5], expectedNewHash: process.argv[6],
          exchangeExecutable, allowLegacyTarget: process.argv[2] === "install-legacy" });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    } else throw new Error("usage: wallet:macos-local-install inspect|inspect-legacy <app> | install|install-legacy <current.app> <staged.app> <expected-old-sha256> <expected-new-sha256>");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireDataDirectoryLock } from "../blockchain/data-directory-lock.mjs";

test("a node data directory permits only one live writer", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-directory-lock-test-"));
  try {
    const release = acquireDataDirectoryLock(directory);
    assert.throws(() => acquireDataDirectoryLock(directory), /already open by process/);
    assert.equal(release(), true);
    assert.equal(release(), false);
    const releaseAgain = acquireDataDirectoryLock(directory);
    assert.equal(releaseAgain(), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two independent writers cannot both acquire the same directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-directory-lock-test-"));
  const moduleUrl = new URL("../blockchain/data-directory-lock.mjs", import.meta.url).href;
  const script = `import { acquireDataDirectoryLock } from ${JSON.stringify(moduleUrl)};
    try {
      const release = acquireDataDirectoryLock(process.argv[1]);
      process.stdout.write("ACQUIRED\\n");
      setTimeout(() => { release(); process.exit(0); }, 500);
    } catch (error) {
      process.stdout.write(error.message.includes("already open") ? "BUSY\\n" : "ERROR\\n");
      process.exit(0);
    }`;
  function writer() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, directory],
        { stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; let errors = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { errors += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
    });
  }
  try {
    assert.deepEqual((await Promise.all([writer(), writer()])).sort(), ["ACQUIRED", "BUSY"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a dead process lock is recovered but malformed ownership fails closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-directory-lock-test-"));
  const lockDirectory = join(directory, ".nir-writer-lock");
  try {
    mkdirSync(lockDirectory, { mode: 0o700 });
    writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({
      format: "nir-data-directory-lock-v1",
      pid: 2_147_483_647,
      startedAt: 1,
      token: "a".repeat(64),
    }), { mode: 0o600 });
    const release = acquireDataDirectoryLock(directory);
    assert.equal(release(), true);

    mkdirSync(lockDirectory, { mode: 0o700 });
    writeFileSync(join(lockDirectory, "owner.json"), "{}\n", { mode: 0o600 });
    assert.throws(() => acquireDataDirectoryLock(directory), /lock is invalid/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a crash before atomic publication leaves no blocking lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-directory-lock-test-"));
  const temporary = join(directory, ".nir-writer-lock.prepared.next");
  try {
    writeFileSync(temporary, JSON.stringify({
      format: "nir-data-directory-lock-v1", pid: 2_147_483_647,
      startedAt: 1, token: "a".repeat(64),
    }), { mode: 0o600 });
    const release = acquireDataDirectoryLock(directory);
    assert.equal(release(), true);
    assert.equal(existsSync(temporary), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a crash after atomic publication leaves a complete recoverable owner", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-directory-lock-test-"));
  const temporary = join(directory, ".nir-writer-lock.prepared.next");
  const lockPath = join(directory, ".nir-writer-lock");
  try {
    writeFileSync(temporary, JSON.stringify({
      format: "nir-data-directory-lock-v1", pid: 2_147_483_647,
      startedAt: 1, token: "b".repeat(64),
    }), { mode: 0o600 });
    linkSync(temporary, lockPath);
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).token, "b".repeat(64));
    const release = acquireDataDirectoryLock(directory);
    assert.equal(release(), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("release never deletes a lock whose ownership changed", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-directory-lock-test-"));
  const lockDirectory = join(directory, ".nir-writer-lock");
  try {
    const release = acquireDataDirectoryLock(directory);
    rmSync(lockDirectory);
    writeFileSync(lockDirectory, JSON.stringify({
      format: "nir-data-directory-lock-v1",
      pid: process.pid,
      startedAt: Date.now(),
      token: "f".repeat(64),
    }), { mode: 0o600 });
    assert.equal(release(), false);
    assert.equal(existsSync(lockDirectory), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live and ownerless legacy directories fail closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-directory-lock-test-"));
  const lockDirectory = join(directory, ".nir-writer-lock");
  try {
    mkdirSync(lockDirectory, { mode: 0o700 });
    assert.throws(() => acquireDataDirectoryLock(directory), /lock is incomplete/);
    assert.equal(existsSync(lockDirectory), true);
    writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({
      format: "nir-data-directory-lock-v1", pid: process.pid,
      startedAt: Date.now(), token: "e".repeat(64),
    }), { mode: 0o600 });
    assert.throws(() => acquireDataDirectoryLock(directory), /already open by process/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("symbolic-link substitutions fail closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-directory-lock-test-"));
  const target = mkdtempSync(join(tmpdir(), "nir-directory-lock-target-"));
  try {
    const linkedRoot = join(directory, "linked-node");
    symlinkSync(target, linkedRoot, "dir");
    assert.throws(() => acquireDataDirectoryLock(linkedRoot), /directory is unsafe/);

    const lockDirectory = join(directory, ".nir-writer-lock");
    mkdirSync(lockDirectory, { mode: 0o700 });
    const outside = join(target, "owner.json");
    writeFileSync(outside, "{}\n", { mode: 0o600 });
    symlinkSync(outside, join(lockDirectory, "owner.json"));
    assert.throws(() => acquireDataDirectoryLock(directory), /lock is invalid|ELOOP/);
    rmSync(lockDirectory, { recursive: true });
    symlinkSync(outside, lockDirectory);
    assert.throws(() => acquireDataDirectoryLock(directory), /lock is invalid/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

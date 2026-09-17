import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

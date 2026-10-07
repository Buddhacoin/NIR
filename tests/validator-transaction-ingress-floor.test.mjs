import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync,
  unlinkSync, writeFileSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { advanceTransactionIngressFloor, initializeTransactionIngressFloor,
  loadTransactionIngressFloor } from "../blockchain/validator-transaction-ingress-floor.mjs";

const identity = { expectedGenesisHash: "a".repeat(64),
  expectedNetworkId: "nir-ingress-floor-test",
  expectedPolicyId: `sha3-256:${"b".repeat(64)}`,
  validatorAddress: `nir1${"c".repeat(64)}` };
const candidate = (sequence, height, observedAt) => ({
  height, historyCount: 1, historyHead: "d".repeat(64), observedAt,
  packageHash: `sha3-256:${sequence.toString(16).padStart(64, "0")}`,
  sequence, tipHash: height.toString(16).padStart(64, "0"),
});

function temporary() {
  const root = mkdtempSync(join(tmpdir(), "nir-ingress-floor-test-"));
  return { root, directory: join(root, "floor") };
}

function crashAdvance(directory, next, hook) {
  const source = new URL("../blockchain/validator-transaction-ingress-floor.mjs",
    import.meta.url).href;
  return spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { advanceTransactionIngressFloor } from ${JSON.stringify(source)};
     advanceTransactionIngressFloor(process.argv[1], JSON.parse(process.argv[2]),
       JSON.parse(process.argv[3]), { ${hook}: () => process.exit(77) });`,
    directory, JSON.stringify(identity), JSON.stringify(next)], { encoding: "utf8" });
}

function clearTerminatedTestWriterLock(directory) {
  const lock = join(directory, ".floor.lock");
  const owner = JSON.parse(readFileSync(lock, "utf8"));
  unlinkSync(lock);
  const temporary = join(directory, owner.temporaryName);
  if (existsSync(temporary)) unlinkSync(temporary);
}

test("restart reloads the exact persistent floor and refuses silent reinitialization", () => {
  const values = temporary();
  try {
    initializeTransactionIngressFloor(values.directory, identity);
    assert.throws(() => initializeTransactionIngressFloor(values.directory, identity));
    const latest = advanceTransactionIngressFloor(values.directory, identity,
      candidate(8, 10, 1_800_000_000_000));
    assert.equal(latest.revision, 1);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { loadTransactionIngressFloor } from ${JSON.stringify(new URL(
        "../blockchain/validator-transaction-ingress-floor.mjs", import.meta.url).href)};
       const floor = loadTransactionIngressFloor(process.argv[1], JSON.parse(process.argv[2]));
       process.stdout.write(JSON.stringify({ height: floor.height, sequence: floor.sequence,
         tipHash: floor.tipHash, observedAt: floor.observedAt }));`,
      values.directory, JSON.stringify(identity)], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      height: 10, sequence: 8, tipHash: candidate(8, 10, 0).tipHash,
      observedAt: 1_800_000_000_000,
    });
    assert.equal(loadTransactionIngressFloor(values.directory, identity).recordHash,
      latest.recordHash);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("interruption before rename retains old floor; after first copy recovers only linked newer floor", () => {
  const values = temporary();
  try {
    initializeTransactionIngressFloor(values.directory, identity);
    const first = advanceTransactionIngressFloor(values.directory, identity,
      candidate(8, 10, 100));
    assert.throws(() => advanceTransactionIngressFloor(values.directory, identity,
      candidate(9, 11, 101), { _beforeCopyRename: () => { throw new Error("power cut"); } }),
    /power cut/);
    assert.equal(loadTransactionIngressFloor(values.directory, identity).recordHash,
      first.recordHash);
    assert.throws(() => advanceTransactionIngressFloor(values.directory, identity,
      candidate(9, 11, 101), { _afterFirstCopy: () => { throw new Error("power cut"); } }),
    /power cut/);
    const recovered = loadTransactionIngressFloor(values.directory, identity);
    assert.equal(recovered.revision, 2);
    assert.equal(recovered.height, 11);
    assert.equal(recovered.previousRecordHash, first.recordHash);
    assert.equal(advanceTransactionIngressFloor(values.directory, identity,
      candidate(10, 12, 102)).revision, 3);
    assert.equal(loadTransactionIngressFloor(values.directory, identity).height, 12);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("repeated interruption repairs the torn pair before starting another revision", () => {
  const values = temporary();
  try {
    initializeTransactionIngressFloor(values.directory, identity);
    advanceTransactionIngressFloor(values.directory, identity, candidate(8, 10, 100));
    assert.equal(crashAdvance(values.directory, candidate(9, 11, 101),
      "_afterFirstCopy").status, 77);
    assert.equal(loadTransactionIngressFloor(values.directory, identity).revision, 2);
    clearTerminatedTestWriterLock(values.directory);
    assert.equal(crashAdvance(values.directory, candidate(10, 12, 102),
      "_afterFirstCopy").status, 77);
    const recovered = loadTransactionIngressFloor(values.directory, identity);
    assert.equal(recovered.revision, 3);
    assert.equal(recovered.height, 12);
    clearTerminatedTestWriterLock(values.directory);
    assert.equal(advanceTransactionIngressFloor(values.directory, identity,
      candidate(11, 13, 103)).revision, 4);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("descriptor-open growth is bounded before allocation for floor and lock files", () => {
  const values = temporary();
  const allocate = Buffer.alloc;
  try {
    initializeTransactionIngressFloor(values.directory, identity);
    Buffer.alloc = (size, ...args) => {
      if (size > 4096) throw new Error("unbounded allocation attempted");
      return allocate(size, ...args);
    };
    assert.throws(() => loadTransactionIngressFloor(values.directory, identity, {
      _afterCopyOpen: ({ path }) => truncateSync(path, 16 * 1024 * 1024),
    }), /changed during open/);
  } finally {
    Buffer.alloc = allocate;
    rmSync(values.root, { recursive: true, force: true });
  }
  const lockValues = temporary();
  try {
    initializeTransactionIngressFloor(lockValues.directory, identity);
    Buffer.alloc = (size, ...args) => {
      if (size > 4096) throw new Error("unbounded allocation attempted");
      return allocate(size, ...args);
    };
    assert.throws(() => advanceTransactionIngressFloor(lockValues.directory, identity,
      candidate(8, 10, 100), {
        _afterLockOpen: ({ path }) => truncateSync(path, 16 * 1024 * 1024),
      }), /lock changed/);
  } finally {
    Buffer.alloc = allocate;
    rmSync(lockValues.root, { recursive: true, force: true });
  }
});

test("crash before publication leaves no lock; published stale lock denies until manual recovery", () => {
  const values = temporary();
  try {
    initializeTransactionIngressFloor(values.directory, identity);
    assert.equal(crashAdvance(values.directory, candidate(8, 10, 100),
      "_afterLockTemporaryOpen").status, 77);
    assert.equal(existsSync(join(values.directory, ".floor.lock")), false);
    assert.equal(crashAdvance(values.directory, candidate(8, 10, 100),
      "_afterLockPublish").status, 77);
    assert.equal(existsSync(join(values.directory, ".floor.lock")), true);
    assert.throws(() => advanceTransactionIngressFloor(values.directory, identity,
      candidate(8, 10, 100)), /EEXIST/);
    assert.equal(loadTransactionIngressFloor(values.directory, identity).revision, 0);
    // Only this test's terminated child owned the lock. Ordinary runtime code
    // never removes it; an operator must establish that fact independently.
    clearTerminatedTestWriterLock(values.directory);
    assert.equal(advanceTransactionIngressFloor(values.directory, identity,
      candidate(8, 10, 100)).revision, 1);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("interrupted one-time initialization remains closed and cannot silently reset", () => {
  const values = temporary();
  try {
    assert.throws(() => initializeTransactionIngressFloor(values.directory, identity, {
      _afterFirstCopy: () => { throw new Error("power cut"); },
    }), /power cut/);
    assert.throws(() => loadTransactionIngressFloor(values.directory, identity), /ENOENT/);
    assert.throws(() => initializeTransactionIngressFloor(values.directory, identity));
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("an initial witness sequence of zero is accepted once without weakening later monotonicity", () => {
  const values = temporary();
  try {
    initializeTransactionIngressFloor(values.directory, identity);
    assert.equal(advanceTransactionIngressFloor(values.directory, identity,
      candidate(0, 10, 100)).sequence, 0);
    assert.throws(() => advanceTransactionIngressFloor(values.directory, identity,
      candidate(0, 11, 101)), /rollback/);
    assert.equal(advanceTransactionIngressFloor(values.directory, identity,
      candidate(1, 11, 101)).sequence, 1);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("identity mismatch, invalid monotonic transitions, corrupt copy, and lost store fail closed", () => {
  const values = temporary();
  try {
    initializeTransactionIngressFloor(values.directory, identity);
    advanceTransactionIngressFloor(values.directory, identity, candidate(8, 10, 100));
    assert.throws(() => loadTransactionIngressFloor(values.directory,
      { ...identity, expectedGenesisHash: "f".repeat(64) }), /identity/);
    assert.throws(() => advanceTransactionIngressFloor(values.directory, identity,
      candidate(7, 9, 101)), /rollback/);
    assert.throws(() => advanceTransactionIngressFloor(values.directory, identity,
      { ...candidate(9, 10, 101), tipHash: "f".repeat(64) }), /divergence/);
    assert.throws(() => advanceTransactionIngressFloor(values.directory, identity,
      candidate(9, 11, 99)), /rollback/);
    writeFileSync(join(values.directory, "FLOOR.primary.json"), "corrupt\n");
    assert.throws(() => loadTransactionIngressFloor(values.directory, identity));
    rmSync(values.directory, { recursive: true, force: true });
    assert.throws(() => loadTransactionIngressFloor(values.directory, identity), /ENOENT/);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("private floor rejects symlinked roots and copy substitution", () => {
  const values = temporary();
  try {
    initializeTransactionIngressFloor(values.directory, identity);
    const alias = join(values.root, "alias"); symlinkSync(values.directory, alias);
    assert.throws(() => loadTransactionIngressFloor(alias, identity), /unsafe/);
    rmSync(join(values.directory, "FLOOR.primary.json"));
    symlinkSync(join(values.directory, "FLOOR.secondary.json"),
      join(values.directory, "FLOOR.primary.json"));
    assert.throws(() => loadTransactionIngressFloor(values.directory, identity), /unsafe/);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

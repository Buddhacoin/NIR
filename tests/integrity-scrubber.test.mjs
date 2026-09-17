import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBackupInventory } from "../blockchain/backup-recovery.mjs";
import { exportBlockStoreBackup, loadBlockStore } from "../blockchain/block-store.mjs";
import { acquireDataDirectoryLock } from "../blockchain/data-directory-lock.mjs";
import { generateWallet, hashObject } from "../blockchain/crypto.mjs";
import {
  integrityScrubDryRun,
  integrityScrubberHealth,
  repairIntegrityFromRemote,
  repairLocalIntegrityCopies,
  runIntegrityScrubScheduler,
  runIntegrityScrubStep,
  scheduledIntegrityTime,
  validateIntegrityScrubberConfig,
} from "../blockchain/integrity-scrubber.mjs";
import { initializeDevnet, PersistentDevNode } from "../blockchain/node-store.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-integrity-scrub-"));
  const nodeDirectory = join(root, "node");
  const stateDirectory = join(root, "scrub-state");
  initializeDevnet(nodeDirectory);
  const node = new PersistentDevNode(nodeDirectory);
  node.faucet(generateWallet().address);
  const trustedOperatorsPath = join(root, "trusted.json");
  writeFileSync(trustedOperatorsPath, "[]\n");
  const config = {
    format: "nir-integrity-scrubber-config-v1",
    genesisPath: join(nodeDirectory, "genesis.json"),
    handoffsPath: null,
    intervalMs: 60_000,
    jitterMs: 1_000,
    maxBytesPerStep: 64 * 1024 * 1024,
    maxFilesPerStep: 1,
    maxQuarantines: 2,
    maxReceiptAgeMs: 30 * 24 * 60 * 60 * 1000,
    maxReplayBytes: 256 * 1024 * 1024,
    nodeDirectory,
    operatorId: "scrubber-a",
    sources: ["http://127.0.0.1:9901", "http://127.0.0.1:9902"],
    stateDirectory,
    trustedOperatorsPath,
  };
  return { cleanup: () => rmSync(root, { recursive: true, force: true }), config,
    genesis: JSON.parse(readFileSync(config.genesisPath, "utf8")), nodeDirectory, root };
}

function runSweep(config, start = 1_000) {
  let health;
  for (let index = 0; index < 32; index += 1) {
    health = runIntegrityScrubStep(config, { now: start + index });
    if (health.phase === "complete") return health;
  }
  throw new Error("scrub sweep did not complete");
}

function prepareRemote(context) {
  const workspace = join(context.root, "remote-backup");
  exportBlockStoreBackup(context.nodeDirectory, workspace, context.genesis);
  const loaded = loadBlockStore(workspace, context.genesis, { repair: false });
  const inventory = createBackupInventory(workspace);
  return {
    checkpointHash: loaded.checkpoint.checkpointHash,
    height: loaded.chain.height,
    inventoryRoot: inventory.inventoryRoot,
    networkId: loaded.chain.networkId,
    stateRoot: loaded.chain.stateRoot,
    tipHash: loaded.chain.tipHash,
    workspace,
  };
}

test("bounded steps resume from a redundant cursor and finish read-only", () => {
  const context = fixture();
  try {
    const before = readFileSync(join(context.nodeDirectory, "STORE-CHECKPOINT.json"), "utf8");
    const dry = integrityScrubDryRun(context.config, 900);
    assert.equal(dry.writesPerformed, false);
    assert.equal(existsSync(context.config.stateDirectory), false);
    let previousBytes = 0;
    let health;
    for (let index = 0; index < 16; index += 1) {
      health = runIntegrityScrubStep(context.config, { now: 1_000 + index });
      assert.ok(health.scannedBytes - previousBytes <=
        context.config.maxReplayBytes + context.config.maxBytesPerStep);
      previousBytes = health.scannedBytes;
      if (health.phase === "complete") break;
    }
    assert.equal(health.healthy, true);
    assert.equal(health.totalIssues, 0);
    assert.equal(readFileSync(join(context.nodeDirectory, "STORE-CHECKPOINT.json"), "utf8"), before);
    assert.equal(integrityScrubberHealth(context.config, { now: 2_000 }).healthy, true);
  } finally { context.cleanup(); }
});

test("a restart repairs one damaged cursor copy but conflicting state fails closed", () => {
  const context = fixture();
  try {
    runIntegrityScrubStep(context.config, { now: 1_000 });
    const primary = join(context.config.stateDirectory, "SCRUB-CURSOR.json");
    const backup = join(context.config.stateDirectory, "SCRUB-CURSOR.backup.json");
    writeFileSync(primary, "{}\n");
    assert.doesNotThrow(() => runIntegrityScrubStep(context.config, { now: 2_000 }));
    assert.equal(readFileSync(primary, "utf8"), readFileSync(backup, "utf8"));
    const modified = JSON.parse(readFileSync(primary, "utf8"));
    modified.sweep += 1;
    writeFileSync(primary, `${JSON.stringify(modified)}\n`);
    assert.throws(() => integrityScrubberHealth(context.config), /cursor/);
  } finally { context.cleanup(); }
});

test("one corrupt block copy is detected and repaired only under the writer lock", () => {
  const context = fixture();
  try {
    const primary = join(context.nodeDirectory, "blocks", "000000000001.json");
    const backup = join(context.nodeDirectory, "block-backups", "000000000001.json");
    const canonical = readFileSync(backup, "utf8");
    writeFileSync(primary, "{corrupt\n");
    const readOnly = loadBlockStore(context.nodeDirectory, context.genesis, { repair: false });
    assert.equal(readOnly.recoveredCopies, 1);
    assert.equal(readFileSync(primary, "utf8"), "{corrupt\n");
    const health = runSweep(context.config);
    assert.equal(health.healthy, false);
    assert.ok(health.issues.some(({ kind, target }) =>
      kind === "repairable-local" && target.includes("blocks/")));

    const release = acquireDataDirectoryLock(context.nodeDirectory);
    assert.throws(() => repairLocalIntegrityCopies(context.config), /already open/);
    release();
    assert.equal(repairLocalIntegrityCopies(context.config).repaired >= 1, true);
    assert.equal(readFileSync(primary, "utf8"), canonical);
  } finally { context.cleanup(); }
});

test("an unverified snapshot is never promoted as a local repair source", () => {
  const context = fixture();
  try {
    const snapshotDirectory = join(context.nodeDirectory, "snapshots");
    const snapshot = join(snapshotDirectory, "STATE-SNAPSHOT.json");
    const snapshotBackup = join(snapshotDirectory, "STATE-SNAPSHOT.backup.json");
    mkdirSync(snapshotDirectory, { recursive: true });
    writeFileSync(snapshot, `${JSON.stringify({ attackerControlled: true })}\n`);
    writeFileSync(snapshotBackup, `${JSON.stringify({ attackerControlled: true })}\n`);
    const health = runSweep(context.config);
    assert.equal(health.healthy, false);
    assert.ok(health.issues.some(({ kind, left, right }) =>
      kind === "remote-repair-required" && left?.includes("STATE-SNAPSHOT") &&
      right?.includes("STATE-SNAPSHOT")), JSON.stringify(health.issues));
    assert.equal(health.issues.some(({ kind, source }) =>
      kind === "repairable-local" && source?.includes("STATE-SNAPSHOT")), false);
  } finally { context.cleanup(); }
});

test("remote repair refuses a valid but older generation", async () => {
  const context = fixture();
  try {
    const oldDrill = prepareRemote(context);
    new PersistentDevNode(context.nodeDirectory).faucet(generateWallet().address);
    await assert.rejects(repairIntegrityFromRemote(context.config, {
      now: 9_000, restoreDrill: async () => oldDrill,
    }), /roll back/);
    assert.equal(new PersistentDevNode(context.nodeDirectory).height, 2);
  } finally { context.cleanup(); }
});

test("local repair rejects symlink substitution and preserves the verified copy", () => {
  const context = fixture();
  try {
    const primary = join(context.nodeDirectory, "blocks", "000000000001.json");
    const backup = join(context.nodeDirectory, "block-backups", "000000000001.json");
    rmSync(primary);
    symlinkSync(backup, primary);
    runSweep(context.config);
    assert.throws(() => repairLocalIntegrityCopies(context.config), /symbolic link/);
    assert.equal(readFileSync(backup, "utf8").includes('"height": 1'), true);
  } finally { context.cleanup(); }
});

test("inode substitution between lstat and open is detected", () => {
  const context = fixture();
  let substituted = false;
  try {
    const primary = join(context.nodeDirectory, "blocks", "000000000001.json");
    let health;
    for (let index = 0; index < 16; index += 1) {
      health = runIntegrityScrubStep(context.config, {
        now: 1_000 + index,
        afterFileLstat(path) {
          if (substituted || path !== primary) return;
          substituted = true;
          renameSync(primary, `${primary}.swapped`);
          writeFileSync(primary, readFileSync(`${primary}.swapped`));
        },
      });
      if (health.phase === "complete") break;
    }
    assert.equal(substituted, true);
    assert.ok(health.issues.some(({ kind, target }) =>
      kind === "repairable-local" && target === "blocks/000000000001.json"));
  } finally { context.cleanup(); }
});

test("a checksum-valid cursor still cannot substitute a path outside node storage", () => {
  const context = fixture();
  try {
    writeFileSync(join(context.nodeDirectory, "blocks", "000000000001.json"), "damaged\n");
    runSweep(context.config);
    const cursorPath = join(context.config.stateDirectory, "SCRUB-CURSOR.json");
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8"));
    const issue = cursor.issues.find(({ kind }) => kind === "repairable-local");
    issue.source = "../../outside.json";
    const { cursorHash: _old, ...payload } = cursor;
    const changed = { ...payload, cursorHash: hashObject(payload, "INTEGRITY_SCRUB_CURSOR") };
    for (const name of ["SCRUB-CURSOR.json", "SCRUB-CURSOR.backup.json"]) {
      writeFileSync(join(context.config.stateDirectory, name), `${JSON.stringify(changed)}\n`);
    }
    assert.throws(() => repairLocalIntegrityCopies(context.config), /unsafe path/);
  } finally { context.cleanup(); }
});

test("a disk-full local repair fails without overwriting the damaged target", () => {
  const context = fixture();
  try {
    const primary = join(context.nodeDirectory, "blocks", "000000000001.json");
    writeFileSync(primary, "damaged\n");
    runSweep(context.config);
    assert.throws(() => repairLocalIntegrityCopies(context.config, {
      writeRepairFile() { const error = new Error("no space"); error.code = "ENOSPC"; throw error; },
    }), /no space/);
    assert.equal(readFileSync(primary, "utf8"), "damaged\n");
  } finally { context.cleanup(); }
});

test("two corrupt copies require a fully verified remote generation", async () => {
  const context = fixture();
  try {
    const drill = prepareRemote(context);
    for (const folder of ["blocks", "block-backups"]) {
      writeFileSync(join(context.nodeDirectory, folder, "000000000001.json"), "broken\n");
    }
    const health = runSweep(context.config);
    assert.ok(health.issues.some(({ kind }) => kind === "remote-repair-required"));
    const result = await repairIntegrityFromRemote(context.config, {
      now: 5_000, restoreDrill: async () => drill,
    });
    assert.equal(result.repaired, true);
    assert.equal(new PersistentDevNode(context.nodeDirectory).height, 1);
    assert.equal(readFileSync(join(context.nodeDirectory, "blocks", "000000000001.json"), "utf8"),
      readFileSync(join(context.nodeDirectory, "block-backups", "000000000001.json"), "utf8"));
  } finally { context.cleanup(); }
});

test("an interrupted remote activation blocks node start and resumes safely", async () => {
  const context = fixture();
  try {
    const drill = prepareRemote(context);
    for (const folder of ["blocks", "block-backups"]) {
      writeFileSync(join(context.nodeDirectory, folder, "000000000001.json"), "broken\n");
    }
    let interrupted = false;
    await assert.rejects(repairIntegrityFromRemote(context.config, {
      now: 7_000,
      restoreDrill: async () => drill,
      afterComponent(name) {
        if (!interrupted && name === "blocks") { interrupted = true; throw new Error("crash window"); }
      },
    }), /crash window/);
    assert.throws(() => loadBlockStore(context.nodeDirectory, context.genesis),
      /incomplete integrity installation/);
    await repairIntegrityFromRemote(context.config, {
      now: 8_000, restoreDrill: async () => drill,
    });
    assert.equal(loadBlockStore(context.nodeDirectory, context.genesis, { repair: false }).chain.height, 1);
  } finally { context.cleanup(); }
});

test("configuration, deterministic jitter, and scheduler fail closed", async () => {
  const context = fixture();
  try {
    assert.throws(() => validateIntegrityScrubberConfig({
      ...context.config, password: "forbidden",
    }), /secret field|invalid/);
    assert.throws(() => validateIntegrityScrubberConfig({
      ...context.config, stateDirectory: join(context.nodeDirectory, "scrub-state"),
    }), /must not overlap/);
    assert.equal(scheduledIntegrityTime(context.config, 4),
      scheduledIntegrityTime(context.config, 4));
    const options = { maximumRuns: 1, now: () => 70_000 };
    assert.equal(await runIntegrityScrubScheduler(context.config, options), 1);
  } finally { context.cleanup(); }
});

test("health CLI returns machine-readable unhealthy status", () => {
  const context = fixture();
  try {
    const configPath = join(context.root, "scrubber.json");
    writeFileSync(configPath, `${JSON.stringify(context.config)}\n`);
    const result = spawnSync(process.execPath, [
      "blockchain/integrity-scrubber-cli.mjs", "health", configPath,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 2);
    const health = JSON.parse(result.stdout);
    assert.equal(health.format, "nir-integrity-scrubber-health-v1");
    assert.equal(health.healthy, false);
    assert.ok(health.reasons.includes("never-started"));
  } finally { context.cleanup(); }
});

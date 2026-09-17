import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  backupAutomationDryRun,
  backupAutomationHealth,
  readBackupAutomationJournal,
  runBackupAutomationCycle,
  runBackupAutomationScheduler,
  scheduledBackupTime,
  validateBackupAutomationConfig,
} from "../blockchain/backup-automation.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-backup-automation-"));
  const wallet = generateWallet();
  const config = {
    backupRoot: join(root, "backups"),
    drillRoot: join(root, "drills"),
    format: "nir-backup-automation-config-v1",
    genesisPath: join(root, "genesis.json"),
    intervalMs: 60_000,
    jitterMs: 5_000,
    liveDirectory: join(root, "live"),
    maxBackups: 2,
    maxDrillWorkspaces: 2,
    maxReceiptAgeMs: 120_000,
    maxSuccessAgeMs: 180_000,
    operatorId: "backup-monitor-a",
    resultSigner: publicWallet(wallet),
    sources: ["http://127.0.0.1:8791", "http://127.0.0.1:8792"],
    stateDirectory: join(root, "state"),
    trustedOperatorsPath: join(root, "trusted.json"),
  };
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { cleanup, config, root, wallet };
}

function successfulOptions(config, times = [1_000, 1_001]) {
  let index = 0;
  return {
    exportBackup(_live, destination) {
      mkdirSync(destination, { recursive: true });
      return {
        height: 8, networkId: "nir-automation-test", privateKeysIncluded: false,
        tipHash: "d".repeat(64),
      };
    },
    now: () => times[Math.min(index++, times.length - 1)],
    readJson(path) {
      return path === config.genesisPath ? { networkId: "nir-automation-test" } : [];
    },
    async restoreDrill(_root, _sources, _genesis, options) {
      assert.equal(Number.isSafeInteger(options.now), true);
      const workspace = join(config.drillRoot, `drill-${"b".repeat(64)}`);
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "DRILL-COMPLETE.json"), `${JSON.stringify({
        checkpointHash: "a".repeat(64),
        format: "nir-backup-restore-drill-v1",
        height: 7,
        inventoryRoot: "b".repeat(64),
        networkId: "nir-automation-test",
        tipHash: "c".repeat(64),
      })}\n`);
      return {
        checkpointHash: "a".repeat(64), height: 7, inventoryRoot: "b".repeat(64),
        networkId: "nir-automation-test", tipHash: "c".repeat(64),
        workspace,
      };
    },
  };
}

test("a signed successful cycle is journaled and reports healthy", async () => {
  const context = fixture();
  try {
    const record = await runBackupAutomationCycle(
      context.config, context.wallet, successfulOptions(context.config),
    );
    assert.equal(record.payload.status, "success");
    assert.equal(JSON.stringify(record).includes("privateKey"), false);
    const journal = readBackupAutomationJournal(context.config);
    assert.equal(journal.records.length, 1);
    assert.equal(journal.head.resultHash, record.payload.resultHash);
    const health = backupAutomationHealth(context.config, {
      expectedHeadHash: record.payload.resultHash, minimumSequence: 1, now: 2_000,
    });
    assert.equal(health.healthy, true);
    assert.deepEqual(health.reasons, []);
  } finally { context.cleanup(); }
});

test("configuration and dry-run fail closed without writing state", () => {
  const context = fixture();
  try {
    assert.throws(() => validateBackupAutomationConfig({
      ...context.config, password: "must-not-appear",
    }), /secret field|invalid/);
    assert.throws(() => validateBackupAutomationConfig({
      ...context.config, sources: ["https://user:pass@example.test", "https://b.example.test"],
    }), /unsafe/);
    const first = backupAutomationDryRun(context.config, 70_000);
    const second = backupAutomationDryRun(context.config, 70_000);
    assert.deepEqual(first, second);
    assert.equal(first.writesPerformed, false);
    assert.equal(scheduledBackupTime(context.config, 2), first.nextRunAt);
    assert.equal(readdirSync(context.root).length, 0);
  } finally { context.cleanup(); }
});

test("a concurrent runner is rejected while the first owns the crash-safe lock", async () => {
  const context = fixture();
  let releaseRestore;
  try {
    const firstOptions = successfulOptions(context.config);
    firstOptions.restoreDrill = () => new Promise((resolve) => { releaseRestore = resolve; });
    const first = runBackupAutomationCycle(context.config, context.wallet, firstOptions);
    while (!releaseRestore) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      runBackupAutomationCycle(context.config, context.wallet, successfulOptions(context.config)),
      /already running/,
    );
    const workspace = join(context.config.drillRoot, `drill-${"b".repeat(64)}`);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "DRILL-COMPLETE.json"), `${JSON.stringify({
      checkpointHash: "a".repeat(64), format: "nir-backup-restore-drill-v1", height: 7,
      inventoryRoot: "b".repeat(64), networkId: "nir-automation-test",
      tipHash: "c".repeat(64),
    })}\n`);
    releaseRestore({
      checkpointHash: "a".repeat(64), height: 7, inventoryRoot: "b".repeat(64),
      networkId: "nir-automation-test", tipHash: "c".repeat(64),
      workspace,
    });
    assert.equal((await first).payload.status, "success");
  } finally { context.cleanup(); }
});

test("restart recovers a dead owner lock but rejects a malformed lock", async () => {
  const context = fixture();
  try {
    const lock = join(context.config.stateDirectory, ".backup-automation-lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({
      format: "nir-backup-automation-lock-v1", pid: 999_999, startedAt: 1,
      token: "d".repeat(64),
    }));
    const options = successfulOptions(context.config);
    options.processAlive = () => false;
    assert.equal((await runBackupAutomationCycle(context.config, context.wallet, options))
      .payload.status, "success");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), "{}\n");
    await assert.rejects(
      runBackupAutomationCycle(context.config, context.wallet, successfulOptions(context.config)),
      /lock is invalid/,
    );
  } finally { context.cleanup(); }
});

test("stale receipts and partial restores create signed failures and unhealthy status", async () => {
  for (const [message, expected] of [
    ["backup receipt is invalid, stale, or untrusted", "stale-receipt"],
    ["no agreed backup source completed the bounded download", "restore-incomplete"],
  ]) {
    const context = fixture();
    try {
      const options = successfulOptions(context.config);
      options.restoreDrill = async () => { throw new Error(message); };
      const record = await runBackupAutomationCycle(context.config, context.wallet, options);
      assert.equal(record.payload.status, "failure");
      assert.equal(record.payload.errorCode, expected);
      const health = backupAutomationHealth(context.config, { now: 2_000 });
      assert.equal(health.healthy, false);
      assert.ok(health.reasons.includes("latest-run-failed"));
    } finally { context.cleanup(); }
  }
});

test("journal mutation, truncation, and a rolled-back head fail closed", async () => {
  const context = fixture();
  try {
    await runBackupAutomationCycle(context.config, context.wallet,
      successfulOptions(context.config, [1_000, 1_001]));
    await runBackupAutomationCycle(context.config, context.wallet,
      successfulOptions(context.config, [61_000, 61_001]));
    const journalPath = join(context.config.stateDirectory, "BACKUP-DRILLS.jsonl");
    const original = readFileSync(journalPath, "utf8");
    writeFileSync(journalPath, original.split("\n")[0] + "\n");
    assert.throws(() => readBackupAutomationJournal(context.config), /rollback|substitution/);
    writeFileSync(journalPath, original.replace('"status":"success"', '"status":"failure"'));
    assert.throws(() => readBackupAutomationJournal(context.config), /signature|chain/);
    writeFileSync(journalPath, original.slice(0, -4));
    assert.throws(() => readBackupAutomationJournal(context.config), /incomplete/);
  } finally { context.cleanup(); }
});

test("a restart repairs only signed journal-ahead head copies", async () => {
  const context = fixture();
  try {
    await runBackupAutomationCycle(context.config, context.wallet,
      successfulOptions(context.config, [1_000, 1_001]));
    const previousHead = readFileSync(
      join(context.config.stateDirectory, "BACKUP-DRILLS.head.json"), "utf8",
    );
    const previousBytes = Buffer.byteLength(readFileSync(
      join(context.config.stateDirectory, "BACKUP-DRILLS.jsonl"), "utf8",
    ));
    const second = await runBackupAutomationCycle(context.config, context.wallet,
      successfulOptions(context.config, [61_000, 61_001]));
    writeFileSync(join(context.config.stateDirectory, "BACKUP-DRILLS.head.backup.json"),
      previousHead);
    writeFileSync(join(context.config.stateDirectory, "BACKUP-DRILLS.pending.json"),
      `${JSON.stringify({
        format: "nir-backup-automation-pending-v1",
        previousBytes,
        previousHash: second.payload.previousHash,
        resultHash: second.payload.resultHash,
        sequence: second.payload.sequence,
        signature: second.signature,
        signer: second.signer,
      })}\n`);
    await assert.doesNotReject(runBackupAutomationCycle(context.config, context.wallet,
      successfulOptions(context.config, [121_000, 121_001])));
    assert.equal(readBackupAutomationJournal(context.config).records.length, 3);
  } finally { context.cleanup(); }
});

test("retention is bounded, clears crash staging, and preserves the confirmed backup", async () => {
  const context = fixture();
  try {
    mkdirSync(join(context.config.backupRoot, ".staging-abandoned"), { recursive: true });
    for (const times of [[1_000, 1_001], [61_000, 61_001], [121_000, 121_001]]) {
      await runBackupAutomationCycle(context.config, context.wallet,
        successfulOptions(context.config, times));
    }
    const backups = readdirSync(context.config.backupRoot)
      .filter((name) => name.startsWith("backup-"));
    assert.equal(backups.length, 2);
    assert.equal(readdirSync(context.config.backupRoot)
      .some((name) => name.startsWith(".staging-")), false);
    const last = readBackupAutomationJournal(context.config).records.at(-1);
    assert.ok(backups.includes(last.payload.backupName));
  } finally { context.cleanup(); }
});

test("disk exhaustion is recorded without leaking the underlying path", async () => {
  const context = fixture();
  try {
    const options = successfulOptions(context.config);
    options.exportBackup = () => {
      const error = new Error(`/secret/operator/path: no space left`);
      error.code = "ENOSPC";
      throw error;
    };
    const record = await runBackupAutomationCycle(context.config, context.wallet, options);
    assert.equal(record.payload.errorCode, "storage-error");
    assert.equal(JSON.stringify(record).includes("/secret/operator/path"), false);
  } finally { context.cleanup(); }
});

test("health detects missed schedules and stale confirmed drills", async () => {
  const context = fixture();
  try {
    await runBackupAutomationCycle(context.config, context.wallet,
      successfulOptions(context.config, [1_000, 1_001]));
    const health = backupAutomationHealth(context.config, { now: 500_000 });
    assert.equal(health.healthy, false);
    assert.ok(health.reasons.includes("scheduled-run-missed"));
    assert.ok(health.reasons.includes("successful-drill-stale"));
  } finally { context.cleanup(); }
});

test("health CLI emits machine-readable JSON and a nonzero unhealthy exit", async () => {
  const context = fixture();
  try {
    const options = successfulOptions(context.config);
    options.restoreDrill = async () => { throw new Error("stale backup receipt"); };
    await runBackupAutomationCycle(context.config, context.wallet, options);
    const configPath = join(context.root, "automation.json");
    writeFileSync(configPath, `${JSON.stringify(context.config)}\n`);
    const result = spawnSync(process.execPath, [
      "blockchain/backup-automation-cli.mjs", "health", configPath,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 2);
    const status = JSON.parse(result.stdout);
    assert.equal(status.format, "nir-backup-automation-health-v1");
    assert.equal(status.healthy, false);
    assert.ok(status.reasons.includes("latest-run-failed"));
  } finally { context.cleanup(); }
});

test("scheduler uses the injected clock and does not repeat a completed slot", async () => {
  const context = fixture();
  try {
    const options = successfulOptions(context.config, [70_000, 70_001]);
    options.maximumRuns = 1;
    assert.equal(await runBackupAutomationScheduler(context.config, context.wallet, options), 1);
    const controller = new AbortController();
    const repeat = successfulOptions(context.config, [70_000, 70_001]);
    repeat.signal = controller.signal;
    repeat.sleep = async () => controller.abort();
    assert.equal(await runBackupAutomationScheduler(context.config, context.wallet, repeat), 0);
    assert.equal(readBackupAutomationJournal(context.config).records.length, 1);
  } finally { context.cleanup(); }
});

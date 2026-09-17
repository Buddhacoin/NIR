import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createBackupHttpServer,
  createBackupInventory,
  createSignedBackupReceipt,
  runRemoteBackupRestoreDrill,
  selectBackupReceipts,
  verifySignedBackupReceipt,
} from "../blockchain/backup-recovery.mjs";
import { exportBlockStoreBackup } from "../blockchain/block-store.mjs";
import { generateWallet, hashObject, publicWallet, signObject } from "../blockchain/crypto.mjs";
import { initializeDevnet, PersistentDevNode } from "../blockchain/node-store.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) { return new Promise((resolve) => server.close(resolve)); }

async function reserveSources(count) {
  const sources = [];
  for (let index = 0; index < count; index += 1) {
    const reservation = createServer();
    sources.push(await listen(reservation));
    await close(reservation);
  }
  return sources;
}

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "nir-backup-recovery-test-"));
  const live = join(temporary, "live");
  initializeDevnet(live);
  const node = new PersistentDevNode(live);
  node.faucet(generateWallet().address);
  const genesis = JSON.parse(readFileSync(join(live, "genesis.json"), "utf8"));
  const first = join(temporary, "backup-a");
  exportBlockStoreBackup(live, first, genesis);
  const second = join(temporary, "backup-b");
  cpSync(first, second, { recursive: true });
  const wallets = [generateWallet(), generateWallet(), generateWallet()];
  const trustedOperators = wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `backup-${index}`,
  }));
  return { first, genesis, live, second, temporary, trustedOperators, wallets };
}

test("independent signed receipts drive an isolated bounded restore drill", async () => {
  const context = fixture();
  const servers = [];
  try {
    const sources = await reserveSources(2);
    const receipts = [context.first, context.second].map((directory, index) =>
      createSignedBackupReceipt(directory, context.genesis, context.wallets[index], {
        createdAt: 1_000_000,
        operatorId: context.trustedOperators[index].operatorId,
        sourceId: sources[index],
      }));
    const serializedReceipts = JSON.stringify(receipts);
    assert.equal(serializedReceipts.includes("privateKeyMaterial"), false);
    assert.equal(serializedReceipts.includes("secretKey"), false);
    assert.equal(receipts[0].payload.privateKeysIncluded, false);
    assert.equal(receipts[0].payload.inventoryRoot, receipts[1].payload.inventoryRoot);
    for (let index = 0; index < 2; index += 1) {
      const server = createBackupHttpServer(
        index === 0 ? context.first : context.second, receipts[index],
      );
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        const url = new URL(sources[index]);
        server.listen(Number(url.port), url.hostname, resolve);
      });
    }
    const liveCheckpointBefore = readFileSync(join(context.live, "STORE-CHECKPOINT.json"), "utf8");
    writeFileSync(join(context.first, "STORE-CHECKPOINT.json"), "corrupt\n", "utf8");
    const workspaceParent = join(context.temporary, "drills");
    const result = await runRemoteBackupRestoreDrill(
      workspaceParent, sources, context.genesis, {
        allowInsecureLocalhost: true,
        now: 1_000_100,
        trustedOperators: context.trustedOperators,
      },
    );
    assert.equal(result.height, 1);
    assert.equal(result.privateKeysIncluded, false);
    assert.equal(result.sources.length, 2);
    assert.equal(result.downloadedFrom, sources[1], "a corrupt agreed source must be skipped");
    assert.equal(existsSync(join(result.workspace, "DEVNET-KEYS.json")), false);
    assert.equal(readFileSync(join(context.live, "STORE-CHECKPOINT.json"), "utf8"),
      liveCheckpointBefore, "the restore drill must not mutate live data");
    assert.deepEqual(await runRemoteBackupRestoreDrill(
      workspaceParent, sources, context.genesis, {
        allowInsecureLocalhost: true,
        now: 1_000_100,
        trustedOperators: context.trustedOperators,
      },
    ), result, "a completed crash-safe workspace must be reusable");
    writeFileSync(join(result.workspace, "STORE-CHECKPOINT.json"), "corrupt\n", "utf8");
    const repaired = await runRemoteBackupRestoreDrill(
      workspaceParent, sources, context.genesis, {
        allowInsecureLocalhost: true,
        now: 1_000_100,
        trustedOperators: context.trustedOperators,
      },
    );
    assert.notEqual(
      readFileSync(join(repaired.workspace, "STORE-CHECKPOINT.json"), "utf8"),
      "corrupt\n",
      "a completion marker must not bypass a fresh restore verification",
    );
  } finally {
    await Promise.all(servers.map(close));
    rmSync(context.temporary, { recursive: true, force: true });
  }
});

test("receipts reject staleness, operator reuse, conflicts, and private-key files", async () => {
  const context = fixture();
  try {
    const sources = ["https://backup-a.invalid", "https://backup-b.invalid"];
    const receipts = [context.first, context.second].map((directory, index) =>
      createSignedBackupReceipt(directory, context.genesis, context.wallets[index], {
        createdAt: 10_000,
        operatorId: context.trustedOperators[index].operatorId,
        sourceId: sources[index],
      }));
    assert.throws(() => verifySignedBackupReceipt(receipts[0], {
      maxAgeMs: 100, now: 10_101, trustedOperators: context.trustedOperators,
    }), /stale/);
    const reusedOperator = createSignedBackupReceipt(
      context.second, context.genesis, context.wallets[0], {
        createdAt: 10_000,
        operatorId: context.trustedOperators[0].operatorId,
        sourceId: sources[1],
      },
    );
    assert.throws(() => selectBackupReceipts([
      { receipt: receipts[0], source: sources[0] },
      { receipt: reusedOperator, source: sources[1] },
    ], { now: 10_001, trustedOperators: context.trustedOperators }), /independent/);

    const { receiptHash: _oldHash, ...changedPayload } = receipts[1].payload;
    changedPayload.inventoryRoot = "f".repeat(64);
    const receiptHash = hashObject(changedPayload, "REMOTE_BACKUP_RECEIPT");
    const conflict = {
      payload: { ...changedPayload, receiptHash },
      signature: signObject({ receiptHash }, context.wallets[1], "REMOTE_BACKUP_RECEIPT"),
      signer: publicWallet(context.wallets[1]),
    };
    assert.throws(() => selectBackupReceipts([
      { receipt: receipts[0], source: sources[0] },
      { receipt: conflict, source: sources[1] },
    ], { now: 10_001, trustedOperators: context.trustedOperators }), /conflicting/);

    writeFileSync(join(context.first, "DEVNET-KEYS.json"), "{}\n", "utf8");
    assert.throws(() => createBackupInventory(context.first), /disallowed/);
    rmSync(join(context.first, "DEVNET-KEYS.json"));

    const storedGenesis = readFileSync(join(context.first, "genesis.json"), "utf8");
    writeFileSync(join(context.first, "genesis.json"), JSON.stringify({
      ...context.genesis,
      privateKey: "must-never-enter-a-public-backup",
    }), "utf8");
    assert.throws(() => createSignedBackupReceipt(
      context.first, context.genesis, context.wallets[0], {
        createdAt: 10_000,
        operatorId: context.trustedOperators[0].operatorId,
        sourceId: sources[0],
      },
    ), /public genesis/);
    writeFileSync(join(context.first, "genesis.json"), storedGenesis, "utf8");
  } finally {
    rmSync(context.temporary, { recursive: true, force: true });
  }
});

test("a drill detects missing or corrupt agreed backup content", async () => {
  const context = fixture();
  const servers = [];
  try {
    const sources = await reserveSources(2);
    const receipts = [context.first, context.second].map((directory, index) =>
      createSignedBackupReceipt(directory, context.genesis, context.wallets[index], {
        createdAt: 20_000,
        operatorId: context.trustedOperators[index].operatorId,
        sourceId: sources[index],
      }));
    const paths = [context.first, context.second];
    for (let index = 0; index < 2; index += 1) {
      const server = createBackupHttpServer(paths[index], receipts[index]);
      servers.push(server);
      const url = new URL(sources[index]);
      await new Promise((resolve) => server.listen(Number(url.port), url.hostname, resolve));
    }
    for (const directory of paths) {
      writeFileSync(join(directory, "STORE-CHECKPOINT.json"), "corrupt\n", "utf8");
    }
    await assert.rejects(runRemoteBackupRestoreDrill(
      join(context.temporary, "failed-drill"), sources, context.genesis, {
        allowInsecureLocalhost: true,
        now: 20_001,
        trustedOperators: context.trustedOperators,
      },
    ), /no agreed backup source completed/);
  } finally {
    await Promise.all(servers.map(close));
    rmSync(context.temporary, { recursive: true, force: true });
  }
});

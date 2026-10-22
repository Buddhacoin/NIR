import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet } from "../blockchain/crypto.mjs";
import { initializeDevnet, PersistentDevNode } from "../blockchain/node-store.mjs";

// Opening a long devnet replayed every block on each start of NIR Майнер.
// It now starts from its own signed snapshot and replays only later blocks.
test("a devnet reopens from its snapshot to the same state and still serves old finality proofs", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-devnet-resume-"));
  try {
    const directory = join(temporary, "node");
    initializeDevnet(directory, { proofMining: true, proofMiningInitialLevel: 8 });
    const first = new PersistentDevNode(directory);
    // The first open replays the journal and saves a snapshot for next time.
    assert.ok(existsSync(join(directory, "DEVNET-RESUME.json")));
    const holder = generateWallet().address;
    first.faucet(holder);
    for (let i = 0; i < 4; i++) first.tick();

    const reopened = new PersistentDevNode(directory);
    assert.equal(reopened.height, first.height);
    assert.equal(reopened.tipHash, first.tipHash);
    assert.deepEqual(reopened.account(holder), first.account(holder));
    assert.deepEqual(reopened.proofMining(), first.proofMining());
    assert.deepEqual(reopened.nameRegistry(), first.nameRegistry());
    // Blocks before the snapshot are still there for a wallet syncing from genesis.
    assert.deepEqual(reopened.finalityProofsAfter(0, 3), first.finalityProofsAfter(0, 3));
    // It keeps working after the restart.
    reopened.tick();
    assert.equal(reopened.height, first.height + 1);

    // A damaged snapshot file only means a full replay.
    writeFileSync(join(directory, "DEVNET-RESUME.json"), "{}\n");
    const replayed = new PersistentDevNode(directory);
    assert.equal(replayed.tipHash, reopened.tipHash);
    assert.deepEqual(replayed.account(holder), reopened.account(holder));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

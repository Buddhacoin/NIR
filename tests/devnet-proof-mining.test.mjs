import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mineOneCliqueTask } from "../blockchain/clique-miner.mjs";
import { PROGRESS_REWARD_ESCROW_DELAY_BLOCKS, PROOF_MINING_PROTOCOL_VERSION } from "../blockchain/constants.mjs";
import { initializeDevnet, PersistentDevNode } from "../blockchain/node-store.mjs";
import { createWalletFile, signWalletProofAnswer } from "../blockchain/wallet-files.mjs";

test("a proof-mining devnet upgrades to v37, issues tasks from its own beacon, and pays a miner", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-devnet-proof-"));
  try {
    const directory = join(temporary, "node");
    const created = initializeDevnet(directory, { proofMining: true, proofMiningInitialLevel: 8 });
    assert.equal(created.protocolVersion, PROOF_MINING_PROTOCOL_VERSION);
    const node = new PersistentDevNode(directory);
    assert.equal(node.proofMiningEnabled, true);
    assert.equal(node.proofMining().openTasks.length, 0);
    node.tick();
    const [task] = node.proofMining().openTasks;
    assert.equal(task.level, 8);
    // Ticking again keeps the open task and only adds a block.
    const height = node.height;
    node.tick();
    assert.equal(node.height, height + 1);
    assert.equal(node.proofMining().openTasks.length, 1);

    const password = "devnet test password";
    const walletPath = join(temporary, "miner.wallet");
    const { address } = createWalletFile({ password, path: walletPath });
    const recipient = createWalletFile({ password, path: join(temporary, "reward.wallet") }).address;
    node.faucet(address);
    // Each health poll lets the devnet make progress, as its timer would.
    const client = {
      account: async (who) => node.account(who),
      health: async () => { node.tick(); return { height: node.height, networkId: node.networkId }; },
      proofMining: async () => node.proofMining(),
      submit: async (transaction) => node.submitTransaction(transaction),
    };
    const outcome = await mineOneCliqueTask({ address, client, pollMs: 0, recipient,
      sign: (operation) => signWalletProofAnswer({ operation, password, path: walletPath }) });
    assert.equal(outcome.result, "revealed");
    for (let i = 0; i <= PROGRESS_REWARD_ESCROW_DELAY_BLOCKS + 1; i++) node.tick();
    assert.ok(BigInt(node.account(recipient).atomicBalance) > 0n);
    // The node remembers which rewards the recipient received, for wallets.
    const [reward] = node.proofRewards(recipient);
    assert.equal(reward.amount, node.account(recipient).atomicBalance);
    assert.ok(reward.height > 0);
    assert.deepEqual(node.proofRewards(address), []);
    // A restarted node replays the stored chain to the same state.
    assert.deepEqual(new PersistentDevNode(directory).proofMining(), node.proofMining());
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("an ordinary devnet has no proof mining", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-devnet-plain-"));
  try {
    const directory = join(temporary, "node");
    initializeDevnet(directory);
    const node = new PersistentDevNode(directory);
    assert.equal(node.proofMiningEnabled, false);
    assert.equal(node.proofMining().active, false);
    assert.throws(() => node.upgradeTo(PROOF_MINING_PROTOCOL_VERSION), /no release keys/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

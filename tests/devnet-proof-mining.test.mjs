import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mineOneCliqueTask } from "../blockchain/clique-miner.mjs";
import { pioneerView } from "../blockchain/clique-mining-session.mjs";
import { createNetworkRelay } from "../blockchain/network-relay.mjs";
import { createDeveloperNodeHttpServer } from "../blockchain/node-service.mjs";
import { PROGRESS_REWARD_ESCROW_DELAY_BLOCKS, PROOF_MINING_PROTOCOL_VERSION } from "../blockchain/constants.mjs";
import { LATEST_DEVNET_PROTOCOL_VERSION } from "../blockchain/node-store.mjs";
import { initializeDevnet, PersistentDevNode } from "../blockchain/node-store.mjs";
import { createWalletFile, signWalletProofAnswer } from "../blockchain/wallet-files.mjs";

test("a proof-mining devnet upgrades to the latest version, issues tasks from its own beacon, and pays a miner", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-devnet-proof-"));
  try {
    const directory = join(temporary, "node");
    const created = initializeDevnet(directory, { proofMining: true, proofMiningInitialLevel: 8 });
    assert.equal(created.protocolVersion, LATEST_DEVNET_PROTOCOL_VERSION);
    assert.ok(LATEST_DEVNET_PROTOCOL_VERSION >= PROOF_MINING_PROTOCOL_VERSION);
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
    // A won reward still needs blocks to mature; once paid, an idle devnet needs none.
    assert.equal(node.hasPendingWork, true);
    for (let i = 0; i <= PROGRESS_REWARD_ESCROW_DELAY_BLOCKS + 1; i++) node.tick();
    assert.equal(node.hasPendingWork, false);
    assert.ok(BigInt(node.account(recipient).atomicBalance) > 0n);
    // The node remembers which rewards the recipient received, for wallets.
    const [reward] = node.proofRewards(recipient);
    assert.equal(reward.amount, node.account(recipient).atomicBalance);
    assert.ok(reward.height > 0);
    assert.deepEqual(node.proofRewards(address), []);
    // Pioneer points: every proof reward ever paid, against all others.
    const pioneer = node.pioneerPoints(recipient);
    assert.equal(pioneer.points, node.account(recipient).atomicBalance);
    assert.equal(pioneer.totalPoints, pioneer.points);
    assert.equal(pioneer.pioneers, 1);
    assert.equal(pioneer.poolNir, "210000");
    assert.equal(node.pioneerPoints(address).points, "0");
    assert.throws(() => node.pioneerPoints("nir1x"), /address is invalid/);
    // A restarted node replays the stored chain to the same state.
    assert.deepEqual(new PersistentDevNode(directory).proofMining(), node.proofMining());
    assert.deepEqual(new PersistentDevNode(directory).pioneerPoints(recipient), pioneer);
    // A resume file from before pioneer points rebuilds them by replaying blocks.
    const resumePath = join(directory, "DEVNET-RESUME.json");
    assert.equal(existsSync(resumePath), true);
    const resume = JSON.parse(readFileSync(resumePath, "utf8"));
    assert.ok(Array.isArray(resume.proofRewardTotals));
    delete resume.proofRewardTotals;
    writeFileSync(resumePath, JSON.stringify(resume));
    assert.deepEqual(new PersistentDevNode(directory).pioneerPoints(recipient), pioneer);
    // The node's HTTP API and the miner's relay both serve them.
    const server = createDeveloperNodeHttpServer(node);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/pioneers/${recipient}`);
      assert.deepEqual(await response.json(), pioneer);
      const relay = createNetworkRelay(`http://127.0.0.1:${server.address().port}`);
      await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
      try {
        const relayed = await fetch(`http://127.0.0.1:${relay.address().port}/v1/pioneers/${recipient}`);
        assert.deepEqual(await relayed.json(), pioneer);
      } finally { await new Promise((resolve) => relay.close(resolve)); }
    } finally { await new Promise((resolve) => server.close(resolve)); }
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

test("the miner shows pioneer points, today's share of 210,000 NIR and its estimate", () => {
  const view = pioneerView({ address: "nir1a", points: 1_320n * 100_000_000n, pioneers: 7,
    totalPoints: 4_400n * 100_000_000n });
  assert.equal(view.points, "1320.00000000 NIR");
  assert.equal(view.shareBasisPoints, 3000);
  assert.equal(view.estimate, "63000.00000000 NIR");
  assert.equal(view.pioneers, 7);
  assert.equal(pioneerView({ address: "nir1a", points: 0n, pioneers: 0, totalPoints: 0n }).shareBasisPoints, 0);
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { finalizeBlock, NirChain } from "../blockchain/chain.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import { initializeDistributedDevnet, ValidatorReplica } from "../blockchain/distributed-node.mjs";
import { createEpochRandomnessCommit } from "../blockchain/operators.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  const done = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await done;
}

test("local operator event survives restart, enters an event-only proposal, and expires at next height", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-operator-events-"));
  const beacons = Array.from({ length: 4 }, generateWallet);
  const layout = initializeDistributedDevnet(join(temporary, "network"), { beaconWallets: beacons });
  const directory = layout.validatorDirectories[0];
  let replica;
  try {
    replica = new ValidatorReplica(directory);
    const genesis = JSON.parse(readFileSync(join(directory, "genesis.json")));
    const chain = new NirChain(genesis);
    const status = chain.epochRandomnessStatus();
    const wallet = beacons.find(({ address }) => address === status.committee[0]);
    const commit = createEpochRandomnessCommit({
      wallet, networkId: chain.networkId, round: status.round,
      secret: "a".repeat(64),
    });
    const events = { epochRandomnessCommits: [commit] };
    assert.deepEqual(replica.stageOperatorEvents(events), { expectedHeight: 1, status: "queued" });
    assert.deepEqual(replica.stageOperatorEvents(events), { expectedHeight: 1, status: "known" });
    assert.throws(() => replica.stageOperatorEvents({ epochRandomnessCommits: [] }),
      /empty or too large/);
    assert.throws(() => replica.stageOperatorEvents({ epochRandomnessCommits: Array(5).fill(commit) }),
      /count is invalid/);
    assert.throws(() => replica.stageOperatorEvents({ rewardClaims: [{ padding: "x".repeat(65_536) }] }),
      /empty or too large/);
    assert.throws(() => replica.stageOperatorEvents({ rewardClaims: [{ ...commit }] }),
      /already staged/);
    replica.closeSecurityState();
    replica = new ValidatorReplica(directory);
    assert.equal(replica.pendingOperatorEvents.expectedHeight, 1);
    const proposal = replica.buildProposal();
    assert.equal(proposal.transactions.length, 0);
    assert.deepEqual(proposal.epochRandomnessCommits, [commit]);

    const validators = layout.validatorDirectories.map((path) =>
      JSON.parse(readFileSync(join(path, "VALIDATOR-KEY.json"))));
    const empty = chain.buildBlock({ transactions: [], timestamp: Date.now() });
    const signer = validators.find(({ address }) => address === empty.proposer);
    const quorum = [signer, ...validators.filter(({ address }) => address !== signer.address).slice(0, 2)];
    const finalized = finalizeBlock(empty, quorum);
    assert.equal(replica.commit(finalized).status, "committed");
    assert.equal(replica.pendingOperatorEvents, null);
    replica.closeSecurityState();
    replica = new ValidatorReplica(directory);
    assert.equal(replica.pendingOperatorEvents, null);
    assert.throws(() => replica.buildProposal(), /mempool is empty/);
  } finally {
    replica?.closeSecurityState();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("elected validator finalizes a staged event-only proposal without a coordinator", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-operator-events-network-"));
  const beacons = Array.from({ length: 4 }, generateWallet);
  const layout = initializeDistributedDevnet(join(temporary, "network"), { beaconWallets: beacons });
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  let urls = [];
  const servers = replicas.map((replica) => createValidatorHttpServer(replica, { peerUrls: () => urls }));
  try {
    urls = await Promise.all(servers.map(listen));
    const genesis = JSON.parse(readFileSync(join(layout.validatorDirectories[0], "genesis.json")));
    const chain = new NirChain(genesis);
    const status = chain.epochRandomnessStatus();
    const wallet = beacons.find(({ address }) => address === status.committee[0]);
    const commit = createEpochRandomnessCommit({
      wallet, networkId: chain.networkId, round: status.round,
      secret: "b".repeat(64),
    });
    const proposerIndex = replicas.findIndex(({ address }) =>
      address === chain.expectedProposer(chain.height + 1));
    assert.ok(proposerIndex >= 0);
    replicas[proposerIndex].stageOperatorEvents({ epochRandomnessCommits: [commit] });
    const produced = await fetch(`${urls[proposerIndex]}/v1/blocks/produce`, { method: "POST" });
    assert.equal(produced.status, 202);
    assert.equal((await produced.json()).committedPeers, 4);
    assert.deepEqual(replicas.map(({ height }) => height), [1, 1, 1, 1]);
    assert.equal(replicas[proposerIndex].pendingOperatorEvents, null);
    assert.deepEqual(replicas[0].blocksAfter(1)[0].epochRandomnessCommits, [commit]);
  } finally {
    await Promise.all(servers.map(close));
    replicas.forEach((replica) => replica.closeSecurityState());
    rmSync(temporary, { recursive: true, force: true });
  }
});

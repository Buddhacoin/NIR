import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTransfer } from "../blockchain/chain.mjs";
import { ATOMIC_UNITS } from "../blockchain/constants.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import {
  DistributedCoordinator,
  initializeDistributedDevnet,
  ValidatorReplica,
} from "../blockchain/distributed-node.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";

const UNREACHABLE = "http://127.0.0.1:1";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

function viewsFor(urls, groups) {
  const membership = new Map(groups.flatMap((group, groupIndex) =>
    group.map((validatorIndex) => [validatorIndex, groupIndex])));
  return urls.map((_, source) => urls.map((url, target) =>
    membership.get(source) === membership.get(target) ? url : UNREACHABLE));
}

async function createNetwork(prefix) {
  const temporary = mkdtempSync(join(tmpdir(), prefix));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  let views = [];
  const servers = replicas.map((replica, index) => createValidatorHttpServer(replica, {
    peerUrls: () => views[index],
    roundTimeoutMs: 10,
    maxRoundTimeoutMs: 40,
  }));
  const urls = await Promise.all(servers.map(listen));
  views = urls.map(() => [...urls]);
  return {
    cleanup: async () => {
      await Promise.all(servers.map(close));
      rmSync(temporary, { recursive: true, force: true });
    },
    coordinator: new DistributedCoordinator(layout.coordinatorDirectory, urls),
    replicas,
    setViews(next) { views = next; },
    urls,
  };
}

async function fundAndQueue(network) {
  const alice = generateWallet();
  const bob = generateWallet();
  await network.coordinator.faucet(alice.address);
  const transaction = createTransfer({
    amount: ATOMIC_UNITS.toString(),
    networkId: network.coordinator.networkId,
    nonce: 0,
    recipient: bob.address,
    wallet: alice,
  });
  const response = await fetch(`${network.urls[0]}/v1/transactions`, {
    body: JSON.stringify(transaction),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 202);
  return { bob, transaction };
}

test("a two-two partition cannot finalize either competing view and recovers after healing", async () => {
  const network = await createNetwork("nir-even-partition-test-");
  try {
    const { bob } = await fundAndQueue(network);
    const proposer = network.replicas[0].expectedProposer(2, 0);
    const proposerIndex = network.replicas.findIndex(({ address }) => address === proposer);
    const partnerIndex = (proposerIndex + 1) % 4;
    const firstGroup = [proposerIndex, partnerIndex];
    const secondGroup = [0, 1, 2, 3].filter((index) => !firstGroup.includes(index));
    network.setViews(viewsFor(network.urls, [firstGroup, secondGroup]));

    const firstAttempt = await fetch(`${network.urls[proposerIndex]}/v1/blocks/produce`, {
      method: "POST",
    });
    assert.equal(firstAttempt.status, 400);
    assert.match((await firstAttempt.json()).error, /finality quorum not reached/);
    const secondAttempt = await fetch(`${network.urls[secondGroup[0]]}/v1/blocks/produce`, {
      method: "POST",
    });
    assert.equal(secondAttempt.status, 400);
    assert.match((await secondAttempt.json()).error, /timeout quorum not reached/);
    assert.deepEqual(network.replicas.map(({ height }) => height), [1, 1, 1, 1]);
    assert.equal(new Set(network.replicas.map(({ tipHash }) => tipHash)).size, 1);

    network.setViews(network.urls.map(() => [...network.urls]));
    const healed = await fetch(`${network.urls[proposerIndex]}/v1/blocks/produce`, {
      method: "POST",
    });
    assert.equal(healed.status, 202);
    assert.equal((await healed.json()).height, 2);
    assert.deepEqual(network.replicas.map(({ height }) => height), [2, 2, 2, 2]);
    assert.equal(new Set(network.replicas.map(({ tipHash }) => tipHash)).size, 1);
    assert.equal(network.replicas[0].account(bob.address).atomicBalance, ATOMIC_UNITS.toString());
  } finally {
    await network.cleanup();
  }
});

test("a three-one partition finalizes once and the isolated validator catches up", async () => {
  const network = await createNetwork("nir-majority-partition-test-");
  try {
    const { bob } = await fundAndQueue(network);
    const proposer = network.replicas[0].expectedProposer(2, 0);
    const proposerIndex = network.replicas.findIndex(({ address }) => address === proposer);
    const isolatedIndex = network.replicas.findIndex((_, index) => index !== proposerIndex);
    const majority = [0, 1, 2, 3].filter((index) => index !== isolatedIndex);
    network.setViews(viewsFor(network.urls, [majority, [isolatedIndex]]));

    const finalized = await fetch(`${network.urls[proposerIndex]}/v1/blocks/produce`, {
      method: "POST",
    });
    assert.equal(finalized.status, 202);
    const result = await finalized.json();
    assert.equal(result.votes, 3);
    assert.equal(result.committedPeers, 3);
    assert.equal(network.replicas[isolatedIndex].height, 1);
    assert.ok(majority.every((index) => network.replicas[index].height === 2));

    const isolatedAttempt = await fetch(`${network.urls[isolatedIndex]}/v1/blocks/produce`, {
      method: "POST",
    });
    assert.equal(isolatedAttempt.status, 400);
    assert.equal(network.replicas[isolatedIndex].height, 1);

    network.setViews(network.urls.map(() => [...network.urls]));
    const synchronized = await fetch(`${network.urls[isolatedIndex]}/v1/sync`, { method: "POST" });
    assert.equal(synchronized.status, 200);
    assert.equal((await synchronized.json()).height, 2);
    assert.equal(new Set(network.replicas.map(({ tipHash }) => tipHash)).size, 1);
    assert.equal(network.replicas[isolatedIndex].account(bob.address).atomicBalance,
      ATOMIC_UNITS.toString());
  } finally {
    await network.cleanup();
  }
});

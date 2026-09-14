import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTransfer, NirChain } from "../blockchain/chain.mjs";
import { ATOMIC_UNITS } from "../blockchain/constants.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import {
  DistributedCoordinator,
  initializeDistributedDevnet,
  ValidatorReplica,
} from "../blockchain/distributed-node.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";

async function listen(server, port = 0) {
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (server.listening) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await closed;
  }
}

test("independent HTTP validator replicas finalize with one peer offline", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-distributed-test-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  const servers = replicas.map(createValidatorHttpServer);
  try {
    const urls = await Promise.all(servers.map((server) => listen(server)));
    let coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    const unsigned = await fetch(`${urls[0]}/v1/blocks`, {
      body: JSON.stringify({ payload: {} }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(unsigned.status, 400);
    assert.match((await unsigned.json()).error, /authentication is required/);
    const alice = generateWallet();
    const bob = generateWallet();
    const funded = await coordinator.faucet(alice.address);
    assert.equal(funded.votes, 4);
    assert.equal(funded.committedPeers, 4);

    const transfer = createTransfer({
      amount: (2n * ATOMIC_UNITS).toString(), networkId: coordinator.networkId,
      nonce: 0, recipient: bob.address, wallet: alice,
    });
    assert.throws(() => coordinator.submitTransaction({
      ...transfer, amount: (3n * ATOMIC_UNITS).toString(),
    }), /invalid transaction signature/);
    assert.equal(coordinator.mempoolSize, 0);
    assert.equal(coordinator.submitTransaction(transfer).status, "queued");
    assert.equal(coordinator.mempoolSize, 1);

    const genesis = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "genesis.json"), "utf8"));
    const mirror = new NirChain(genesis);
    const firstBlock = JSON.parse(readFileSync(
      join(layout.coordinatorDirectory, "blocks", "000000000001.json"), "utf8"));
    mirror.appendBlock(firstBlock);
    const forged = { ...transfer, amount: (3n * ATOMIC_UNITS).toString() };
    const invalidProposal = mirror.buildBlock({
      timestamp: firstBlock.timestamp + 1,
      transactions: [forged],
    });
    assert.throws(() => replicas[0].vote(invalidProposal), /invalid transaction signature/);
    const nextProposer = mirror.expectedProposer(2);
    const offlineIndex = replicas.findIndex(({ address }) => address !== nextProposer);
    await close(servers[offlineIndex]);

    const finalized = await coordinator.produceBlock();
    assert.equal(finalized.votes, 3);
    assert.equal(finalized.committedPeers, 3);
    assert.equal(coordinator.account(bob.address).atomicBalance, (2n * ATOMIC_UNITS).toString());
    assert.equal(coordinator.mempoolSize, 0);

    replicas[offlineIndex] = new ValidatorReplica(layout.validatorDirectories[offlineIndex]);
    servers[offlineIndex] = createValidatorHttpServer(replicas[offlineIndex]);
    urls[offlineIndex] = await listen(servers[offlineIndex]);
    coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    const secondTransfer = createTransfer({
      amount: ATOMIC_UNITS.toString(), networkId: coordinator.networkId,
      nonce: 1, recipient: bob.address, wallet: alice,
    });
    coordinator.submitTransaction(secondTransfer);
    const caughtUp = await coordinator.produceBlock();
    assert.equal(caughtUp.synchronizedPeers, 1);
    assert.equal(caughtUp.votes, 4);
    assert.equal(replicas[offlineIndex].height, 3);
    assert.equal(coordinator.account(bob.address).atomicBalance, (3n * ATOMIC_UNITS).toString());

    coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    assert.equal(coordinator.height, 3);
    assert.equal(coordinator.account(bob.address).atomicBalance, (3n * ATOMIC_UNITS).toString());
  } finally {
    await Promise.all(servers.map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a validator persists its vote and refuses restart equivocation", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-validator-vote-test-"));
  try {
    const layout = initializeDistributedDevnet(join(temporary, "network"));
    let replica = new ValidatorReplica(layout.validatorDirectories[0]);
    const genesis = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "genesis.json"), "utf8"));
    const chain = new NirChain(genesis);
    const first = chain.buildBlock({ timestamp: 1 });
    const second = chain.buildBlock({ timestamp: 2 });
    replica.vote(first);
    assert.throws(() => replica.vote(second), /refuses to equivocate/);
    const timeout = replica.timeout({ proposal: first, nextRound: 1 });
    assert.equal(timeout.validator, replica.address);
    assert.throws(() => replica.timeout({ proposal: second, nextRound: 1 }),
      /unlock a different block value/);
    replica = new ValidatorReplica(layout.validatorDirectories[0]);
    assert.throws(() => replica.vote(second), /refuses to equivocate/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a quorum timeout safely replaces an offline proposer", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-round-failover-test-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  const servers = replicas.map(createValidatorHttpServer);
  try {
    const urls = await Promise.all(servers.map((server) => listen(server)));
    const coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    const alice = generateWallet();
    const bob = generateWallet();
    await coordinator.faucet(alice.address);
    const genesis = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "genesis.json"), "utf8"));
    const mirror = new NirChain(genesis);
    mirror.appendBlock(JSON.parse(readFileSync(
      join(layout.coordinatorDirectory, "blocks", "000000000001.json"), "utf8")));
    const offlineProposer = mirror.expectedProposer(2, 0);
    const offlineIndex = replicas.findIndex(({ address }) => address === offlineProposer);
    await close(servers[offlineIndex]);
    coordinator.submitTransaction(createTransfer({
      amount: ATOMIC_UNITS.toString(), networkId: coordinator.networkId,
      nonce: 0, recipient: bob.address, wallet: alice,
    }));
    const finalized = await coordinator.produceBlock();
    assert.equal(finalized.round, 1);
    assert.equal(finalized.votes, 3);
    const block = JSON.parse(readFileSync(
      join(layout.coordinatorDirectory, "blocks", "000000000002.json"), "utf8"));
    assert.equal(block.proposer, mirror.expectedProposer(2, 1));
    assert.equal(block.roundCertificate.length, 3);
    assert.equal(coordinator.account(bob.address).atomicBalance, ATOMIC_UNITS.toString());
  } finally {
    await Promise.all(servers.map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("the same block value survives two failed proposer rounds", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-multiround-test-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  const servers = replicas.map((replica) => createValidatorHttpServer(replica, {
    shouldRejectProposal: (proposal) => proposal.round < 2 && proposal.proposer === replica.address,
  }));
  try {
    const urls = await Promise.all(servers.map((server) => listen(server)));
    const coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    const recipient = generateWallet();
    const finalized = await coordinator.faucet(recipient.address);
    assert.equal(finalized.round, 2);
    assert.equal(finalized.votes, 4);
    assert.equal(finalized.committedPeers, 4);
    const block = JSON.parse(readFileSync(
      join(layout.coordinatorDirectory, "blocks", "000000000001.json"), "utf8"));
    assert.equal(block.round, 2);
    assert.equal(block.roundCertificate.length, 4);
    assert.equal(coordinator.account(recipient.address).atomicBalance, (10n * ATOMIC_UNITS).toString());
  } finally {
    await Promise.all(servers.map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});

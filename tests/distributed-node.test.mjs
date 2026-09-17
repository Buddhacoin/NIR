import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { blockHash, createTransfer, finalizeBlock, NirChain, transactionId } from "../blockchain/chain.mjs";
import { ATOMIC_UNITS } from "../blockchain/constants.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import {
  DistributedCoordinator,
  initializeDistributedDevnet,
  ValidatorReplica,
} from "../blockchain/distributed-node.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";
import { createNodeHttpServer } from "../blockchain/node-service.mjs";
import { verifyAccountProof } from "../blockchain/account-proof.mjs";

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
    await assert.rejects(() => coordinator.submitTransaction({
      ...transfer, amount: (3n * ATOMIC_UNITS).toString(),
    }), /invalid transaction signature/);
    assert.equal(coordinator.mempoolSize, 0);
    const queued = await coordinator.submitTransaction(transfer);
    assert.equal(queued.status, "queued");
    assert.equal(queued.relayedPeers, 4);
    assert.deepEqual(replicas.map(({ mempoolSize }) => mempoolSize), [1, 1, 1, 1]);
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

    coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    assert.equal(coordinator.mempoolSize, 0);
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
    await coordinator.submitTransaction(secondTransfer);
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

test("validators independently attest one snapshot and the coordinator stages its quorum", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-distributed-snapshot-test-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  const servers = replicas.map(createValidatorHttpServer);
  let coordinatorServer = null;
  try {
    const urls = await Promise.all(servers.map((server) => listen(server)));
    const unsigned = await fetch(`${urls[0]}/v1/snapshots/candidate`, {
      body: JSON.stringify({ payload: {} }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(unsigned.status, 400);
    assert.match((await unsigned.json()).error, /authentication is required/);

    let coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    coordinatorServer = createNodeHttpServer(coordinator);
    const coordinatorUrl = await listen(coordinatorServer);
    const response = await fetch(`${coordinatorUrl}/v1/snapshots/create`, { method: "POST" });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.height, 0);
    assert.equal(result.signedValidators, 4);
    assert.equal(result.synchronizedValidators, 4);
    const primary = join(layout.coordinatorDirectory, "snapshots", "STATE-SNAPSHOT.json");
    const backup = join(layout.coordinatorDirectory, "snapshots", "STATE-SNAPSHOT.backup.json");
    assert.equal(existsSync(primary), true);
    assert.equal(readFileSync(primary, "utf8"), readFileSync(backup, "utf8"));
    assert.equal(JSON.parse(readFileSync(primary, "utf8")).attestations.length, 4);

    await close(servers[3]);
    coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    const degraded = await coordinator.createSnapshot();
    assert.equal(degraded.snapshotHash, result.snapshotHash);
    assert.equal(degraded.signedValidators, 3);
    assert.equal(degraded.synchronizedValidators, 3);
  } finally {
    if (coordinatorServer) await close(coordinatorServer);
    await Promise.all(servers.map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("validators independently attest an account proof with one peer offline", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-distributed-account-proof-test-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  const servers = replicas.map(createValidatorHttpServer);
  try {
    const urls = await Promise.all(servers.map((server) => listen(server)));
    const account = generateWallet();
    let coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    assert.deepEqual(await coordinator.validatorHandoffHistory(), {
      handoffs: [], matchingSources: 5,
    });
    await coordinator.faucet(account.address);
    await close(servers[3]);
    coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    assert.deepEqual(await coordinator.validatorHandoffHistory(), {
      handoffs: [], matchingSources: 4,
    });
    const proof = await coordinator.accountProof(account.address);
    const genesis = JSON.parse(readFileSync(
      join(layout.coordinatorDirectory, "genesis.json"), "utf8",
    ));
    const verified = verifyAccountProof(proof, {
      expectedAddress: account.address,
      expectedNetworkId: coordinator.networkId,
      minimumHeight: coordinator.height,
      trustedValidators: genesis.validators,
    });
    assert.equal(verified.account.atomicBalance, (10n * ATOMIC_UNITS).toString());
    assert.equal(proof.attestations.length, 3);
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
    const peers = layout.validatorDirectories.slice(1, 3)
      .map((directory) => new ValidatorReplica(directory));
    const alternatePeer = new ValidatorReplica(layout.validatorDirectories[3]);
    const prepares = [replica.vote(first), ...peers.map((peer) => peer.vote(first))];
    assert.equal(replica.lockedProposal(), null);
    const prepareCertificate = replica.prepareCertificate(first, prepares);
    replica.commitVote(first, prepareCertificate);
    const lock = replica.lockedProposal();
    assert.equal(blockHash(replica.validateLockedProposal(lock, replica.address).proposal), blockHash(first));
    assert.throws(() => replica.validateLockedProposal({
      ...lock, proposal: { ...lock.proposal, timestamp: 2 },
    }, replica.address), /lock proof is invalid|not deterministic/);
    const alternateCertificate = replica.prepareCertificate(first, [
      replica.vote(first), peers[0].vote(first), alternatePeer.vote(first),
    ]);
    const alternateCommit = replica.commitVote(first, alternateCertificate);
    assert.notEqual(alternateCommit.signature, lock.vote.signature);
    assert.equal(blockHash(replica.validateLockedProposal(
      replica.lockedProposal(), replica.address,
    ).proposal), blockHash(first));
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

test("a validator persists its round timer across restart", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-validator-pacemaker-test-"));
  try {
    const layout = initializeDistributedDevnet(join(temporary, "network"));
    let replica = new ValidatorReplica(layout.validatorDirectories[0]);
    const genesis = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "genesis.json"), "utf8"));
    const proposal = new NirChain(genesis).buildBlock({ timestamp: 1 });
    const request = { proposal, nextRound: 1 };
    assert.equal(replica.observeRoundTimeout(request, 100, 1_000), 100);
    replica = new ValidatorReplica(layout.validatorDirectories[0]);
    assert.equal(replica.observeRoundTimeout(request, 100, 1_040), 60);
    assert.equal(replica.observeRoundTimeout(request, 100, 1_100), 0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("split prepares do not deadlock the next certified round", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-split-prepare-test-"));
  try {
    const layout = initializeDistributedDevnet(join(temporary, "network"));
    const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
    const genesis = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "genesis.json"), "utf8"));
    const chain = new NirChain(genesis);
    const first = chain.buildBlock({ timestamp: 1 });
    const competing = chain.buildBlock({ timestamp: 2 });

    replicas[0].vote(first);
    replicas[1].vote(first);
    replicas[2].vote(competing);
    assert.ok(replicas.slice(0, 3).every((replica) => replica.lockedProposal() === null));

    const timeouts = replicas.slice(0, 3).map((replica) =>
      replica.timeout({ proposal: first, nextRound: 1 }));
    const advanced = replicas[0].advanceProposal(first, 1, timeouts);
    const prepares = replicas.slice(0, 3).map((replica) => replica.vote(advanced));
    const prepareCertificate = replicas[0].prepareCertificate(advanced, prepares);
    const commits = replicas.slice(0, 3).map((replica) =>
      replica.commitVote(advanced, prepareCertificate));
    const finalized = replicas[0].finalizeProposal(advanced, prepareCertificate, commits);

    assert.equal(finalized.round, 1);
    assert.equal(finalized.prepareCertificate.length, 3);
    assert.equal(finalized.certificate.length, 3);
    assert.equal(blockHash(finalized), blockHash(first));
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
    await coordinator.submitTransaction(createTransfer({
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

test("one validator ingress gossips and persists a transaction for coordinator recovery", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-gossip-test-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  let urls = [];
  const servers = replicas.map((replica) => createValidatorHttpServer(replica, {
    peerUrls: () => urls,
  }));
  try {
    urls = await Promise.all(servers.map((server) => listen(server)));
    let coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    const alice = generateWallet();
    const bob = generateWallet();
    await coordinator.faucet(alice.address);
    const transaction = createTransfer({
      amount: ATOMIC_UNITS.toString(), networkId: coordinator.networkId,
      nonce: 0, recipient: bob.address, wallet: alice,
    });
    const response = await fetch(`${urls[0]}/v1/transactions`, {
      body: JSON.stringify(transaction), headers: { "content-type": "application/json" }, method: "POST",
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).gossipedPeers, 3);
    assert.deepEqual(replicas.map(({ mempoolSize }) => mempoolSize), [1, 1, 1, 1]);
    const restartedReplica = new ValidatorReplica(layout.validatorDirectories[1]);
    assert.equal(restartedReplica.mempoolSize, 1);

    coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    assert.equal(coordinator.mempoolSize, 0);
    const finalized = await coordinator.produceBlock();
    assert.equal(finalized.height, 2);
    assert.equal(coordinator.account(bob.address).atomicBalance, ATOMIC_UNITS.toString());
    assert.deepEqual(replicas.map(({ mempoolSize }) => mempoolSize), [0, 0, 0, 0]);
  } finally {
    await Promise.all(servers.map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("the elected validator assembles and finalizes a block without the coordinator", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-validator-producer-test-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  let urls = [];
  const servers = replicas.map((replica) => createValidatorHttpServer(replica, {
    peerUrls: () => urls,
  }));
  try {
    urls = await Promise.all(servers.map((server) => listen(server)));
    const coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    const alice = generateWallet();
    const bob = generateWallet();
    await coordinator.faucet(alice.address);
    const transaction = createTransfer({
      amount: ATOMIC_UNITS.toString(), networkId: coordinator.networkId,
      nonce: 0, recipient: bob.address, wallet: alice,
    });
    const ingress = await fetch(`${urls[0]}/v1/transactions`, {
      body: JSON.stringify(transaction), headers: { "content-type": "application/json" }, method: "POST",
    });
    assert.equal(ingress.status, 202);
    const proposer = replicas[0].expectedProposer();
    const proposerIndex = replicas.findIndex(({ address }) => address === proposer);
    const nonProposerIndex = (proposerIndex + 1) % replicas.length;
    const rejected = await fetch(`${urls[nonProposerIndex]}/v1/blocks/produce`, { method: "POST" });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /not the proposer/);
    const prematureProposal = replicas[nonProposerIndex].buildProposal();
    const timeoutPayload = { proposal: prematureProposal, nextRound: 1 };
    const timeoutAuth = replicas[nonProposerIndex]
      .createValidatorRequest("/v1/p2p/timeouts", timeoutPayload);
    const timeoutTarget = [0, 1, 2, 3]
      .find((index) => index !== nonProposerIndex && index !== proposerIndex);
    const prematureTimeout = await fetch(`${urls[timeoutTarget]}/v1/p2p/timeouts`, {
      body: JSON.stringify({ auth: timeoutAuth, payload: timeoutPayload }),
      headers: { "content-type": "application/json" }, method: "POST",
    });
    assert.equal(prematureTimeout.status, 400);
    assert.match((await prematureTimeout.json()).error, /proposer is reachable/);

    const produced = await fetch(`${urls[proposerIndex]}/v1/blocks/produce`, { method: "POST" });
    assert.equal(produced.status, 202);
    const result = await produced.json();
    assert.equal(result.height, 2);
    assert.equal(result.votes, 4);
    assert.equal(result.committedPeers, 4);
    assert.deepEqual(replicas.map(({ height }) => height), [2, 2, 2, 2]);
    assert.deepEqual(replicas.map(({ mempoolSize }) => mempoolSize), [0, 0, 0, 0]);
    assert.equal(replicas[0].account(bob.address).atomicBalance, ATOMIC_UNITS.toString());
  } finally {
    await Promise.all(servers.map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a restarted validator catches up from authenticated validator peers", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-validator-sync-test-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  let urls = [];
  const servers = replicas.map((replica) => createValidatorHttpServer(replica, {
    peerUrls: () => urls,
  }));
  try {
    urls = await Promise.all(servers.map((server) => listen(server)));
    const coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    const alice = generateWallet();
    const bob = generateWallet();
    await coordinator.faucet(alice.address);
    const transaction = createTransfer({
      amount: ATOMIC_UNITS.toString(), networkId: coordinator.networkId,
      nonce: 0, recipient: bob.address, wallet: alice,
    });
    const ingress = await fetch(`${urls[0]}/v1/transactions`, {
      body: JSON.stringify(transaction), headers: { "content-type": "application/json" }, method: "POST",
    });
    assert.equal(ingress.status, 202);

    const proposer = replicas[0].expectedProposer();
    const proposerIndex = replicas.findIndex(({ address }) => address === proposer);
    const offlineIndex = replicas.findIndex(({ address }, index) =>
      index !== proposerIndex && address !== proposer);
    await close(servers[offlineIndex]);

    const produced = await fetch(`${urls[proposerIndex]}/v1/blocks/produce`, { method: "POST" });
    assert.equal(produced.status, 202);
    const result = await produced.json();
    assert.equal(result.height, 2);
    assert.equal(result.votes, 3);
    assert.equal(result.committedPeers, 3);
    assert.equal(replicas[offlineIndex].height, 1);

    replicas[offlineIndex] = new ValidatorReplica(layout.validatorDirectories[offlineIndex]);
    servers[offlineIndex] = createValidatorHttpServer(replicas[offlineIndex], {
      peerUrls: () => urls,
    });
    urls[offlineIndex] = await listen(servers[offlineIndex]);
    const synchronized = await fetch(`${urls[offlineIndex]}/v1/sync`, { method: "POST" });
    assert.equal(synchronized.status, 200);
    const syncResult = await synchronized.json();
    assert.equal(syncResult.syncedBlocks, 1);
    assert.equal(syncResult.height, 2);
    assert.equal(replicas[offlineIndex].mempoolSize, 0);
    assert.equal(replicas[offlineIndex].account(bob.address).atomicBalance, ATOMIC_UNITS.toString());
  } finally {
    await Promise.all(servers.map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a far-behind validator fast-syncs from a quorum snapshot before tail replay", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-validator-fast-sync-test-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  const wallets = layout.validatorDirectories.map((directory) =>
    JSON.parse(readFileSync(join(directory, "VALIDATOR-KEY.json"), "utf8")));
  const genesis = JSON.parse(readFileSync(
    join(layout.coordinatorDirectory, "genesis.json"), "utf8",
  ));
  const source = new NirChain(genesis);
  for (let height = 1; height <= 17; height += 1) {
    const block = finalizeBlock(source.buildBlock({ timestamp: height }), wallets);
    source.appendBlock(block);
    for (const replica of replicas.slice(0, 3)) replica.commit(block);
  }
  assert.throws(() => replicas[3].installStateSnapshotCandidates([
    replicas[0].stateSnapshotCandidate(), replicas[1].stateSnapshotCandidate(),
  ]), /candidate quorum is not reached/);
  assert.equal(replicas[3].height, 0);
  let urls = [];
  const servers = replicas.map((replica) => createValidatorHttpServer(replica, {
    peerUrls: () => urls,
  }));
  try {
    urls = await Promise.all(servers.map((server) => listen(server)));
    const response = await fetch(`${urls[3]}/v1/sync`, { method: "POST" });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.snapshotHeight, 17);
    assert.equal(result.syncedBlocks, 0);
    assert.equal(result.tipHash, source.tipHash);
    assert.equal(replicas[3].height, 17);
    assert.equal(existsSync(join(
      layout.validatorDirectories[3], "snapshots", "STATE-SNAPSHOT.json",
    )), true);

    const restarted = new ValidatorReplica(layout.validatorDirectories[3]);
    assert.equal(restarted.height, 17);
    assert.equal(restarted.tipHash, source.tipHash);
  } finally {
    await Promise.all(servers.map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("validators replace an offline proposer without coordinator consensus calls", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-validator-failover-test-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  let urls = [];
  const servers = replicas.map((replica) => createValidatorHttpServer(replica, {
    peerUrls: () => urls,
    roundTimeoutMs: 10,
    maxRoundTimeoutMs: 40,
  }));
  try {
    urls = await Promise.all(servers.map((server) => listen(server)));
    const coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    const alice = generateWallet();
    const bob = generateWallet();
    await coordinator.faucet(alice.address);
    const transaction = createTransfer({
      amount: ATOMIC_UNITS.toString(), networkId: coordinator.networkId,
      nonce: 0, recipient: bob.address, wallet: alice,
    });
    const ingress = await fetch(`${urls[0]}/v1/transactions`, {
      body: JSON.stringify(transaction), headers: { "content-type": "application/json" }, method: "POST",
    });
    assert.equal(ingress.status, 202);

    const roundZeroProposer = replicas[0].expectedProposer(2, 0);
    const roundOneProposer = replicas[0].expectedProposer(2, 1);
    const offlineIndex = replicas.findIndex(({ address }) => address === roundZeroProposer);
    const replacementIndex = replicas.findIndex(({ address }) => address === roundOneProposer);
    const initiatorIndex = replicas.findIndex((_, index) =>
      index !== offlineIndex && index !== replacementIndex);
    await close(servers[offlineIndex]);

    const produced = await fetch(`${urls[initiatorIndex]}/v1/blocks/produce`, { method: "POST" });
    assert.equal(produced.status, 202);
    const result = await produced.json();
    assert.equal(result.height, 2);
    assert.equal(result.round, 1);
    assert.equal(result.votes, 3);
    assert.equal(result.committedPeers, 3);
    assert.equal(replicas[offlineIndex].height, 1);
    assert.ok(replicas.every(({ height }, index) => index === offlineIndex || height === 2));
    const committed = replicas[replacementIndex].blocksAfter(2, 1)[0];
    assert.equal(committed.proposer, roundOneProposer);
    assert.equal(committed.roundCertificate.length, 3);
    assert.equal(replicas[initiatorIndex].account(bob.address).atomicBalance, ATOMIC_UNITS.toString());
  } finally {
    await Promise.all(servers.map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a replacement proposer recovers a partially voted value from peer locks", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-validator-lock-recovery-test-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  let urls = [];
  const servers = replicas.map((replica) => createValidatorHttpServer(replica, {
    peerUrls: () => urls,
    roundTimeoutMs: 10,
    maxRoundTimeoutMs: 40,
  }));
  try {
    urls = await Promise.all(servers.map((server) => listen(server)));
    const coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    const alice = generateWallet();
    const bob = generateWallet();
    const charlie = generateWallet();
    await coordinator.faucet(alice.address);
    const first = createTransfer({
      amount: ATOMIC_UNITS.toString(), networkId: coordinator.networkId,
      nonce: 0, recipient: bob.address, wallet: alice,
    });
    const ingress = await fetch(`${urls[0]}/v1/transactions`, {
      body: JSON.stringify(first), headers: { "content-type": "application/json" }, method: "POST",
    });
    assert.equal(ingress.status, 202);

    const roundZeroProposer = replicas[0].expectedProposer(2, 0);
    const roundOneProposer = replicas[0].expectedProposer(2, 1);
    const offlineIndex = replicas.findIndex(({ address }) => address === roundZeroProposer);
    const replacementIndex = replicas.findIndex(({ address }) => address === roundOneProposer);
    const initiatorIndex = replicas.findIndex((_, index) =>
      index !== offlineIndex && index !== replacementIndex);
    const lockPeerIndex = replicas.findIndex((_, index) =>
      index !== offlineIndex && index !== replacementIndex && index !== initiatorIndex);
    const locked = replicas[offlineIndex].buildProposal();
    const prepares = [offlineIndex, replacementIndex, lockPeerIndex]
      .map((index) => replicas[index].vote(locked));
    const prepareCertificate = replicas[replacementIndex].prepareCertificate(locked, prepares);
    replicas[replacementIndex].commitVote(locked, prepareCertificate);
    replicas[lockPeerIndex].commitVote(locked, prepareCertificate);
    await close(servers[offlineIndex]);

    const conflictingLocalTransaction = createTransfer({
      amount: ATOMIC_UNITS.toString(), networkId: coordinator.networkId,
      nonce: 1, recipient: charlie.address, wallet: alice,
    });
    replicas[initiatorIndex].submitTransaction(conflictingLocalTransaction);
    const produced = await fetch(`${urls[initiatorIndex]}/v1/blocks/produce`, { method: "POST" });
    const result = await produced.json();
    assert.equal(produced.status, 202, result.error);
    assert.equal(result.round, 1);
    const block = replicas[replacementIndex].blocksAfter(2, 1)[0];
    assert.equal(blockHash(block), blockHash(locked));
    assert.equal(block.transactions.length, 1);
    assert.equal(transactionId(block.transactions[0]), transactionId(first));
    assert.equal(replicas[initiatorIndex].mempoolSize, 1);
    assert.equal(replicas[initiatorIndex].account(bob.address).atomicBalance, ATOMIC_UNITS.toString());
    assert.equal(replicas[initiatorIndex].account(charlie.address).atomicBalance, "0");
  } finally {
    await Promise.all(servers.map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});

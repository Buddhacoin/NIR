import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync,
  symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTransfer, finalizeBlock, NirChain } from "../blockchain/chain.mjs";
import { ATOMIC_UNITS } from "../blockchain/constants.mjs";
import { canonicalJson, generateWallet } from "../blockchain/crypto.mjs";
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
  let competing;
  try {
    replica = new ValidatorReplica(directory);
    competing = new ValidatorReplica(directory);
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
    const journal = join(directory, "OPERATOR-EVENTS.json");
    assert.equal(readFileSync(journal, "utf8"), `${canonicalJson(replica.pendingOperatorEvents)}\n`);
    assert.equal(statSync(journal).size, Buffer.byteLength(canonicalJson(replica.pendingOperatorEvents)) + 1);
    assert.throws(() => competing.stageOperatorEvents(events), /already open by process/);
    assert.throws(() => competing.buildProposal(), /owned by another instance/);
    competing.closeSecurityState();
    competing = null;
    assert.throws(() => new ValidatorReplica(directory), /already open by process/);
    assert.deepEqual(replica.stageOperatorEvents(events), { expectedHeight: 1, status: "known" });
    replica.closeSecurityState();
    replica = null;
    // Simulate a crash after lock publication but before graceful release.
    const ownerLock = join(directory, ".operator-event-owner", ".nir-writer-lock");
    writeFileSync(ownerLock, JSON.stringify({ format: "nir-data-directory-lock-v1",
      pid: 2_147_483_647, startedAt: 1, token: "d".repeat(64) }), { mode: 0o600 });
    competing = new ValidatorReplica(directory);
    assert.deepEqual(competing.pendingOperatorEvents.events.epochRandomnessCommits, [commit]);
    competing.closeSecurityState();
    competing = null;
    replica = new ValidatorReplica(directory);
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
    competing?.closeSecurityState();
    replica?.closeSecurityState();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("snapshot installation immediately prunes a height-bound operator queue", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-operator-snapshot-"));
  const beacons = Array.from({ length: 4 }, generateWallet);
  const layout = initializeDistributedDevnet(join(temporary, "network"), { beaconWallets: beacons });
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  try {
    const genesis = JSON.parse(readFileSync(join(layout.validatorDirectories[0], "genesis.json")));
    const chain = new NirChain(genesis);
    const status = chain.epochRandomnessStatus();
    const wallet = beacons.find(({ address }) => address === status.committee[0]);
    const commit = createEpochRandomnessCommit({
      wallet, networkId: chain.networkId, round: status.round, secret: "c".repeat(64),
    });
    replicas[3].stageOperatorEvents({ epochRandomnessCommits: [commit] });
    const validators = layout.validatorDirectories.map((path) =>
      JSON.parse(readFileSync(join(path, "VALIDATOR-KEY.json"))));
    const empty = finalizeBlock(chain.buildBlock({ transactions: [], timestamp: Date.now() }), validators);
    for (const replica of replicas.slice(0, 3)) replica.commit(empty);
    const installed = replicas[3].installStateSnapshotCandidates(
      replicas.slice(0, 3).map((replica) => replica.stateSnapshotCandidate()));
    assert.equal(installed.height, 1);
    assert.equal(replicas[3].pendingOperatorEvents, null);
    assert.throws(() => replicas[3].buildProposal(), /mempool is empty/);
    assert.equal(statSync(join(layout.validatorDirectories[3], "OPERATOR-EVENTS.json"),
      { throwIfNoEntry: false }), undefined);
    const treasury = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "TREASURY-DEV-KEY.json")));
    const transfer = createTransfer({ wallet: treasury, networkId: chain.networkId,
      recipient: generateWallet().address, amount: ATOMIC_UNITS.toString(), nonce: 0 });
    assert.equal(replicas[3].submitTransaction(transfer).status, "queued");
    replicas[3].closeSecurityState();
    replicas[3] = new ValidatorReplica(layout.validatorDirectories[3]);
    assert.equal(replicas[3].pendingOperatorEvents, null);
  } finally {
    replicas.forEach((replica) => replica.closeSecurityState());
    rmSync(temporary, { recursive: true, force: true });
  }
});

for (const includedAtPrunedHeight of [true, false]) test(includedAtPrunedHeight
  ? "snapshot catch-up does not falsely expire a staged event included in pruned history"
  : "snapshot catch-up leaves an absent event unverified when history is pruned", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-operator-snapshot-outcome-"));
  const beacons = Array.from({ length: 4 }, generateWallet);
  const layout = initializeDistributedDevnet(join(temporary, "network"), { beaconWallets: beacons });
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  try {
    const genesis = JSON.parse(readFileSync(join(layout.validatorDirectories[0], "genesis.json")));
    const chain = new NirChain(genesis);
    const status = chain.epochRandomnessStatus();
    const commit = createEpochRandomnessCommit({
      wallet: beacons.find(({ address }) => address === status.committee[0]),
      networkId: chain.networkId, round: status.round, secret: "e".repeat(64),
    });
    replicas[3].stageOperatorEvents({ epochRandomnessCommits: [commit] });
    const validators = layout.validatorDirectories.map((directory) =>
      JSON.parse(readFileSync(join(directory, "VALIDATOR-KEY.json"))));
    const first = finalizeBlock(chain.buildBlock({
      ...(includedAtPrunedHeight ? { epochRandomnessCommits: [commit] } : {}),
      transactions: [], timestamp: Date.now(),
    }), validators);
    chain.appendBlock(first);
    const second = finalizeBlock(chain.buildBlock({ transactions: [], timestamp: Date.now() }),
      validators);
    for (const replica of replicas.slice(0, 3)) {
      replica.commit(first);
      replica.commit(second);
    }
    const installed = replicas[3].installStateSnapshotCandidates(
      replicas.slice(0, 3).map((replica) => replica.stateSnapshotCandidate()));
    assert.equal(installed.height, 2);
    const outcome = replicas[3].localOperatorEventStatus;
    assert.equal(outcome.status, "unknown");
    assert.equal(outcome.action, "verification-required");
    assert.equal(outcome.finalizedBlockHash, null);
    assert.equal(outcome.entries.epochRandomnessCommits[0].status, "unknown");
    assert.equal(replicas[3].pendingOperatorEvents, null);
    const retry = replicas[3].stageOperatorEvents({ epochRandomnessCommits: [commit] });
    assert.equal(retry.status, "unknown");
    assert.equal(retry.action, "verification-required");
    replicas[3].closeSecurityState();
    replicas[3] = new ValidatorReplica(layout.validatorDirectories[3]);
    assert.deepEqual(replicas[3].localOperatorEventStatus, outcome);
  } finally {
    replicas.forEach((replica) => replica.closeSecurityState());
    rmSync(temporary, { recursive: true, force: true });
  }
});

for (const extraFinalizedEntry of [true, false]) test(extraFinalizedEntry
  ? "operator receipt recognizes staged event inside a larger finalized event list"
  : "operator receipt records partial inclusion per event and rejects expired retry", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-operator-outcome-"));
  const beacons = Array.from({ length: 4 }, generateWallet);
  const layout = initializeDistributedDevnet(join(temporary, "network"), { beaconWallets: beacons });
  const directory = layout.validatorDirectories[0];
  let replica = new ValidatorReplica(directory);
  try {
    const genesis = JSON.parse(readFileSync(join(directory, "genesis.json")));
    const chain = new NirChain(genesis);
    const status = chain.epochRandomnessStatus();
    const commits = status.committee.slice(0, 2).map((address, index) =>
      createEpochRandomnessCommit({
        wallet: beacons.find((wallet) => wallet.address === address),
        networkId: chain.networkId, round: status.round, secret: String(index + 1).repeat(64),
      }));
    const staged = extraFinalizedEntry ? [commits[0]] : commits;
    const finalizedEntries = extraFinalizedEntry ? commits : [commits[0]];
    replica.stageOperatorEvents({ epochRandomnessCommits: staged });
    const validators = layout.validatorDirectories.map((path) =>
      JSON.parse(readFileSync(join(path, "VALIDATOR-KEY.json"))));
    const finalized = finalizeBlock(chain.buildBlock({
      epochRandomnessCommits: finalizedEntries, transactions: [], timestamp: Date.now(),
    }), validators);
    replica.commit(finalized);
    const outcome = replica.localOperatorEventStatus;
    assert.equal(outcome.status, extraFinalizedEntry ? "included" : "partial");
    assert.equal(outcome.action, extraFinalizedEntry ? "none" : "re-evaluation-required");
    assert.deepEqual(outcome.entries.epochRandomnessCommits.map(({ status: entryStatus }) => entryStatus),
      extraFinalizedEntry ? ["included"] : ["included", "expired"]);
    replica.closeSecurityState();
    replica = new ValidatorReplica(directory);
    assert.deepEqual(replica.localOperatorEventStatus, outcome);
    if (!extraFinalizedEntry) {
      const retry = replica.stageOperatorEvents({ epochRandomnessCommits: [commits[1]] });
      assert.equal(retry.accepted, false);
      assert.equal(retry.action, "re-evaluation-required");
      assert.equal(retry.status, "expired");
      assert.equal(retry.expectedHeight, 1);
      assert.match(retry.eventDigest, /^[0-9a-f]{64}$/);
    }
  } finally {
    replica?.closeSecurityState();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("prune refuses a substituted journal and restart safely removes the original stale event", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-operator-prune-"));
  const beacons = Array.from({ length: 4 }, generateWallet);
  const layout = initializeDistributedDevnet(join(temporary, "network"), { beaconWallets: beacons });
  const directory = layout.validatorDirectories[0];
  const journal = join(directory, "OPERATOR-EVENTS.json");
  const outside = join(temporary, "outside.json");
  let replica = new ValidatorReplica(directory);
  try {
    const genesis = JSON.parse(readFileSync(join(directory, "genesis.json")));
    const chain = new NirChain(genesis);
    const status = chain.epochRandomnessStatus();
    const wallet = beacons.find(({ address }) => address === status.committee[0]);
    const commit = createEpochRandomnessCommit({
      wallet, networkId: chain.networkId, round: status.round, secret: "d".repeat(64),
    });
    replica.stageOperatorEvents({ epochRandomnessCommits: [commit] });
    const original = readFileSync(journal, "utf8");
    writeFileSync(outside, original, { mode: 0o600 });
    rmSync(journal);
    symlinkSync(outside, journal);
    const validators = layout.validatorDirectories.map((path) =>
      JSON.parse(readFileSync(join(path, "VALIDATOR-KEY.json"))));
    const empty = finalizeBlock(chain.buildBlock({ transactions: [], timestamp: Date.now() }), validators);
    assert.throws(() => replica.commit(empty), /file is unsafe/);
    assert.equal(readFileSync(outside, "utf8"), original);
    assert.equal(existsSync(journal), true);
    replica.closeSecurityState();
    assert.throws(() => new ValidatorReplica(directory), /file is unsafe/);
    rmSync(journal);
    writeFileSync(journal, original, { mode: 0o600 });
    replica = new ValidatorReplica(directory);
    assert.equal(replica.height, 1);
    assert.equal(replica.pendingOperatorEvents, null);
    assert.equal(existsSync(journal), false);
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

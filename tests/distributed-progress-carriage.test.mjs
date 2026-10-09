import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  allocateProgressRewards, createCandidateBond, createProgressClaim,
  createProgressCommitment, finalizeBlock, NirChain,
} from "../blockchain/chain.mjs";
import { LEGACY_INITIAL_EPOCH_REWARD as INITIAL_EPOCH_REWARD,
  SAFETY_POLICY_V1_COMMITMENT } from "../blockchain/constants.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import {
  DistributedCoordinator, initializeDistributedDevnet, ValidatorReplica,
} from "../blockchain/distributed-node.mjs";
import { createValidatorControlServer, createValidatorHttpServer }
  from "../blockchain/validator-service.mjs";
import { listenOnPrivateValidatorControlSocket, requestValidatorControl }
  from "../blockchain/validator-control-socket.mjs";
import {
  createEpochRandomnessCommit, createEpochRandomnessReveal,
  createProgressBeacon, createProgressBeaconShare,
} from "../blockchain/operators.mjs";

const hash = (label) => createHash("sha256").update(label).digest("hex");
const sha = (label) => `sha256:${hash(label)}`;
const blockPath = (directory, height) =>
  join(directory, "blocks", `${String(height).padStart(12, "0")}.json`);

test("progress claim allocation accepts 256 distinct claims but rejects 257", () => {
  const recipient = generateWallet().address;
  const claims = Array.from({ length: 256 }, (_, index) => ({
    fingerprint: index.toString(16).padStart(64, "0"), recipient, score: "1",
  }));
  const rewards = allocateProgressRewards(0, claims);
  assert.equal(rewards.length, 256);
  assert.ok(rewards.every(({ amount }) => BigInt(amount) > 0n));
  assert.throws(() => allocateProgressRewards(0, [
    ...claims, { fingerprint: "f".repeat(64), recipient, score: "1" },
  ]), /too many progress rewards/);
});

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

test("operator-only claim survives failed proposer round and validator replay", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-progress-carriage-"));
  const beacons = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const layout = initializeDistributedDevnet(join(temporary, "network"), {
    beaconWallets: beacons,
    evaluatorWallets: evaluators,
    capabilityReferences: [{
      artifactHash: sha("baseline"), contentHash: sha("baseline-content"),
      behaviorCommitment: hash("baseline-behavior"),
      capabilitiesBps: { "reasoning-v1": 8_000 },
    }],
  });
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  const servers = replicas.map(createValidatorHttpServer);
  try {
    const urls = await Promise.all(servers.map(listen));
    let coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    const genesis = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "genesis.json")));
    const treasury = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "TREASURY-DEV-KEY.json")));
    const mirror = new NirChain(genesis);
    const sync = () => {
      while (mirror.height < coordinator.height) {
        mirror.appendBlock(JSON.parse(readFileSync(blockPath(layout.coordinatorDirectory, mirror.height + 1))));
      }
    };
    const owner = generateWallet();
    const admission = createProgressCommitment({
      wallet: owner, networkId: coordinator.networkId, recipient: owner.address,
      artifactHash: sha("candidate"), contentHash: sha("candidate-content"),
      baselineHash: sha("baseline"), baselineContentHash: sha("baseline-content"),
      suiteCommitment: hash("suite"), nonce: 0,
    });
    const bond = createCandidateBond({
      wallet: treasury, networkId: coordinator.networkId,
      candidateId: admission.candidateId, candidateOwner: owner.address,
      purpose: "progress", amount: INITIAL_EPOCH_REWARD.toString(), fee: "0", nonce: 0,
    });
    await coordinator.submitTransaction(bond);
    await coordinator.produceBlock();
    sync();
    await coordinator.submitTransaction(admission);
    await coordinator.produceBlock();
    sync();

    const status = mirror.epochRandomnessStatus();
    const committee = status.committee.map((address) => beacons.find((wallet) => wallet.address === address));
    const secrets = committee.map((_, index) => hash(`epoch-${index}`));
    await coordinator.produceBlock({
      epochRandomnessCommits: committee.map((wallet, index) => createEpochRandomnessCommit({
        wallet, networkId: coordinator.networkId, round: status.round, secret: secrets[index],
      })),
    });
    sync();
    await coordinator.produceBlock({
      epochRandomnessReveals: committee.map((wallet, index) => createEpochRandomnessReveal({
        wallet, networkId: coordinator.networkId, round: status.round, secret: secrets[index],
      })),
    });
    sync();
    const round = mirror.height + 1;
    const shares = mirror.progressBeaconCommittee(admission.candidateId)
      .map((address, index) => createProgressBeaconShare({
        wallet: beacons.find((wallet) => wallet.address === address),
        networkId: coordinator.networkId, candidateId: admission.candidateId,
        round, value: hash(`beacon-${index}`),
      }));
    await coordinator.produceBlock({
      progressBeacons: [createProgressBeacon({
        shares, networkId: coordinator.networkId, candidateId: admission.candidateId, round,
      })],
    });
    sync();
    const challenge = mirror.progressChallenge(admission.candidateId);
    const evaluation = mirror.prepareProgressEvaluation({
      artifactHash: admission.artifactHash, baselineHash: admission.baselineHash,
      baselineContentHash: admission.baselineContentHash, contentHash: admission.contentHash,
      candidateId: admission.candidateId, executionBundleHash: hash("execution"),
      suiteCommitment: admission.suiteCommitment, parents: [admission.baselineHash],
      committedEpoch: challenge.committedHeight, challengeEpoch: mirror.height + 1,
      challengeSeed: challenge.challengeSeed, behaviorCommitment: hash("candidate-behavior"),
      capabilitiesBps: { "reasoning-v1": 8_200 }, gainPpm: 10_000,
      generalityBps: 10_000, reproducibilityBps: 10_000, safetyBps: 10_000,
      safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT, criticalSafetyPass: true,
      candidateEnergyWh: 100, baselineEnergyWh: 100, energyAttested: true,
    });
    const claim = createProgressClaim({
      networkId: coordinator.networkId, epoch: mirror.height + 1,
      recipient: owner.address, evaluation,
      evaluatorWallets: challenge.committee.map((address) =>
        evaluators.find((wallet) => wallet.address === address)),
    });
    assert.throws(() => replicas[0].stageOperatorEvents({
      rewardClaims: [{ ...claim, attestations: [] }],
    }), /quorum not reached/);
    assert.deepEqual(replicas[0].stageOperatorEvents({ rewardClaims: [claim] }),
      { expectedHeight: mirror.height + 1, status: "queued" });
    assert.equal(replicas[0].buildProposal().progressRewards.length, 1);
    const proposed = mirror.buildBlock({ rewardClaims: [claim], timestamp: Date.now() });
    assert.throws(() => replicas[0].vote({
      ...proposed,
      progressRewards: [{ ...proposed.progressRewards[0], amount: "1" }],
    }), /not deterministic|invalid|mismatch/);
    await assert.rejects(() => coordinator.produceBlock({
      rewardClaims: Array(257).fill(claim),
    }), /progress reward claims proposal is invalid or too large/);
    await assert.rejects(() => coordinator.produceBlock({
      rewardClaims: Array(256).fill(claim),
    }), /duplicate proof claim/);
    // This malformed receipt fails in the coordinator before remote voting.
    await assert.rejects(() => coordinator.produceBlock({
      rewardClaims: [{ ...claim, score: "0" }],
    }));
    assert.equal(coordinator.height, mirror.height);
    assert.deepEqual(replicas.map((replica) => replica.height), Array(4).fill(mirror.height));
    const offlineIndex = replicas.findIndex((replica) =>
      replica.address === mirror.expectedProposer(mirror.height + 1));
    assert.ok(offlineIndex >= 0);
    await close(servers[offlineIndex]);
    await coordinator.produceBlock({ rewardClaims: [claim] });
    sync();
    assert.equal(coordinator.account(owner.address).atomicBalance, "0");
    assert.equal(coordinator.account(owner.address).resources.pendingProgressReward.amount,
      INITIAL_EPOCH_REWARD.toString());
    const rewardBlock = JSON.parse(readFileSync(blockPath(layout.coordinatorDirectory, mirror.height)));
    assert.ok(rewardBlock.round > 0, "an offline elected proposer requires a timeout round");
    assert.equal(replicas[offlineIndex].height, mirror.height - 1);
    replicas[offlineIndex].closeSecurityState();
    replicas[offlineIndex] = new ValidatorReplica(layout.validatorDirectories[offlineIndex]);
    assert.equal(replicas[offlineIndex].height, mirror.height - 1);
    assert.equal(replicas[offlineIndex].commit(rewardBlock).status, "committed");
    assert.equal(replicas[offlineIndex].height, mirror.height);
    assert.equal(replicas[offlineIndex].account(owner.address).atomicBalance, "0");
    assert.equal(replicas[offlineIndex].account(owner.address).resources.pendingProgressReward.amount,
      INITIAL_EPOCH_REWARD.toString());
    assert.deepEqual(replicas[offlineIndex].commit(rewardBlock),
      { height: mirror.height, status: "known" });
    assert.equal(replicas[offlineIndex].account(owner.address).resources.pendingProgressReward.amount,
      INITIAL_EPOCH_REWARD.toString());
    assert.ok(replicas.every((replica) => replica.pendingOperatorEvents === null));
    coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    assert.equal(coordinator.account(owner.address).atomicBalance, "0");
    assert.equal(coordinator.account(owner.address).resources.pendingProgressReward.amount,
      INITIAL_EPOCH_REWARD.toString());
  } finally {
    await Promise.all(servers.map(close));
    replicas.forEach((replica) => replica.closeSecurityState());
    rmSync(temporary, { recursive: true, force: true });
  }
});

for (const mode of ["included", "expired", "partial"]) test({
  included: "elected validator alone finalizes a staged signed claim into pending balances",
  expired: "competing block expires a staged signed claim with durable re-evaluation status",
  partial: "partially included event batch identifies its included reward claim",
}[mode], async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-validator-progress-reward-"));
  const beacons = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const layout = initializeDistributedDevnet(join(temporary, "network"), {
    beaconWallets: beacons, evaluatorWallets: evaluators,
    capabilityReferences: [{
      artifactHash: sha("baseline-validator"), contentHash: sha("baseline-validator-content"),
      behaviorCommitment: hash("baseline-validator-behavior"),
      capabilitiesBps: { "reasoning-v1": 8_000 },
    }],
  });
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  let urls = [];
  const servers = replicas.map((replica) => createValidatorHttpServer(replica, { peerUrls: () => urls }));
  let controlChannel = null;
  const controlBase = mkdtempSync(join(tmpdir(), "nvc-"));
  const openControl = async (replica) => {
    const local = createValidatorControlServer(replica, { peerUrls: () => urls });
    controlChannel = await listenOnPrivateValidatorControlSocket(local.server, controlBase);
    local.enable();
    return controlChannel.path;
  };
  try {
    urls = await Promise.all(servers.map(listen));
    const coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    const genesis = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "genesis.json")));
    const treasury = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "TREASURY-DEV-KEY.json")));
    const mirror = new NirChain(genesis);
    const sync = () => {
      while (mirror.height < coordinator.height) {
        mirror.appendBlock(JSON.parse(readFileSync(blockPath(layout.coordinatorDirectory, mirror.height + 1))));
      }
    };
    const owner = generateWallet();
    const admission = createProgressCommitment({
      wallet: owner, networkId: coordinator.networkId, recipient: owner.address,
      artifactHash: sha("candidate-validator"), contentHash: sha("candidate-validator-content"),
      baselineHash: sha("baseline-validator"), baselineContentHash: sha("baseline-validator-content"),
      suiteCommitment: hash("suite-validator"), nonce: 0,
    });
    const bond = createCandidateBond({
      wallet: treasury, networkId: coordinator.networkId,
      candidateId: admission.candidateId, candidateOwner: owner.address,
      purpose: "progress", amount: INITIAL_EPOCH_REWARD.toString(), fee: "0", nonce: 0,
    });
    await coordinator.submitTransaction(bond);
    await coordinator.produceBlock(); sync();
    await coordinator.submitTransaction(admission);
    await coordinator.produceBlock(); sync();

    const status = mirror.epochRandomnessStatus();
    const committee = status.committee.map((address) =>
      beacons.find((wallet) => wallet.address === address));
    const secrets = committee.map((_, index) => hash(`validator-epoch-${index}`));
    await coordinator.produceBlock({
      epochRandomnessCommits: committee.map((wallet, index) => createEpochRandomnessCommit({
        wallet, networkId: coordinator.networkId, round: status.round, secret: secrets[index],
      })),
    });
    sync();
    await coordinator.produceBlock({
      epochRandomnessReveals: committee.map((wallet, index) => createEpochRandomnessReveal({
        wallet, networkId: coordinator.networkId, round: status.round, secret: secrets[index],
      })),
    });
    sync();
    const beaconRound = mirror.height + 1;
    const shares = mirror.progressBeaconCommittee(admission.candidateId)
      .map((address, index) => createProgressBeaconShare({
        wallet: beacons.find((entry) => entry.address === address),
        networkId: coordinator.networkId, candidateId: admission.candidateId,
        round: beaconRound, value: hash(`validator-beacon-${index}`),
      }));
    await coordinator.produceBlock({
      progressBeacons: [createProgressBeacon({ shares, networkId: coordinator.networkId,
        candidateId: admission.candidateId, round: beaconRound })],
    });
    sync();
    const challenge = mirror.progressChallenge(admission.candidateId);
    const evaluation = mirror.prepareProgressEvaluation({
      artifactHash: admission.artifactHash, baselineHash: admission.baselineHash,
      baselineContentHash: admission.baselineContentHash, contentHash: admission.contentHash,
      candidateId: admission.candidateId, executionBundleHash: hash("validator-execution"),
      suiteCommitment: admission.suiteCommitment, parents: [admission.baselineHash],
      committedEpoch: challenge.committedHeight, challengeEpoch: mirror.height + 1,
      challengeSeed: challenge.challengeSeed,
      behaviorCommitment: hash("validator-candidate-behavior"),
      capabilitiesBps: { "reasoning-v1": 8_200 }, gainPpm: 10_000,
      generalityBps: 10_000, reproducibilityBps: 10_000, safetyBps: 10_000,
      safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT, criticalSafetyPass: true,
      candidateEnergyWh: 100, baselineEnergyWh: 100, energyAttested: true,
    });
    const claim = createProgressClaim({
      networkId: coordinator.networkId, epoch: mirror.height + 1,
      recipient: owner.address, evaluation,
      evaluatorWallets: challenge.committee.map((address) =>
        evaluators.find((wallet) => wallet.address === address)),
    });
    const proposerIndex = replicas.findIndex(({ address }) =>
      address === mirror.expectedProposer(mirror.height + 1));
    assert.ok(proposerIndex >= 0);
    const nextRandomness = mirror.epochRandomnessStatus();
    const extraCommit = mode === "partial" ? createEpochRandomnessCommit({
      wallet: beacons.find(({ address }) => address === nextRandomness.committee[0]),
      networkId: coordinator.networkId, round: nextRandomness.round,
      secret: hash("partial-claim-batch"),
    }) : null;
    const stagedEvents = { rewardClaims: [claim],
      ...(extraCommit === null ? {} : { epochRandomnessCommits: [extraCommit] }) };
    let claimDigest = null;
    if (mode === "partial") {
      assert.deepEqual(replicas[proposerIndex].stageOperatorEvents(stagedEvents),
        { expectedHeight: mirror.height + 1, status: "queued" });
    } else {
      const path = await openControl(replicas[proposerIndex]);
      const handoff = { claim, expectedHeight: mirror.height + 1,
        networkId: mirror.networkId, previousHash: mirror.tipHash };
      const other = replicas.findIndex((_, index) => index !== proposerIndex);
      assert.throws(() => replicas[other].stageRewardClaim(handoff),
        /elected proposer and tip/);
      for (const invalid of [
        { ...handoff, networkId: "foreign-network" },
        { ...handoff, expectedHeight: handoff.expectedHeight + 1 },
      ]) {
        const rejected = await requestValidatorControl(path, "stageRewardClaim", invalid);
        assert.equal(rejected.ok, false);
      }
      const wrongTip = await requestValidatorControl(path, "stageRewardClaim",
        { ...handoff, previousHash: "f".repeat(64) });
      assert.equal(wrongTip.ok, false);
      await assert.rejects(requestValidatorControl(path, "stageRewardClaim",
        { ...handoff, claim: { padding: "x".repeat(64 * 1024) } }),
      /outside the bounded limit/);
      const unsigned = await requestValidatorControl(path, "stageRewardClaim",
        { ...handoff, claim: { ...claim, attestations: [] } });
      assert.equal(unsigned.ok, false);
      assert.equal(replicas[proposerIndex].pendingOperatorEvents, null);
      const queued = await requestValidatorControl(path, "stageRewardClaim", handoff);
      assert.equal(queued.status, 202);
      assert.equal(queued.body.status, "queued");
      assert.equal(queued.body.expectedHeight, mirror.height + 1);
      claimDigest = queued.body.claimDigest;
      assert.match(claimDigest, /^[0-9a-f]{64}$/);
      const duplicate = await requestValidatorControl(path, "stageRewardClaim", handoff);
      assert.equal(duplicate.body.status, "known");
      assert.equal((await requestValidatorControl(path, "rewardClaimStatus",
        { claimDigest: "g".repeat(64) })).ok, false);
      assert.equal((await requestValidatorControl(path, "rewardClaimStatus",
        { claimDigest })).body.status, "queued");
      const publicAttempt = await fetch(`${urls[proposerIndex]}/v1/operator/reward-claims`,
        { method: "POST", body: "{}" });
      assert.equal(publicAttempt.status, 404);
    }
    assert.equal(replicas[proposerIndex].buildProposal().progressRewards.length, 1);

    // The journal must survive a proposer restart before any block is produced.
    await controlChannel?.close();
    controlChannel = null;
    await close(servers[proposerIndex]);
    replicas[proposerIndex].closeSecurityState();
    replicas[proposerIndex] = new ValidatorReplica(layout.validatorDirectories[proposerIndex]);
    assert.equal(replicas[proposerIndex].pendingOperatorEvents.events.rewardClaims.length, 1);
    servers[proposerIndex] = createValidatorHttpServer(replicas[proposerIndex], { peerUrls: () => urls });
    urls[proposerIndex] = await listen(servers[proposerIndex]);
    const restartedControl = mode === "partial" ? null
      : await openControl(replicas[proposerIndex]);
    if (mode !== "included") {
      const validators = layout.validatorDirectories.map((directory) =>
        JSON.parse(readFileSync(join(directory, "VALIDATOR-KEY.json"))));
      const competing = finalizeBlock(mirror.buildBlock({
        ...(mode === "partial" ? { rewardClaims: [claim] } : {}),
        transactions: [], timestamp: Date.now(),
      }), validators);
      for (const replica of replicas) replica.commit(competing);
      const outcome = replicas[proposerIndex].localOperatorEventStatus;
      assert.equal(outcome.status, mode);
      assert.equal(outcome.action, "re-evaluation-required");
      assert.equal(outcome.expectedHeight, competing.height);
      assert.equal(outcome.finalizedBlockHash, competing.hash);
      assert.equal(outcome.entries.rewardClaims[0].status,
        mode === "partial" ? "included" : "expired");
      if (restartedControl) {
        const local = await requestValidatorControl(restartedControl, "rewardClaimStatus",
          { claimDigest });
        assert.equal(local.body.status, "expired");
        assert.equal(local.body.finalizedBlockHash, competing.hash);
      }
      assert.equal(replicas[proposerIndex].pendingOperatorEvents, null);
      assert.equal(replicas[proposerIndex].account(owner.address).resources.pendingProgressReward
        === null, mode === "expired");
      if (mode === "expired") {
        assert.deepEqual(replicas[proposerIndex].stageOperatorEvents({ rewardClaims: [claim] }), {
          accepted: false, action: "re-evaluation-required", eventDigest: outcome.eventDigest,
          expectedHeight: competing.height, status: "expired",
        });
      } else {
        const retry = replicas[proposerIndex].stageOperatorEvents({
          epochRandomnessCommits: [extraCommit],
        });
        assert.equal(retry.status, "expired");
      }
      assert.equal(replicas[proposerIndex].pendingOperatorEvents, null);
      await Promise.all(servers.map(close));
      replicas[proposerIndex].closeSecurityState();
      replicas[proposerIndex] = new ValidatorReplica(layout.validatorDirectories[proposerIndex]);
      assert.deepEqual(replicas[proposerIndex].localOperatorEventStatus, outcome);
      if (mode === "expired") {
        assert.equal(replicas[proposerIndex].stageOperatorEvents({ rewardClaims: [claim] }).status,
          "expired");
      }
      return;
    }
    const produced = await requestValidatorControl(restartedControl, "produce");
    assert.equal(produced.status, 202);
    assert.equal(produced.body.committedPeers, 4);
    const rewardHeight = mirror.height + 1;
    assert.deepEqual(replicas.map(({ height }) => height), Array(4).fill(rewardHeight));
    assert.equal(replicas[proposerIndex].localOperatorEventStatus.status, "included");
    assert.equal((await requestValidatorControl(restartedControl, "rewardClaimStatus",
      { claimDigest })).body.status, "included");
    for (const replica of replicas) {
      const account = replica.account(owner.address);
      assert.equal(account.atomicBalance, "0", "reward stays locked during challenge window");
      assert.equal(account.resources.pendingProgressReward.amount, INITIAL_EPOCH_REWARD.toString());
      assert.equal(replica.pendingOperatorEvents, null);
      assert.equal(replica.blocksAfter(rewardHeight)[0].progressRewards.length, 1);
    }
    await Promise.all(servers.map(close));
    for (let index = 0; index < replicas.length; index += 1) {
      replicas[index].closeSecurityState();
      replicas[index] = new ValidatorReplica(layout.validatorDirectories[index]);
      assert.equal(replicas[index].height, rewardHeight);
      assert.equal(replicas[index].account(owner.address).resources.pendingProgressReward.amount,
        INITIAL_EPOCH_REWARD.toString());
      if (index === proposerIndex) {
        assert.equal(replicas[index].localOperatorEventStatus.status, "included");
      }
    }
  } finally {
    await controlChannel?.close();
    await Promise.all(servers.map(close));
    replicas.forEach((replica) => replica.closeSecurityState());
    rmSync(controlBase, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

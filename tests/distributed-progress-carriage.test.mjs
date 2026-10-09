import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  allocateProgressRewards, createCandidateBond, createProgressClaim,
  createProgressCommitment, NirChain,
} from "../blockchain/chain.mjs";
import { INITIAL_EPOCH_REWARD, SAFETY_POLICY_V1_COMMITMENT } from "../blockchain/constants.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import {
  DistributedCoordinator, initializeDistributedDevnet, ValidatorReplica,
} from "../blockchain/distributed-node.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";
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

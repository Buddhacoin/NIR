import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  NirChain, createCandidateBond, createProgressClaim, createProgressCommitment, finalizeBlock,
} from "../blockchain/chain.mjs";
import {
  EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION,
  INITIAL_EPOCH_REWARD, SAFETY_POLICY_V1_COMMITMENT, TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  createEpochRandomnessCommit, createEpochRandomnessReveal,
  createProgressBeacon, createProgressBeaconShare,
} from "../blockchain/operators.mjs";
import {
  createFinalityProof, verifyFinalizedEvaluationAssignmentProof,
} from "../blockchain/light-client.mjs";
import {
  MAX_EVALUATION_ASSIGNMENTS,
  evaluationAssignmentRoot,
  normalizeEvaluationAssignment, verifyEvaluationAssignmentProof,
} from "../blockchain/evaluation-assignment-tree.mjs";
import { createStateSnapshot, verifyStateSnapshot } from "../blockchain/state-snapshot.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const members = (wallets, prefix) => wallets.map((wallet, index) => ({
  ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
}));
const quorum = (block, validators) => finalizeBlock(block, validators.slice(0, 3));

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const submitter = generateWallet();
  const validatorMembers = members(validators, "validator");
  const genesisConfig = {
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [{
      artifactHash: `sha256:${digest("baseline")}`,
      contentHash: `sha256:${digest("baseline-content")}`,
      behaviorCommitment: digest("baseline-behavior"),
      capabilitiesBps: { "reasoning-v1": 100 },
    }],
    evaluators: members(evaluators, "evaluator"),
    genesisProtocolVersion: EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION,
    genesisTimestamp: 0,
    networkId: "nir-evaluation-assignment-test",
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: validatorMembers,
  };
  const chain = new NirChain(genesisConfig);
  const admission = createProgressCommitment({
    wallet: submitter, networkId: chain.networkId, recipient: submitter.address,
    artifactHash: `sha256:${digest("candidate")}`,
    baselineHash: `sha256:${digest("baseline")}`,
    baselineContentHash: `sha256:${digest("baseline-content")}`,
    contentHash: `sha256:${digest("candidate-content")}`,
    suiteCommitment: digest("suite"), nonce: 0,
  });
  let block = chain.buildBlock({
    transactions: [createCandidateBond({
      wallet: treasury, networkId: chain.networkId, candidateId: admission.candidateId,
      candidateOwner: submitter.address, purpose: "progress",
      amount: INITIAL_EPOCH_REWARD.toString(), fee: "0", nonce: 0,
    })], timestamp: TREASURY_VESTING_MS,
  });
  chain.appendBlock(quorum(block, validators));
  block = chain.buildBlock({ transactions: [admission], timestamp: TREASURY_VESTING_MS });
  chain.appendBlock(quorum(block, validators));

  const status = chain.epochRandomnessStatus();
  const beaconMembers = status.committee.map((address) =>
    beacons.find((wallet) => wallet.address === address));
  const secrets = beaconMembers.map((_, index) => digest(`epoch-secret-${index}`));
  block = chain.buildBlock({
    epochRandomnessCommits: beaconMembers.map((wallet, index) =>
      createEpochRandomnessCommit({
        wallet, networkId: chain.networkId, round: status.round, secret: secrets[index],
      })),
    timestamp: TREASURY_VESTING_MS,
  });
  chain.appendBlock(quorum(block, validators));
  block = chain.buildBlock({
    epochRandomnessReveals: beaconMembers.map((wallet, index) =>
      createEpochRandomnessReveal({
        wallet, networkId: chain.networkId, round: status.round, secret: secrets[index],
      })),
    timestamp: TREASURY_VESTING_MS,
  });
  chain.appendBlock(quorum(block, validators));
  const checkpointBlock = chain.blocks().at(-1);
  const assignedBeacons = chain.progressBeaconCommittee(admission.candidateId)
    .map((address) => beacons.find((wallet) => wallet.address === address));
  const round = chain.height + 1;
  const progressBeacon = createProgressBeacon({
    networkId: chain.networkId, candidateId: admission.candidateId, round,
    shares: assignedBeacons.map((wallet, index) => createProgressBeaconShare({
      wallet, networkId: chain.networkId, candidateId: admission.candidateId, round,
      value: digest(`progress-share-${index}`),
    })),
  });
  block = chain.buildBlock({
    progressBeacons: [progressBeacon], timestamp: TREASURY_VESTING_MS + 1,
  });
  const challengeBlock = quorum(block, validators);
  chain.appendBlock(challengeBlock);
  return {
    admission, chain, challengeBlock, checkpointBlock, evaluators, genesisConfig, submitter,
    validatorMembers, validators,
  };
}

test("v26 finality header proves the immutable consensus assignment", () => {
  const value = fixture();
  const witness = value.chain.evaluationAssignmentProof(value.admission.candidateId);
  assert.equal(witness.assignment.challengeEpoch, witness.assignment.challengeHeight);
  assert.deepEqual(witness.assignment.committee,
    [...witness.assignment.committee].sort());
  assert.deepEqual(
    verifyEvaluationAssignmentProof(
      witness.assignment, witness.inclusionProof, value.challengeBlock.evaluationAssignmentRoot,
    ),
    witness.assignment,
  );
  const verified = verifyFinalizedEvaluationAssignmentProof({
    assignment: witness.assignment,
    checkpoint: {
      height: value.checkpointBlock.height,
      protocolVersion: EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION,
      stateRoot: value.checkpointBlock.stateRoot,
      tipHash: value.checkpointBlock.hash,
    },
    finalityProofs: [createFinalityProof(value.challengeBlock)],
    inclusionProof: witness.inclusionProof,
    expectedNetworkId: value.chain.networkId,
    trustedValidators: value.validatorMembers,
  });
  assert.equal(verified.evaluationAssignmentRoot,
    value.challengeBlock.evaluationAssignmentRoot);
  assert.equal(createFinalityProof(value.challengeBlock).format, "nir-finality-proof-v4");
  assert.equal(createFinalityProof(value.challengeBlock).header.format,
    "nir-finality-header-v3");
});

test("assignment proof rejects altered value, path, root, and non-consensus fields", () => {
  const { admission, chain } = fixture();
  const witness = chain.evaluationAssignmentProof(admission.candidateId);
  assert.throws(() => verifyEvaluationAssignmentProof(
    { ...witness.assignment, challengeSeed: "f".repeat(64) },
    witness.inclusionProof, witness.evaluationAssignmentRoot,
  ), /root does not match/);
  const siblings = [...witness.inclusionProof.siblings];
  siblings[0] = "e".repeat(64);
  assert.throws(() => verifyEvaluationAssignmentProof(
    witness.assignment, { ...witness.inclusionProof, siblings },
    witness.evaluationAssignmentRoot,
  ), /root does not match/);
  assert.throws(() => verifyEvaluationAssignmentProof(
    witness.assignment, witness.inclusionProof, "d".repeat(64),
  ), /root does not match/);
  assert.throws(() => normalizeEvaluationAssignment({
    ...witness.assignment, environmentCommitment: "c".repeat(64),
  }), /value is invalid/);
  assert.throws(() => normalizeEvaluationAssignment({
    ...witness.assignment, committee: [...witness.assignment.committee].reverse(),
  }), /value is invalid/);
  assert.throws(() => evaluationAssignmentRoot(
    Array.from({ length: MAX_EVALUATION_ASSIGNMENTS + 1 }, () => ["x", {}]),
  ), /entries are invalid/);
});

test("snapshot and restart preserve the assignment registry and root", () => {
  const value = fixture();
  const before = value.chain.evaluationAssignmentProof(value.admission.candidateId);
  const snapshot = createStateSnapshot(value.chain, value.validators.slice(0, 3));
  verifyStateSnapshot(snapshot, {
    expectedNetworkId: value.chain.networkId,
    trustedValidators: value.validatorMembers,
  });
  const restored = NirChain.fromVerifiedSnapshot(value.genesisConfig, snapshot);
  assert.equal(restored.evaluationAssignmentRoot, value.chain.evaluationAssignmentRoot);
  assert.deepEqual(restored.evaluationAssignmentProof(value.admission.candidateId), before);

  const tampered = structuredClone(snapshot);
  tampered.state.evaluationAssignments[0][1].challengeSeed = "a".repeat(64);
  assert.throws(() => NirChain.fromVerifiedSnapshot(value.genesisConfig, tampered),
    /snapshot|state root/);
});

test("reward admission atomically removes the resolved active assignment", () => {
  const value = fixture();
  const challenge = value.chain.progressChallenge(value.admission.candidateId);
  const witness = value.chain.evaluationAssignmentProof(value.admission.candidateId);
  const evaluation = value.chain.prepareProgressEvaluation({
    artifactHash: value.admission.artifactHash,
    baselineHash: value.admission.baselineHash,
    baselineContentHash: value.admission.baselineContentHash,
    behaviorCommitment: digest("rewarded-behavior"),
    candidateEnergyWh: 100,
    candidateId: value.admission.candidateId,
    capabilitiesBps: { "reasoning-v1": 200 },
    challengeEpoch: challenge.challengeEpoch,
    challengeSeed: challenge.challengeSeed,
    committedEpoch: challenge.committedHeight,
    contentHash: value.admission.contentHash,
    criticalSafetyPass: true,
    energyAttested: true,
    executionBundleHash: digest("rewarded-execution-bundle"),
    gainPpm: 10_000,
    generalityBps: 10_000,
    parents: [...value.admission.parents],
    reproducibilityBps: 10_000,
    safetyBps: 10_000,
    safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT,
    suiteCommitment: value.admission.suiteCommitment,
    baselineEnergyWh: 100,
  });
  const claim = createProgressClaim({
    networkId: value.chain.networkId,
    epoch: value.chain.height + 1,
    recipient: value.submitter.address,
    evaluation,
    evaluatorWallets: challenge.committee.map((address) =>
      value.evaluators.find((wallet) => wallet.address === address)),
  });
  const block = value.chain.buildBlock({
    rewardClaims: [claim], timestamp: TREASURY_VESTING_MS + 2,
  });
  value.chain.appendBlock(quorum(block, value.validators));

  assert.throws(() => value.chain.evaluationAssignmentProof(value.admission.candidateId),
    /not available/);
  assert.notEqual(value.chain.evaluationAssignmentRoot, witness.evaluationAssignmentRoot);
  assert.deepEqual(verifyEvaluationAssignmentProof(
    witness.assignment, witness.inclusionProof, witness.evaluationAssignmentRoot,
  ), witness.assignment);
  assert.equal(value.chain.consensusSnapshot().state.progressCommitments.length, 0);
  assert.equal(value.chain.consensusSnapshot().state.evaluationAssignments.length, 0);
});

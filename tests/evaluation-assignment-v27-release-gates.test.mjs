import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  NirChain, blockHash, computeChainStateRoot, createCandidateBond,
  createProgressClaim, createProgressCommitment, finalizeBlock,
} from "../blockchain/chain.mjs";
import {
  EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION,
  EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
  INITIAL_EPOCH_REWARD, MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  SAFETY_POLICY_V1_COMMITMENT, TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { hashObject, generateWallet, publicWallet, signObject } from "../blockchain/crypto.mjs";
import { evaluationAssignmentRoot } from "../blockchain/evaluation-assignment-tree.mjs";
import {
  createEpochRandomnessCommit, createEpochRandomnessReveal,
  createProgressBeacon, createProgressBeaconShare,
} from "../blockchain/operators.mjs";
import { createStateSnapshot, verifyStateSnapshot } from "../blockchain/state-snapshot.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const members = (wallets, prefix) => wallets.map((wallet, index) => ({
  ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
}));
const quorum = (block, validators) => finalizeBlock(block, validators.slice(0, 3));
const evaluationEnvironment = {
  adapter_protocol: "nir-application-adapter-v1",
  cpu_limit: 2,
  format: "nir-evaluation-environment-v1",
  image_digest: `sha256:${digest("release-gate-image")}`,
  memory_limit_bytes: 1 << 30,
  runner_digest: `sha256:${digest("release-gate-runner")}`,
  timeout_seconds: 60,
};

function append(chain, validators, options = {}) {
  const block = chain.buildBlock({
    timestamp: chain.blocks().at(-1).timestamp + 1,
    ...options,
  });
  chain.appendBlock(quorum(block, validators));
  return block;
}

function fixture({
  protocolVersion = EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
  candidateCount = 1,
  challenged = [0],
} = {}) {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const submitters = Array.from({ length: candidateCount }, generateWallet);
  const validatorMembers = members(validators, "validator");
  const genesisConfig = {
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [{
      artifactHash: `sha256:${digest("release-gate-baseline")}`,
      contentHash: `sha256:${digest("release-gate-baseline-content")}`,
      behaviorCommitment: digest("release-gate-baseline-behavior"),
      capabilitiesBps: { "reasoning-v1": 100 },
    }],
    evaluationEnvironment,
    evaluators: members(evaluators, "evaluator"),
    genesisProtocolVersion: protocolVersion,
    genesisTimestamp: 0,
    networkId: `nir-v27-release-gate-${protocolVersion}-${candidateCount}`,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: validatorMembers,
  };
  const chain = new NirChain(genesisConfig);
  const admissions = submitters.map((submitter, index) => createProgressCommitment({
    wallet: submitter, networkId: chain.networkId, recipient: submitter.address,
    artifactHash: `sha256:${digest(`release-gate-candidate-${index}`)}`,
    baselineHash: `sha256:${digest("release-gate-baseline")}`,
    baselineContentHash: `sha256:${digest("release-gate-baseline-content")}`,
    contentHash: `sha256:${digest(`release-gate-content-${index}`)}`,
    suiteCommitment: digest(`release-gate-suite-${index}`), nonce: 0,
  }));
  append(chain, validators, {
    transactions: admissions.map((admission, index) => createCandidateBond({
      wallet: treasury, networkId: chain.networkId, candidateId: admission.candidateId,
      candidateOwner: submitters[index].address, purpose: "progress",
      amount: INITIAL_EPOCH_REWARD.toString(), fee: "0", nonce: index,
    })),
    timestamp: TREASURY_VESTING_MS,
  });
  append(chain, validators, { transactions: admissions });

  const status = chain.epochRandomnessStatus();
  const beaconMembers = status.committee.map((address) =>
    beacons.find((wallet) => wallet.address === address));
  const secrets = beaconMembers.map((_, index) => digest(`release-gate-secret-${index}`));
  append(chain, validators, {
    epochRandomnessCommits: beaconMembers.map((wallet, index) =>
      createEpochRandomnessCommit({
        wallet, networkId: chain.networkId, round: status.round, secret: secrets[index],
      })),
  });
  append(chain, validators, {
    epochRandomnessReveals: beaconMembers.map((wallet, index) =>
      createEpochRandomnessReveal({
        wallet, networkId: chain.networkId, round: status.round, secret: secrets[index],
      })),
  });
  for (const index of challenged) assignChallenge({
    admission: admissions[index], beacons, chain, validators, label: `initial-${index}`,
  });
  return {
    admissions, beacons, chain, evaluators, genesisConfig, submitters, treasury,
    validatorMembers, validators,
  };
}

function assignChallenge({ admission, beacons, chain, validators, label }) {
  const assignedBeacons = chain.progressBeaconCommittee(admission.candidateId)
    .map((address) => beacons.find((wallet) => wallet.address === address));
  const round = chain.height + 1;
  append(chain, validators, {
    progressBeacons: [createProgressBeacon({
      networkId: chain.networkId, candidateId: admission.candidateId, round,
      shares: assignedBeacons.map((wallet, index) => createProgressBeaconShare({
        wallet, networkId: chain.networkId, candidateId: admission.candidateId, round,
        value: digest(`${label}-share-${index}`),
      })),
    })],
  });
}

function rewardClaim(value, chain, epoch) {
  const admission = value.admissions[0];
  const challenge = chain.progressChallenge(admission.candidateId);
  const evaluation = chain.prepareProgressEvaluation({
    artifactHash: admission.artifactHash,
    baselineHash: admission.baselineHash,
    baselineContentHash: admission.baselineContentHash,
    behaviorCommitment: digest("release-gate-rewarded-behavior"),
    candidateEnergyWh: 100,
    candidateId: admission.candidateId,
    capabilitiesBps: { "reasoning-v1": 200 },
    challengeEpoch: challenge.challengeEpoch,
    challengeSeed: challenge.challengeSeed,
    committedEpoch: challenge.committedHeight,
    contentHash: admission.contentHash,
    criticalSafetyPass: true,
    energyAttested: true,
    executionBundleHash: digest("release-gate-execution-bundle"),
    gainPpm: 10_000,
    generalityBps: 10_000,
    parents: [...admission.parents],
    reproducibilityBps: 10_000,
    safetyBps: 10_000,
    safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT,
    suiteCommitment: admission.suiteCommitment,
    baselineEnergyWh: 100,
  });
  return createProgressClaim({
    networkId: chain.networkId, epoch, recipient: value.submitters[0].address, evaluation,
    evaluatorWallets: challenge.committee.map((address) =>
      value.evaluators.find((wallet) => wallet.address === address)),
  });
}

test("v27 reward is valid at expiry, rejected after expiry, and stale state is cleaned", () => {
  const value = fixture();
  const candidateId = value.admissions[0].candidateId;
  const expiry = value.chain.evaluationAssignmentProof(candidateId).assignment.expiresAtHeight;
  while (value.chain.height < expiry - 1) append(value.chain, value.validators);

  const atExpiry = value.chain.fork();
  append(atExpiry, value.validators, {
    rewardClaims: [rewardClaim(value, atExpiry, expiry)],
  });
  assert.equal(atExpiry.height, expiry);
  assert.throws(() => atExpiry.evaluationAssignmentProof(candidateId), /not available/);

  const afterExpiry = value.chain.fork();
  append(afterExpiry, value.validators);
  const burnedBefore = afterExpiry.burned;
  const staleProposal = afterExpiry.buildBlock({
    rewardClaims: [rewardClaim(value, afterExpiry, expiry + 1)],
    timestamp: afterExpiry.blocks().at(-1).timestamp + 1,
  });
  assert.throws(() => afterExpiry.appendBlock(quorum(staleProposal, value.validators)),
    /expired/);
  append(afterExpiry, value.validators);
  assert.equal(afterExpiry.height, expiry + 1);
  assert.throws(() => afterExpiry.evaluationAssignmentProof(candidateId), /not available/);
  assert.equal(afterExpiry.burned - burnedBefore, INITIAL_EPOCH_REWARD);
});

test("v27 activation cancels challenged v26 work but preserves unchallenged work", () => {
  const value = fixture({
    protocolVersion: EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION,
    candidateCount: 2,
    challenged: [0],
  });
  const challengedId = value.admissions[0].candidateId;
  const pendingId = value.admissions[1].candidateId;
  assert.equal(value.chain.evaluationAssignmentProof(challengedId).assignment.format,
    "nir-evaluation-assignment-v1");
  const treasuryBefore = value.chain.balance(value.treasury.address);
  const activationHeight = value.chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append(value.chain, value.validators, {
    protocolUpgrade: {
      activationHeight, format: "nir-protocol-upgrade-v1",
      version: EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
    },
  });
  while (value.chain.height < activationHeight) append(value.chain, value.validators);

  assert.equal(value.chain.protocolVersion, EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION);
  assert.throws(() => value.chain.evaluationAssignmentProof(challengedId), /not available/);
  assert.equal(value.chain.balance(value.treasury.address) - treasuryBefore,
    INITIAL_EPOCH_REWARD);
  assert.doesNotThrow(() => value.chain.progressBeaconCommittee(pendingId));

  assignChallenge({
    admission: value.admissions[1], beacons: value.beacons, chain: value.chain,
    validators: value.validators, label: "post-cutover",
  });
  assert.equal(value.chain.evaluationAssignmentProof(pendingId).assignment.format,
    "nir-evaluation-assignment-v2");
});

test("restore rejects a quorum-signed v27 snapshot containing a legacy assignment", () => {
  const value = fixture();
  const snapshot = createStateSnapshot(value.chain, value.validators.slice(0, 3));
  const forged = structuredClone(snapshot);
  const extended = forged.state.evaluationAssignments[0][1];
  const legacy = Object.fromEntries([
    "artifactHash", "baselineContentHash", "baselineHash", "candidateId",
    "challengeEpoch", "challengeHeight", "challengeSeed", "committedHeight",
    "committee", "contentHash", "parents", "recipient", "suiteCommitment",
  ].map((key) => [key, extended[key]]));
  legacy.format = "nir-evaluation-assignment-v1";
  forged.state.evaluationAssignments[0][1] = legacy;
  const assignmentRoot = evaluationAssignmentRoot(forged.state.evaluationAssignments);
  forged.evaluationAssignmentRoot = assignmentRoot;
  forged.state.evaluationAssignmentRoot = assignmentRoot;
  forged.checkpoint.evaluationAssignmentRoot = assignmentRoot;
  forged.stateRoot = computeChainStateRoot(forged.state);
  forged.checkpoint.stateRoot = forged.stateRoot;
  forged.checkpoint.hash = blockHash(forged.checkpoint);
  forged.tipHash = forged.checkpoint.hash;
  const { attestations: _oldAttestations, snapshotHash: _oldHash, ...payload } = forged;
  forged.snapshotHash = hashObject(payload, "STATE_SNAPSHOT");
  forged.attestations = value.validators.slice(0, 3).map((wallet) => ({
    signature: signObject({ snapshotHash: forged.snapshotHash }, wallet,
      "STATE_SNAPSHOT_APPROVAL"),
    validator: wallet.address,
  }));

  assert.doesNotThrow(() => verifyStateSnapshot(forged, {
    expectedNetworkId: value.chain.networkId,
    trustedValidators: value.validatorMembers,
  }));
  assert.throws(() => NirChain.fromVerifiedSnapshot(value.genesisConfig, forged),
    /legacy evaluation assignment survived the v27 cutover/);
});

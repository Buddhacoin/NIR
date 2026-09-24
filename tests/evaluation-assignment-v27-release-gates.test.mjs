import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  NirChain, blockHash, computeChainStateRoot, createCandidateBond,
  createProgressClaim, createProgressCommitment, createTransfer,
  createValidatorBond, finalizeBlock,
} from "../blockchain/chain.mjs";
import {
  EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION,
  EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
  INITIAL_EPOCH_REWARD, MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS, MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT, TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import {
  canonicalJson, hashObject, generateWallet, publicWallet, signObject,
} from "../blockchain/crypto.mjs";
import { evaluationAssignmentRoot } from "../blockchain/evaluation-assignment-tree.mjs";
import { verifyAssignmentChainAnchor } from "../blockchain/assignment-chain-anchor.mjs";
import {
  createFinalityProof, verifyFinalizedEvaluationAssignmentProof,
} from "../blockchain/light-client.mjs";
import {
  createEpochRandomnessCommit, createEpochRandomnessReveal,
  createProgressBeacon, createProgressBeaconShare,
} from "../blockchain/operators.mjs";
import { createStateSnapshot, verifyStateSnapshot } from "../blockchain/state-snapshot.mjs";
import { createTransactionProof } from "../blockchain/transaction-tree.mjs";
import { createValidatorHandoff } from "../blockchain/validator-handoff.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";

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

function candidateCommitmentHash(transaction, committedEpoch) {
  const value = {
    artifact_hash: transaction.artifactHash,
    baseline_content_hash: transaction.baselineContentHash,
    baseline_hash: transaction.baselineHash,
    candidate_id: transaction.candidateId,
    committed_epoch: committedEpoch,
    content_hash: transaction.contentHash,
    network_id: transaction.networkId,
    parents: transaction.parents,
    recipient: transaction.recipient,
    suite_commitment: transaction.suiteCommitment,
  };
  return createHash("sha256").update("NIR_CANDIDATE_COMMITMENT\0", "ascii")
    .update(canonicalJson(value), "utf8").digest("hex");
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

test("exact v27 assignment crosses a validator activation with a dual-quorum handoff", () => {
  const value = fixture({ challenged: [] });
  const oldWallets = value.validators;
  const oldMembers = value.validatorMembers;
  const newcomers = Array.from({ length: 2 }, generateWallet);
  const newcomerMembers = newcomers.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `rotated-${index}`,
  }));
  const nextWallets = [oldWallets[0], oldWallets[1], ...newcomers];
  const nextMembers = [oldMembers[0], oldMembers[1], ...newcomerMembers]
    .sort((left, right) => left.address.localeCompare(right.address));
  const allValidatorWallets = [...oldWallets, ...newcomers];

  const treasuryNonce = value.chain.nextNonce(value.treasury.address);
  append(value.chain, oldWallets, {
    transactions: allValidatorWallets.map((wallet, index) => createTransfer({
      wallet: value.treasury, networkId: value.chain.networkId, recipient: wallet.address,
      amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE).toString(),
      nonce: treasuryNonce + index,
    })),
  });
  append(value.chain, oldWallets, {
    transactions: allValidatorWallets.map((wallet, index) => createValidatorBond({
      wallet, networkId: value.chain.networkId, amount: MIN_VALIDATOR_BOND.toString(),
      nonce: 0,
      ...(index < oldWallets.length ? {} : { operatorId: `rotated-${index - oldWallets.length}` }),
    })),
  });

  const activationHeight = value.chain.height + 5;
  append(value.chain, oldWallets, {
    validatorRotation: { activationHeight, validators: nextMembers },
  });
  while (value.chain.height < activationHeight - 1) append(value.chain, oldWallets);
  const sourceBlock = value.chain.blocks().at(-1);
  const admission = value.admissions[0];
  const assignedBeacons = value.chain.progressBeaconCommittee(admission.candidateId)
    .map((address) => value.beacons.find((wallet) => wallet.address === address));
  const round = value.chain.height + 1;
  const proposal = value.chain.buildBlock({
    progressBeacons: [createProgressBeacon({
      networkId: value.chain.networkId, candidateId: admission.candidateId, round,
      shares: assignedBeacons.map((wallet, index) => createProgressBeaconShare({
        wallet, networkId: value.chain.networkId, candidateId: admission.candidateId, round,
        value: digest(`rotation-boundary-share-${index}`),
      })),
    })],
    timestamp: value.chain.blocks().at(-1).timestamp + 1,
  });
  const nextProposer = nextWallets.find(({ address }) => address === proposal.proposer);
  const newQuorum = [nextProposer,
    ...nextWallets.filter((wallet) => wallet.address !== proposal.proposer).slice(0, 2)];
  const transitionSigners = [...new Map([
    ...oldWallets.slice(0, 3), ...newQuorum,
  ].map((wallet) => [wallet.address, wallet])).values()];
  const decisionBlock = finalizeBlock(proposal, transitionSigners);
  value.chain.appendBlock(decisionBlock);
  assert.equal(decisionBlock.height, activationHeight);

  const handoff = createValidatorHandoff({
    activationBlockHash: decisionBlock.hash,
    activationHeight,
    activationStateRoot: decisionBlock.stateRoot,
    networkId: value.chain.networkId,
    nextValidators: nextMembers,
    previousValidators: oldMembers,
  }, oldWallets.slice(0, 3), nextWallets.slice(0, 3));
  const genesis = value.chain.blocks()[0];
  const checkpoint = {
    height: 0,
    protocolVersion: EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
    stateRoot: genesis.stateRoot,
    tipHash: genesis.hash,
  };
  const finalityProofs = value.chain.blocks().slice(1).map(createFinalityProof);
  const witness = value.chain.evaluationAssignmentProof(admission.candidateId);
  const lightResult = verifyFinalizedEvaluationAssignmentProof({
    assignment: witness.assignment,
    checkpoint,
    finalityProofs,
    handoffs: [handoff],
    inclusionProof: witness.inclusionProof,
    expectedNetworkId: value.chain.networkId,
    trustedValidators: oldMembers,
  });
  assert.equal(lightResult.assignment.sourceFinalityHeight, sourceBlock.height);
  assert.equal(lightResult.finalizedHeight, decisionBlock.height);

  const leaf = witness.assignment;
  const evaluatorKeys = new Map(value.evaluators.map((wallet) =>
    [wallet.address, wallet.publicKey]));
  const commitmentBlock = value.chain.blocks().find((block) =>
    block.transactions.some((transaction) => transaction.type === "progress-commitment" &&
      transaction.candidateId === admission.candidateId));
  const transactionIndex = commitmentBlock.transactions.findIndex((transaction) =>
    transaction.type === "progress-commitment" && transaction.candidateId === admission.candidateId);
  const assignment = {
    adapterProtocol: leaf.adapterProtocol,
    authorityMode: leaf.authorityMode,
    authoritySetHash: leaf.authoritySetHash,
    baselineArtifactHash: leaf.baselineHash,
    baselineContentHash: leaf.baselineContentHash,
    candidateArtifactHash: leaf.artifactHash,
    candidateCommitmentHash: candidateCommitmentHash(admission, commitmentBlock.height),
    candidateContentHash: leaf.contentHash,
    candidateId: leaf.candidateId,
    challengeEpoch: leaf.challengeEpoch,
    challengeSeed: leaf.challengeSeed,
    committedHeight: leaf.committedHeight,
    decisionHeight: leaf.challengeHeight,
    environmentCommitment: leaf.environmentCommitment,
    evaluators: leaf.committee.map((evaluatorId) => ({
      evaluatorId, publicKey: evaluatorKeys.get(evaluatorId),
    })),
    expiresAtHeight: leaf.expiresAtHeight,
    format: "nir-finalized-evaluation-assignment-v2",
    genesisHash: genesis.hash,
    networkId: value.chain.networkId,
    parents: leaf.parents,
    recipient: leaf.recipient,
    safetyPolicyHash: leaf.safetyPolicyHash,
    sourceFinalityHeight: leaf.sourceFinalityHeight,
    sourceFinalityStateRoot: leaf.sourceFinalityStateRoot,
    suiteCommitment: leaf.suiteCommitment,
  };
  const exact = verifyAssignmentChainAnchor({
    assignment,
    assignmentProof: witness.inclusionProof,
    checkpoint,
    commitmentTransaction: admission,
    consensusAssignment: leaf,
    decisionAnchor: {
      blockHash: decisionBlock.hash, height: decisionBlock.height,
      stateRoot: decisionBlock.stateRoot,
    },
    expectedGenesisHash: genesis.hash,
    expectedNetworkId: value.chain.networkId,
    finalityProofs,
    handoffs: [handoff],
    inclusionAnchor: {
      blockHash: decisionBlock.hash,
      evaluationAssignmentRoot: decisionBlock.evaluationAssignmentRoot,
      height: decisionBlock.height,
      stateRoot: decisionBlock.stateRoot,
    },
    sourceAnchor: {
      blockHash: sourceBlock.hash, height: sourceBlock.height, stateRoot: sourceBlock.stateRoot,
    },
    transactionBlockHeight: commitmentBlock.height,
    transactionProof: createTransactionProof(commitmentBlock.transactions, transactionIndex),
    trustedValidators: oldMembers,
  });
  assert.equal(exact.exactAssignmentIncluded, true);
  assert.throws(() => verifyFinalizedEvaluationAssignmentProof({
    assignment: witness.assignment,
    checkpoint,
    finalityProofs,
    handoffs: [],
    inclusionProof: witness.inclusionProof,
    expectedNetworkId: value.chain.networkId,
    trustedValidators: oldMembers,
  }), /validator|quorum|handoff|vote/);
});

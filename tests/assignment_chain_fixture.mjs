import { createHash } from "node:crypto";

import {
  NirChain, createCandidateBond, createProgressCommitment, finalizeBlock,
} from "../blockchain/chain.mjs";
import {
  CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION, EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION,
  EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  MIN_PROGRESS_CANDIDATE_BOND,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createFinalityProof } from "../blockchain/light-client.mjs";
import {
  assembleCheckpointTrustPackage, createCheckpointWitnessAttestation,
  createCheckpointWitnessPolicy,
} from "../blockchain/checkpoint-trust-package.mjs";
import { createTransactionProof } from "../blockchain/transaction-tree.mjs";
import {
  createEpochRandomnessCommit, createEpochRandomnessReveal,
  createProgressBeacon, createProgressBeaconShare,
} from "../blockchain/operators.mjs";

const fingerprint = (label) => createHash("sha256").update(label).digest("hex");
const members = (wallets, prefix) => wallets.map((wallet, index) => ({
  ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
}));
const validators = Array.from({ length: 4 }, generateWallet);
const evaluators = Array.from({ length: 4 }, generateWallet);
const beacons = Array.from({ length: 4 }, generateWallet);
const checkpointWitnesses = Array.from({ length: 4 }, generateWallet);
const treasury = generateWallet();
const submitter = generateWallet();
const validatorMembers = members(validators, "validator");
const v4 = process.env.NIR_ASSIGNMENT_FIXTURE_V4 === "1";
const v3 = v4 || process.env.NIR_ASSIGNMENT_FIXTURE_V3 === "1";
const protocolVersion = v3 ? EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION
  : EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION;
const evaluationEnvironment = {
  adapter_protocol: "nir-application-adapter-v1",
  cpu_limit: 2,
  format: "nir-evaluation-environment-v1",
  image_digest: `sha256:${fingerprint("evaluation-image")}`,
  memory_limit_bytes: 1 << 30,
  runner_digest: `sha256:${fingerprint("evaluation-runner")}`,
  timeout_seconds: 60,
};
const chain = new NirChain({
  beaconAuthorities: members(beacons, "beacon"),
  capabilityReferences: [{
    artifactHash: `sha256:${fingerprint("baseline")}`,
    contentHash: `sha256:${fingerprint("baseline-content")}`,
    behaviorCommitment: fingerprint("baseline-behavior"),
    capabilitiesBps: { "reasoning-v1": 100 },
  }],
  evaluators: members(evaluators, "evaluator"),
  ...(v3 ? { evaluationEnvironment } : {}),
  genesisProtocolVersion: protocolVersion,
  genesisTimestamp: 0,
  networkId: "nir-assignment-anchor-test",
  safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
  treasuryAddress: treasury.address,
  validators: validatorMembers,
});
const genesis = chain.blocks()[0];
const sign = (proposal) => finalizeBlock(proposal, [
  validators.find((wallet) => wallet.address === proposal.proposer),
  ...validators.filter((wallet) => wallet.address !== proposal.proposer).slice(0, 2),
]);
let compactCheckpointBlock = null;
let checkpointTrustPackage = null;
let checkpointTrustPolicyId = null;
if (v4) {
  const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  chain.appendBlock(sign(chain.buildBlock({
    protocolUpgrade: { activationHeight, format: "nir-protocol-upgrade-v1",
      version: CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION },
    timestamp: 1,
  })));
  while (chain.height < activationHeight) {
    chain.appendBlock(sign(chain.buildBlock({ timestamp: chain.height + 1 })));
  }
  for (let index = 0; index < 513; index += 1) {
    chain.appendBlock(sign(chain.buildBlock({ timestamp: chain.height + 1 })));
  }
  compactCheckpointBlock = chain.blocks().at(-1);
  const checkpointProof = createFinalityProof(compactCheckpointBlock);
  const policy = createCheckpointWitnessPolicy({
    chainIdentityGenesisHash: genesis.hash, generation: 1, networkId: chain.networkId,
    threshold: 3, witnesses: members(checkpointWitnesses, "checkpoint-witness"),
  });
  const sequence = 1;
  const attestations = checkpointWitnesses.slice(0, 3).map((wallet, index) =>
    createCheckpointWitnessAttestation({
      finalityProof: checkpointProof, observedAt: 10_000 + index,
      operatorId: `checkpoint-witness-${index}`, policy, sequence,
      validators: validatorMembers, wallet,
    }));
  checkpointTrustPackage = assembleCheckpointTrustPackage({
    attestations, finalityProof: checkpointProof, policy, sequence,
    validators: validatorMembers,
  });
  checkpointTrustPolicyId = policy.policyId;
}
const artifactHash = `sha256:${fingerprint("candidate")}`;
const contentHash = `sha256:${fingerprint("candidate-content")}`;
const baselineHash = `sha256:${fingerprint("baseline")}`;
const baselineContentHash = `sha256:${fingerprint("baseline-content")}`;
const suiteCommitment = fingerprint("suite");
const admission = createProgressCommitment({
  wallet: submitter, networkId: chain.networkId, recipient: submitter.address,
  artifactHash, baselineHash, baselineContentHash, contentHash, suiteCommitment,
  nonce: 0,
});
const bond = createCandidateBond({
  wallet: treasury, networkId: chain.networkId, candidateId: admission.candidateId,
  candidateOwner: submitter.address, purpose: "progress",
  amount: MIN_PROGRESS_CANDIDATE_BOND.toString(), fee: "0", nonce: 0,
});
const bondBlock = sign(chain.buildBlock({ transactions: [bond], timestamp: TREASURY_VESTING_MS }));
chain.appendBlock(bondBlock);
const admissionBlock = sign(chain.buildBlock({
  transactions: [admission], timestamp: TREASURY_VESTING_MS,
}));
chain.appendBlock(admissionBlock);
const status = chain.epochRandomnessStatus();
const epochMembers = status.committee.map((address) =>
  beacons.find((wallet) => wallet.address === address));
const secrets = epochMembers.map((_, index) => fingerprint(`epoch-secret-${index}`));
const epochCommitBlock = sign(chain.buildBlock({
  epochRandomnessCommits: epochMembers.map((wallet, index) =>
    createEpochRandomnessCommit({
      wallet, networkId: chain.networkId, round: status.round, secret: secrets[index],
    })),
  timestamp: TREASURY_VESTING_MS,
}));
chain.appendBlock(epochCommitBlock);
const epochRevealBlock = sign(chain.buildBlock({
  epochRandomnessReveals: epochMembers.map((wallet, index) =>
    createEpochRandomnessReveal({
      wallet, networkId: chain.networkId, round: status.round, secret: secrets[index],
    })),
  timestamp: TREASURY_VESTING_MS,
}));
chain.appendBlock(epochRevealBlock);
const assignedBeacons = chain.progressBeaconCommittee(admission.candidateId)
  .map((address) => beacons.find((wallet) => wallet.address === address));
const round = chain.height + 1;
const challengeBlock = sign(chain.buildBlock({
  progressBeacons: [createProgressBeacon({
    networkId: chain.networkId, candidateId: admission.candidateId, round,
    shares: assignedBeacons.map((wallet, index) => createProgressBeaconShare({
      wallet, networkId: chain.networkId, candidateId: admission.candidateId, round,
      value: fingerprint(`progress-share-${index}`),
    })),
  })],
  timestamp: TREASURY_VESTING_MS + 1,
}));
chain.appendBlock(challengeBlock);
const challenge = chain.progressChallenge(admission.candidateId);
const assignmentWitness = chain.evaluationAssignmentProof(admission.candidateId);

process.stdout.write(JSON.stringify({
  checkpoint: {
    height: compactCheckpointBlock?.height ?? 0,
    protocolVersion: compactCheckpointBlock?.protocolVersion ?? protocolVersion,
    stateRoot: compactCheckpointBlock?.stateRoot ?? genesis.stateRoot,
    tipHash: compactCheckpointBlock?.hash ?? genesis.hash,
    ...(v4 ? {
      chainIdentityGenesisHash: genesis.hash,
      validatorSetId: compactCheckpointBlock.validatorSetId,
    } : {}),
  },
  checkpointTrustPackage: v4 ? checkpointTrustPackage : undefined,
  checkpointTrustPolicyId: v4 ? checkpointTrustPolicyId : undefined,
  minimumCheckpointHeight: v4 ? compactCheckpointBlock.height : undefined,
  minimumCheckpointSequence: v4 ? checkpointTrustPackage.sequence : undefined,
  commitmentTransaction: admission,
  evaluators: challenge.committee.map((address) =>
    publicWallet(evaluators.find((wallet) => wallet.address === address))),
  finalityProofs: [
    createFinalityProof(bondBlock), createFinalityProof(admissionBlock),
    createFinalityProof(epochCommitBlock), createFinalityProof(epochRevealBlock),
    createFinalityProof(challengeBlock),
  ],
  finalizedHeight: challengeBlock.height,
  genesisHash: genesis.hash,
  networkId: chain.networkId,
  stateRoot: challengeBlock.stateRoot,
  challengeEpoch: challenge.challengeEpoch,
  challengeSeed: challenge.challengeSeed,
  consensusAssignment: assignmentWitness.assignment,
  assignmentProof: assignmentWitness.inclusionProof,
  sourceAnchor: v3 ? {
    blockHash: epochRevealBlock.hash, height: epochRevealBlock.height,
    stateRoot: epochRevealBlock.stateRoot,
  } : undefined,
  decisionAnchor: v3 ? {
    blockHash: challengeBlock.hash, height: challengeBlock.height,
    stateRoot: challengeBlock.stateRoot,
  } : undefined,
  inclusionAnchor: v3 ? {
    blockHash: challengeBlock.hash, height: challengeBlock.height,
    stateRoot: challengeBlock.stateRoot,
    evaluationAssignmentRoot: challengeBlock.evaluationAssignmentRoot,
  } : undefined,
  transactionBlockHeight: admissionBlock.height,
  transactionProof: createTransactionProof(admissionBlock.transactions, 0),
  trustedValidators: validatorMembers,
}) + "\n");

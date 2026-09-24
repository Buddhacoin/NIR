import { createHash } from "node:crypto";

import {
  NirChain, createCandidateBond, createProgressCommitment, finalizeBlock,
} from "../blockchain/chain.mjs";
import {
  EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION, MIN_PROGRESS_CANDIDATE_BOND,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createFinalityProof } from "../blockchain/light-client.mjs";
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
const treasury = generateWallet();
const submitter = generateWallet();
const validatorMembers = members(validators, "validator");
const chain = new NirChain({
  beaconAuthorities: members(beacons, "beacon"),
  capabilityReferences: [{
    artifactHash: `sha256:${fingerprint("baseline")}`,
    contentHash: `sha256:${fingerprint("baseline-content")}`,
    behaviorCommitment: fingerprint("baseline-behavior"),
    capabilitiesBps: { "reasoning-v1": 100 },
  }],
  evaluators: members(evaluators, "evaluator"),
  genesisProtocolVersion: EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION,
  genesisTimestamp: 0,
  networkId: "nir-assignment-anchor-test",
  safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
  treasuryAddress: treasury.address,
  validators: validatorMembers,
});
const genesis = chain.blocks()[0];
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
const sign = (proposal) => finalizeBlock(proposal, [
  validators.find((wallet) => wallet.address === proposal.proposer),
  ...validators.filter((wallet) => wallet.address !== proposal.proposer).slice(0, 2),
]);
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
    height: 0, protocolVersion: EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION,
    stateRoot: genesis.stateRoot, tipHash: genesis.hash,
  },
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
  transactionBlockHeight: admissionBlock.height,
  transactionProof: createTransactionProof(admissionBlock.transactions, 0),
  trustedValidators: validatorMembers,
}) + "\n");

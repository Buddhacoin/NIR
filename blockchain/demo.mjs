import { createHash } from "node:crypto";

import {
  NirChain,
  createCandidateBond,
  createProgressCommitment,
  createProgressClaim,
  finalizeBlock,
  formatNir,
} from "./chain.mjs";
import { generateWallet, publicWallet } from "./crypto.mjs";
import {
  INITIAL_EPOCH_REWARD, SAFETY_POLICY_V1_COMMITMENT, TREASURY_VESTING_MS,
} from "./constants.mjs";
import {
  createEpochRandomnessCommit,
  createEpochRandomnessReveal,
  createProgressBeacon,
  createProgressBeaconShare,
} from "./operators.mjs";

const validators = Array.from({ length: 4 }, generateWallet);
const evaluators = Array.from({ length: 4 }, generateWallet);
const beaconAuthorities = Array.from({ length: 4 }, generateWallet);
const founder = generateWallet();
const alice = generateWallet();
const genesisTimestamp = Date.now() - TREASURY_VESTING_MS;
const baselineArtifact = `sha256:${createHash("sha256")
  .update("baseline")
  .digest("hex")}`;
const chain = new NirChain({
  beaconAuthorities: beaconAuthorities.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `beacon-${index}`,
  })),
  capabilityReferences: [
    {
      artifactHash: baselineArtifact,
      contentHash: `sha256:${createHash("sha256").update("baseline-content").digest("hex")}`,
      behaviorCommitment: createHash("sha256")
        .update("baseline-behavior")
        .digest("hex"),
      capabilitiesBps: { "code-v1": 7_000, "reasoning-v1": 8_000 },
    },
  ],
  genesisTimestamp,
  networkId: "nir-localnet-1",
  safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
  validators: validators.map((wallet, index) => ({
    ...publicWallet(wallet),
    operatorId: `validator-${index}`,
  })),
  evaluators: evaluators.map((wallet, index) => ({
    ...publicWallet(wallet),
    operatorId: `evaluator-${index}`,
  })),
  treasuryAddress: founder.address,
});

function quorumFor(block) {
  const proposer = validators.find((wallet) => wallet.address === block.proposer);
  return [
    proposer,
    ...validators.filter((wallet) => wallet !== proposer).slice(0, 2),
  ];
}

const proofFingerprint = createHash("sha256")
  .update("nir-genesis-proof-1")
  .digest("hex");
const suiteCommitment = createHash("sha256").update("hidden-suite-v1").digest("hex");
const admission = createProgressCommitment({
  wallet: alice,
  networkId: chain.networkId,
  recipient: alice.address,
  artifactHash: `sha256:${proofFingerprint}`,
  baselineHash: baselineArtifact,
  baselineContentHash: `sha256:${createHash("sha256").update("baseline-content").digest("hex")}`,
  suiteCommitment,
  nonce: chain.nextNonce(alice.address),
});
const admissionTimestamp = Date.now();
const progressBond = createCandidateBond({
  wallet: founder,
  networkId: chain.networkId,
  candidateId: admission.candidateId,
  candidateOwner: alice.address,
  purpose: "progress",
  amount: INITIAL_EPOCH_REWARD.toString(),
  fee: "0",
  nonce: chain.nextNonce(founder.address),
});
const bondBlock = chain.buildBlock({ transactions: [progressBond], timestamp: admissionTimestamp });
chain.appendBlock(finalizeBlock(bondBlock, quorumFor(bondBlock)));
const admissionBlock = chain.buildBlock({
  transactions: [admission],
  timestamp: admissionTimestamp,
});
chain.appendBlock(finalizeBlock(admissionBlock, quorumFor(admissionBlock)));
const epoch = chain.epochRandomnessStatus();
const epochMembers = epoch.committee.map((address) =>
  beaconAuthorities.find((wallet) => wallet.address === address));
const epochSecrets = epochMembers.map((_, index) =>
  createHash("sha256").update(`epoch-${epoch.round}-${index}`).digest("hex"));
const epochCommitBlock = chain.buildBlock({
  epochRandomnessCommits: epochMembers.map((wallet, index) => createEpochRandomnessCommit({
    wallet, networkId: chain.networkId, round: epoch.round, secret: epochSecrets[index],
  })),
  timestamp: admissionTimestamp,
});
chain.appendBlock(finalizeBlock(epochCommitBlock, quorumFor(epochCommitBlock)));
const epochRevealBlock = chain.buildBlock({
  epochRandomnessReveals: epochMembers.map((wallet, index) => createEpochRandomnessReveal({
    wallet, networkId: chain.networkId, round: epoch.round, secret: epochSecrets[index],
  })),
  timestamp: admissionTimestamp,
});
chain.appendBlock(finalizeBlock(epochRevealBlock, quorumFor(epochRevealBlock)));
const challengeRound = chain.height + 1;
const challengeAuthorities = chain.progressBeaconCommittee(admission.candidateId)
  .map((address) => beaconAuthorities.find((wallet) => wallet.address === address));
const challengeShares = challengeAuthorities.map((wallet, index) =>
  createProgressBeaconShare({
    wallet,
    networkId: chain.networkId,
    candidateId: admission.candidateId,
    round: challengeRound,
    value: createHash("sha256").update(`progress-beacon-${index}`).digest("hex"),
  }));
const challengeBlock = chain.buildBlock({
  progressBeacons: [createProgressBeacon({
    shares: challengeShares,
    networkId: chain.networkId,
    candidateId: admission.candidateId,
    round: challengeRound,
  })],
  timestamp: admissionTimestamp,
});
chain.appendBlock(finalizeBlock(challengeBlock, quorumFor(challengeBlock)));
const challenge = chain.progressChallenge(admission.candidateId);
const evaluation = chain.prepareProgressEvaluation({
  artifactHash: `sha256:${proofFingerprint}`,
  baselineHash: baselineArtifact,
  baselineContentHash: admission.baselineContentHash,
  candidateId: admission.candidateId,
  executionBundleHash: createHash("sha256").update("evaluation-bundle-1").digest("hex"),
  suiteCommitment,
  parents: [baselineArtifact],
  committedEpoch: challenge.committedHeight,
  challengeEpoch: chain.height + 1,
  challengeSeed: challenge.challengeSeed,
  behaviorCommitment: createHash("sha256")
    .update("candidate-behavior")
    .digest("hex"),
  capabilitiesBps: { "code-v1": 8_400, "reasoning-v1": 8_200 },
  gainPpm: 90_000,
  generalityBps: 10_000,
  reproducibilityBps: 10_000,
  safetyBps: 10_000,
  safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT,
  criticalSafetyPass: true,
  candidateEnergyWh: 720,
  baselineEnergyWh: 1_000,
  energyAttested: true,
});
const progressClaim = createProgressClaim({
  networkId: chain.networkId,
  epoch: chain.height + 1,
  recipient: alice.address,
  evaluation,
  evaluatorWallets: challenge.committee.map((address) =>
    evaluators.find((wallet) => wallet.address === address)),
});
const rewardBlock = chain.buildBlock({
  rewardClaims: [progressClaim],
  timestamp: admissionTimestamp + 1,
});
chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock)));
const pendingReward = chain.accountState(alice.address).resources.pendingProgressReward;

console.log(`height: ${chain.height}`);
console.log(`issued: ${formatNir(chain.issued)}`);
console.log(`alice available: ${formatNir(chain.balance(alice.address))}`);
console.log(`alice pending: ${formatNir(BigInt(pendingReward.amount))}`);
console.log(`reward unlock height: ${pendingReward.nextUnlockHeight}`);
console.log(`final block: ${chain.tipHash}`);
console.log("signature suite: ML-DSA-65");

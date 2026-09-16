import { createHash } from "node:crypto";

import {
  NirChain,
  createProgressCommitment,
  createProgressClaim,
  createTransfer,
  finalizeBlock,
  formatNir,
} from "./chain.mjs";
import { generateWallet, publicWallet } from "./crypto.mjs";
import { SAFETY_POLICY_V1_COMMITMENT } from "./constants.mjs";
import { createProgressBeacon, createProgressBeaconShare } from "./operators.mjs";

const validators = Array.from({ length: 4 }, generateWallet);
const evaluators = Array.from({ length: 4 }, generateWallet);
const beaconAuthorities = Array.from({ length: 4 }, generateWallet);
const founder = generateWallet();
const alice = generateWallet();
const bob = generateWallet();
const genesisTimestamp = Date.now();
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
  suiteCommitment,
  nonce: chain.nextNonce(alice.address),
});
const admissionBlock = chain.buildBlock({
  transactions: [admission],
  timestamp: genesisTimestamp,
});
chain.appendBlock(finalizeBlock(admissionBlock, quorumFor(admissionBlock)));
const challengeRound = chain.height + 1;
const challengeShares = beaconAuthorities.slice(0, 3).map((wallet, index) =>
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
  timestamp: genesisTimestamp,
});
chain.appendBlock(finalizeBlock(challengeBlock, quorumFor(challengeBlock)));
const challenge = chain.progressChallenge(admission.candidateId);
const evaluation = chain.prepareProgressEvaluation({
  artifactHash: `sha256:${proofFingerprint}`,
  baselineHash: baselineArtifact,
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
  gainPpm: 396_112,
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
  timestamp: genesisTimestamp + 1,
});
chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock)));

const payment = createTransfer({
  wallet: alice,
  networkId: chain.networkId,
  recipient: bob.address,
  amount: "200000000",
  nonce: chain.nextNonce(alice.address),
  fee: "1000",
});
const paymentBlock = chain.buildBlock({
  transactions: [payment],
  timestamp: genesisTimestamp + 2,
});
chain.appendBlock(finalizeBlock(paymentBlock, quorumFor(paymentBlock)));

console.log(`height: ${chain.height}`);
console.log(`issued: ${formatNir(chain.issued)}`);
console.log(`alice: ${formatNir(chain.balance(alice.address))}`);
console.log(`bob: ${formatNir(chain.balance(bob.address))}`);
console.log(`final block: ${chain.tipHash}`);
console.log("signature suite: ML-DSA-65");

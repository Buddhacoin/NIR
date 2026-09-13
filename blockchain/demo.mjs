import { createHash } from "node:crypto";

import {
  NirChain,
  createProgressClaim,
  createTransfer,
  finalizeBlock,
  formatNir,
} from "./chain.mjs";
import { generateWallet, publicWallet } from "./crypto.mjs";

const validators = Array.from({ length: 4 }, generateWallet);
const founder = generateWallet();
const alice = generateWallet();
const bob = generateWallet();
const genesisTimestamp = Date.now();
const baselineArtifact = `sha256:${createHash("sha256")
  .update("baseline")
  .digest("hex")}`;
const chain = new NirChain({
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
  validators: validators.map(publicWallet),
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
const evaluation = chain.prepareProgressEvaluation({
  artifactHash: `sha256:${proofFingerprint}`,
  baselineHash: baselineArtifact,
  suiteCommitment: createHash("sha256").update("hidden-suite-v1").digest("hex"),
  parents: [baselineArtifact],
  committedEpoch: 0,
  challengeEpoch: 1,
  challengeSeed: createHash("sha256").update("challenge-1").digest("hex"),
  behaviorCommitment: createHash("sha256")
    .update("candidate-behavior")
    .digest("hex"),
  capabilitiesBps: { "code-v1": 8_400, "reasoning-v1": 8_200 },
  gainPpm: 396_112,
  generalityBps: 10_000,
  reproducibilityBps: 10_000,
  safetyBps: 10_000,
  candidateEnergyWh: 720,
  baselineEnergyWh: 1_000,
  energyAttested: true,
});
const progressClaim = createProgressClaim({
  networkId: chain.networkId,
  epoch: 1,
  recipient: alice.address,
  evaluation,
  evaluatorWallets: validators.slice(0, 3),
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

import { createHash } from "node:crypto";

import {
  NirChain, createCandidateBond, createProgressCommitment, finalizeBlock,
} from "../blockchain/chain.mjs";
import {
  MIN_PROGRESS_CANDIDATE_BOND, PROTOCOL_VERSION, SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createFinalityProof } from "../blockchain/light-client.mjs";
import { createTransactionProof } from "../blockchain/transaction-tree.mjs";

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
  genesisProtocolVersion: PROTOCOL_VERSION + 1,
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
const anchorBlock = sign(chain.buildBlock({
  transactions: [], timestamp: TREASURY_VESTING_MS + 1,
}));
chain.appendBlock(anchorBlock);

process.stdout.write(JSON.stringify({
  checkpoint: {
    height: 0, protocolVersion: PROTOCOL_VERSION + 1,
    stateRoot: genesis.stateRoot, tipHash: genesis.hash,
  },
  commitmentTransaction: admission,
  evaluator: publicWallet(evaluators[0]),
  finalityProofs: [
    createFinalityProof(bondBlock), createFinalityProof(admissionBlock),
    createFinalityProof(anchorBlock),
  ],
  finalizedHeight: anchorBlock.height,
  genesisHash: genesis.hash,
  networkId: chain.networkId,
  stateRoot: anchorBlock.stateRoot,
  transactionBlockHeight: admissionBlock.height,
  transactionProof: createTransactionProof(admissionBlock.transactions, 0),
  trustedValidators: validatorMembers,
}) + "\n");

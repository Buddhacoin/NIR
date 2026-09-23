import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  NirChain,
  MAX_PROGRESS_FRAUD_EVIDENCE,
  MAX_PROGRESS_REWARD_ESCROWS,
  MAX_PROGRESS_COMMITMENT_AGE,
  PROGRESS_BOND_BINDING_TIMEOUT_BLOCKS,
  allocateProgressRewards,
  blockHash,
  computeProgressScore,
  computeChainStateRoot,
  createBeaconBond,
  createCreditStake,
  createCreditDelegation,
  createCreditTransfer,
  createCreditUnstakeClaim,
  createCreditUnstakeRequest,
  createDelegatedCreditTransfer,
  createEvaluatorBond,
  createCandidateBond,
  createProgressCommitment,
  progressCandidateId,
  createValidatorBond,
  createProgressClaim,
  createProgressEvaluatorEquivocationEvidence,
  createSponsoredTransfer,
  createTransfer,
  createMultisigTransfer,
  finalizeBlock,
  formatFeePercent,
  formatNir,
  multisigAddress,
  quoteTransferFee,
  transactionId,
} from "../blockchain/chain.mjs";
import { accountHistoryCommitment } from "../blockchain/account-history.mjs";
import { verifyAccountStateProof } from "../blockchain/account-tree.mjs";
import {
  BEACON_NON_REVEAL_SLASH_BPS,
  CREDIT_UNSTAKE_DELAY_BLOCKS,
  EPOCH_REVEAL_TIMEOUT_BLOCKS,
  EVALUATOR_ACTIVATION_DELAY_BLOCKS,
  MAX_CREDIT_TRANSFERS_PER_BLOCK,
  MAX_FUTURE_DRIFT_MS,
  MIN_REWARD_INTERVAL_MS,
  MINING_POOL,
  MIN_PROGRESS_CANDIDATE_BOND,
  MIN_EVALUATOR_BOND,
  MIN_BEACON_BOND,
  MIN_TRANSFER_FEE,
  MAX_SUPPLY,
  MAX_TRANSACTIONS_PER_BLOCK,
  INITIAL_EPOCH_REWARD,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_ALLOCATION,
  TREASURY_VESTING_MS,
  TRANSFER_CREDIT_STAKE_UNIT,
  TRANSFER_CREDITS_PER_STAKE_UNIT,
  PROGRESS_REWARD_ESCROW_DELAY_BLOCKS,
  scheduledEpochBudget,
} from "../blockchain/constants.mjs";
import {
  generateWallet,
  publicWallet,
  signObject,
  verifyObject,
} from "../blockchain/crypto.mjs";
import { CapabilityMemory } from "../blockchain/memory.mjs";
import { createSafetyFailureClaim } from "../blockchain/safety-bounty.mjs";
import {
  createFallbackBeacon,
  createFallbackBeaconShare,
  createEpochRandomnessCommit,
  createEpochRandomnessReveal,
  createOperatorCredential,
  createProgressBeacon,
  createProgressBeaconShare,
  createRandomnessCommit,
  createRandomnessReveal,
} from "../blockchain/operators.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";

function operatorMembers(wallets, prefix) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet),
    operatorId: `${prefix}-${index}`,
  }));
}

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beaconAuthorities = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const genesisConfig = {
    capabilityReferences: [
      {
        artifactHash: `sha256:${fingerprint("baseline")}`,
        contentHash: `sha256:${fingerprint("baseline-content")}`,
        behaviorCommitment: fingerprint("baseline-behavior"),
        capabilitiesBps: { "code-v1": 7_000, "reasoning-v1": 8_000 },
      },
    ],
    beaconAuthorities: operatorMembers(beaconAuthorities, "beacon"),
    genesisTimestamp: 0,
    networkId: "nir-testnet",
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    validators: operatorMembers(validators, "validator"),
    evaluators: operatorMembers(evaluators, "evaluator"),
    treasuryAddress: treasury.address,
  };
  const chain = new NirChain(genesisConfig);
  TEST_BEACON_WALLETS.set(chain, beaconAuthorities);
  TEST_TREASURY_WALLETS.set(chain, treasury);
  return { beaconAuthorities, chain, evaluators, genesisConfig, treasury, validators };
}

const TEST_BEACON_WALLETS = new WeakMap();
const TEST_TREASURY_WALLETS = new WeakMap();

function fingerprint(label) {
  return createHash("sha256").update(label).digest("hex");
}

function quorumFor(block, validators) {
  const proposer = validators.find((wallet) => wallet.address === block.proposer);
  return [
    proposer,
    ...validators.filter((wallet) => wallet !== proposer).slice(0, 2),
  ];
}

function lockProgressBond(chain, validators, candidateOwner, candidateId, timestamp,
  amount = MIN_PROGRESS_CANDIDATE_BOND) {
  const sponsor = TEST_TREASURY_WALLETS.get(chain);
  const bond = createCandidateBond({
    wallet: sponsor, networkId: chain.networkId, candidateId,
    candidateOwner, purpose: "progress",
    amount: amount.toString(), fee: "0",
    nonce: chain.nextNonce(sponsor.address),
  });
  const block = chain.buildBlock({ transactions: [bond], timestamp });
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  return timestamp;
}

function currentTimestamp(chain, offset = 0) {
  return chain.blocks().at(-1).timestamp + offset;
}

function assertProgressBondConservation(chain) {
  const state = chain.consensusSnapshot().state;
  const liquid = state.balances.reduce((total, [, amount]) => total + BigInt(amount), 0n);
  const locked = state.candidateBonds.reduce(
    (total, [, bond]) => total + BigInt(bond.bond), 0n,
  );
  const escrowedRewards = state.progressEscrows.reduce(
    (total, [, escrow]) => total + BigInt(escrow.amount), 0n,
  );
  const evaluatorBonds = state.evaluatorBonds.reduce(
    (total, [, amount]) => total + BigInt(amount), 0n,
  );
  assert.equal(liquid + locked + evaluatorBonds + escrowedRewards + chain.burned, chain.issued);
  assert.equal(chain.circulatingSupply, chain.issued - chain.burned);
  assert.ok(chain.issued <= MAX_SUPPLY);
}

function advanceEmptyBlocks(chain, validators, count, timestamp = currentTimestamp(chain)) {
  for (let index = 0; index < count; index += 1) {
    const block = chain.buildBlock({ timestamp });
    chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  }
}

function matureProgressRewards(chain, validators) {
  const escrows = chain.consensusSnapshot().state.progressEscrows;
  if (escrows.length === 0) return;
  const unlockHeight = Math.max(...escrows.map(([, escrow]) => escrow.unlockHeight));
  advanceEmptyBlocks(chain, validators, unlockHeight - chain.height);
}

function assignedEvaluatorWallets(chain, candidateId, evaluators) {
  return chain.assignedSafetyEvaluators(candidateId).map((address) => {
    const wallet = evaluators.find((candidate) => candidate.address === address);
    assert.ok(wallet, "assigned evaluator must exist in the genesis registry");
    return wallet;
  });
}

function finalizeRandomness(chain, candidateId, validators, timestamp) {
  const contributors = validators.slice(0, 3).map((wallet, index) => ({
    secret: fingerprint(`${candidateId}-random-${index}`), wallet,
  }));
  const commitBlock = chain.buildBlock({
    randomnessCommits: contributors.map(({ secret, wallet }) => createRandomnessCommit({
      wallet, networkId: chain.networkId, candidateId, secret,
    })),
    timestamp,
  });
  chain.appendBlock(finalizeBlock(commitBlock, quorumFor(commitBlock, validators)));
  const revealBlock = chain.buildBlock({
    randomnessReveals: contributors.map(({ secret, wallet }) => createRandomnessReveal({
      wallet, networkId: chain.networkId, candidateId, secret,
    })),
    timestamp: timestamp + 1,
  });
  chain.appendBlock(finalizeBlock(revealBlock, quorumFor(revealBlock, validators)));
}

function activateRandomnessValidators(chain, validators, funder, timestamp) {
  const participants = validators.slice(0, 3);
  const startingNonce = chain.nextNonce(funder.address);
  const funding = participants.map((validator, index) => createTransfer({
    wallet: funder, networkId: chain.networkId, recipient: validator.address,
    amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE).toString(), nonce: startingNonce + index,
  }));
  const fundingBlock = chain.buildBlock({ transactions: funding, timestamp });
  chain.appendBlock(finalizeBlock(fundingBlock, quorumFor(fundingBlock, validators)));
  const registrations = participants.map((validator) => createValidatorBond({
    wallet: validator, networkId: chain.networkId,
    amount: MIN_VALIDATOR_BOND.toString(), nonce: chain.nextNonce(validator.address),
  }));
  const registrationBlock = chain.buildBlock({ transactions: registrations, timestamp: timestamp + 1 });
  chain.appendBlock(finalizeBlock(registrationBlock, quorumFor(registrationBlock, validators)));
  return timestamp + 2;
}

function advanceEpochRandomness(chain, beaconAuthorities, validators, timestamp) {
  const status = chain.epochRandomnessStatus();
  const members = status.committee.map((address) =>
    beaconAuthorities.find((wallet) => wallet.address === address));
  const secrets = members.map((_, index) =>
    fingerprint(`epoch-${status.round}-secret-${index}`));
  const commitBlock = chain.buildBlock({
    epochRandomnessCommits: members.map((wallet, index) => createEpochRandomnessCommit({
      wallet, networkId: chain.networkId, round: status.round, secret: secrets[index],
    })),
    timestamp,
  });
  chain.appendBlock(finalizeBlock(commitBlock, quorumFor(commitBlock, validators)));
  const revealBlock = chain.buildBlock({
    epochRandomnessReveals: members.map((wallet, index) => createEpochRandomnessReveal({
      wallet, networkId: chain.networkId, round: status.round, secret: secrets[index],
    })),
    timestamp,
  });
  chain.appendBlock(finalizeBlock(revealBlock, quorumFor(revealBlock, validators)));
}

function progressClaim(
  chain,
  evaluators,
  validators,
  submitterWallet,
  label = "proof-a",
  recipient = submitterWallet.address,
  canonicalContentLabel = `artifact-${label}`,
  bondAmount = INITIAL_EPOCH_REWARD,
) {
  const artifactHash = `sha256:${fingerprint(`artifact-${label}`)}`;
  const contentHash = `sha256:${fingerprint(canonicalContentLabel)}`;
  const baselineHash = `sha256:${fingerprint("baseline")}`;
  const baselineContentHash = `sha256:${fingerprint("baseline-content")}`;
  const suiteCommitment = fingerprint("hidden-suite-v1");
  let timestamp = chain.blocks().at(-1).timestamp;
  const admission = createProgressCommitment({
    wallet: submitterWallet,
    networkId: chain.networkId,
    recipient,
    artifactHash,
    baselineHash,
    baselineContentHash,
    contentHash,
    suiteCommitment,
    nonce: chain.nextNonce(submitterWallet.address),
  });
  timestamp = lockProgressBond(
    chain, validators, submitterWallet.address, admission.candidateId,
    Math.max(timestamp, TREASURY_VESTING_MS), bondAmount,
  );
  const admissionBlock = chain.buildBlock({ transactions: [admission], timestamp });
  chain.appendBlock(finalizeBlock(admissionBlock, quorumFor(admissionBlock, validators)));
  const beaconAuthorities = TEST_BEACON_WALLETS.get(chain);
  advanceEpochRandomness(chain, beaconAuthorities, validators, timestamp);
  const assignedBeacons = chain.progressBeaconCommittee(admission.candidateId)
    .map((address) => beaconAuthorities.find((wallet) => wallet.address === address));
  const round = chain.height + 1;
  const shares = assignedBeacons.map((wallet, index) =>
    createProgressBeaconShare({
      wallet, networkId: chain.networkId, candidateId: admission.candidateId,
      round, value: fingerprint(`${admission.candidateId}-progress-beacon-${index}`),
    }));
  const challengeBlock = chain.buildBlock({
    progressBeacons: [createProgressBeacon({
      shares, networkId: chain.networkId, candidateId: admission.candidateId, round,
    })],
    timestamp,
  });
  chain.appendBlock(finalizeBlock(challengeBlock, quorumFor(challengeBlock, validators)));
  const challenge = chain.progressChallenge(admission.candidateId);
  const assignedEvaluators = challenge.committee.map((address) =>
    evaluators.find((wallet) => wallet.address === address));
  const capabilitiesBps = label.startsWith("independent-")
    ? { "code-v1": 7_000, "reasoning-v1": 8_000, "vision-v1": 1_000 }
    : label === "second-frontier"
      ? { "code-v1": 8_600, "reasoning-v1": 8_400 }
      : { "code-v1": 8_400, "reasoning-v1": 8_200 };
  const evaluation = chain.prepareProgressEvaluation({
    artifactHash,
    baselineHash,
    baselineContentHash,
    contentHash,
    candidateId: admission.candidateId,
    executionBundleHash: fingerprint(`execution-bundle-${label}`),
    suiteCommitment,
    parents: [`sha256:${fingerprint("baseline")}`],
    committedEpoch: challenge.committedHeight,
    challengeEpoch: chain.height + 1,
    challengeSeed: challenge.challengeSeed,
    behaviorCommitment: fingerprint(`behavior-${label}`),
    capabilitiesBps,
    gainPpm: 10_000,
    generalityBps: 10_000,
    reproducibilityBps: 10_000,
    safetyBps: 10_000,
    safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT,
    criticalSafetyPass: true,
    candidateEnergyWh: 100,
    baselineEnergyWh: 100,
    energyAttested: true,
  });
  return createProgressClaim({
    networkId: chain.networkId,
    epoch: chain.height + 1,
    recipient,
    evaluation,
    evaluatorWallets: assignedEvaluators,
  });
}

test("ML-DSA-65 detects a modified message", () => {
  const wallet = generateWallet();
  assert.match(wallet.address, /^nir1[0-9a-f]{64}$/);
  const signature = signObject({ value: 1 }, wallet, "TEST");
  assert.equal(verifyObject({ value: 1 }, signature, wallet.publicKey, "TEST"), true);
  assert.equal(verifyObject({ value: 2 }, signature, wallet.publicKey, "TEST"), false);
  assert.equal(verifyObject({ value: 1 }, signature, wallet.publicKey, "OTHER"), false);
});

test("a classical key cannot masquerade as ML-DSA-65", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const fakeWallet = {
    algorithm: "ml-dsa-65",
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
  assert.throws(() => signObject({ value: 1 }, fakeWallet, "TEST"), /not ML-DSA-65/);
});

test("fresh genesis funds evaluator bonds without hidden issuance", () => {
  const { chain, evaluators, treasury } = fixture();
  assert.equal(chain.issued, TREASURY_ALLOCATION);
  const evaluatorBonds = evaluators.reduce(
    (total, evaluator) => total + chain.evaluatorBond(evaluator.address), 0n,
  );
  assert.equal(evaluatorBonds, BigInt(evaluators.length) * MIN_EVALUATOR_BOND);
  assert.equal(chain.balance(treasury.address) + evaluatorBonds, TREASURY_ALLOCATION);
  assert.ok(chain.issued < MAX_SUPPLY);
});

test("fixed block and transaction schemas reject extra fields", () => {
  const { chain, treasury, validators } = fixture();
  const transaction = createTransfer({
    wallet: treasury,
    networkId: chain.networkId,
    recipient: generateWallet().address,
    amount: "1",
    nonce: 0,
  });
  const invalidTransactionBlock = chain.buildBlock({
    transactions: [{ ...transaction, ignoredBySomeImplementations: true }],
    timestamp: 1,
  });
  assert.throws(() => chain.validateProposal(invalidTransactionBlock), /transaction schema/);

  const proposal = chain.buildBlock({ timestamp: 1 });
  const finalized = finalizeBlock(proposal, quorumFor(proposal, validators));
  assert.throws(() => chain.appendBlock({ ...finalized, unexpected: null }), /block schema/);
  assert.equal(chain.height, 0);
});

test("evaluation and consensus operators must be independent", () => {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beaconAuthorities = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const evaluatorMembers = operatorMembers(evaluators, "evaluator");
  evaluatorMembers[0].operatorId = "validator-0";
  assert.throws(
    () => new NirChain({
      capabilityReferences: [
        {
          artifactHash: `sha256:${fingerprint("baseline")}`,
          contentHash: `sha256:${fingerprint("baseline-content")}`,
          behaviorCommitment: fingerprint("baseline-behavior"),
          capabilitiesBps: { "code-v1": 7_000, "reasoning-v1": 8_000 },
        },
      ],
      beaconAuthorities: operatorMembers(beaconAuthorities, "beacon"),
      evaluators: evaluatorMembers,
      genesisTimestamp: 0,
      networkId: "nir-role-separation-test",
      safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
      treasuryAddress: treasury.address,
      validators: operatorMembers(validators, "validator"),
    }),
    /must be disjoint/,
  );
});

test("Python and JavaScript capability memory use the same state root", () => {
  const memory = new CapabilityMemory([
    {
      artifactHash: `sha256:${fingerprint("known-model-a")}`,
      behaviorCommitment: fingerprint("known-behavior-a"),
      capabilitiesBps: { "code-v1": 7_000, "reasoning-v1": 8_000 },
    },
    {
      artifactHash: `sha256:${fingerprint("known-model-b")}`,
      behaviorCommitment: fingerprint("known-behavior-b"),
      capabilitiesBps: { "code-v1": 8_000, "reasoning-v1": 7_500 },
    },
  ]);
  assert.equal(
    memory.stateRoot,
    "4eb7e97065945992e4f1b1b3e62937ccf55c91fdaa3509d3383445c55dd5b868",
  );
});

test("fresh genesis can reach its first reward with the committed evaluator bonds", () => {
  const { chain, evaluators, treasury, validators } = fixture();
  const miner = generateWallet();
  const memoryRootBefore = chain.capabilityMemoryRoot;
  const sponsorBalanceBefore = chain.balance(treasury.address);
  const block = chain.buildBlock({
    rewardClaims: [
      progressClaim(chain, evaluators, validators, miner),
    ],
    timestamp: currentTimestamp(chain),
  });
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  assert.equal(formatNir(chain.balance(miner.address)), "0.00000000 NIR");
  assert.equal(chain.balance(treasury.address), sponsorBalanceBefore - INITIAL_EPOCH_REWARD);
  assert.equal(chain.capabilityMemoryRoot, memoryRootBefore);
  assert.equal(chain.accountState(miner.address).resources.pendingProgressReward.amount,
    INITIAL_EPOCH_REWARD.toString());
  advanceEmptyBlocks(chain, validators, PROGRESS_REWARD_ESCROW_DELAY_BLOCKS - 1);
  assert.equal(chain.balance(miner.address), 0n);
  assert.equal(chain.capabilityMemoryRoot, memoryRootBefore);
  advanceEmptyBlocks(chain, validators, 1);
  assert.equal(formatNir(chain.balance(miner.address)), "50.00000000 NIR");
  assert.equal(chain.balance(treasury.address), sponsorBalanceBefore);
  assert.notEqual(chain.capabilityMemoryRoot, memoryRootBefore);
  assert.equal(
    chain.capabilityMemoryRoot,
    block.progressRewards[0].evaluation.frontierRootAfter,
  );
});

test("progress issuance cannot exceed the exact candidate bond at risk", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const claim = progressClaim(
    chain, evaluators, validators, miner, "under-collateralized", miner.address,
    "under-collateralized-content", MIN_PROGRESS_CANDIDATE_BOND,
  );
  const rootBefore = chain.stateRoot;
  assert.throws(
    () => chain.buildBlock({ rewardClaims: [claim], timestamp: currentTimestamp(chain) }),
    /exceeds its locked candidate bond collateral/,
  );
  assert.equal(chain.stateRoot, rootBefore);
});

test("one empty boundary block matures multiple independent progress escrows", () => {
  const { beaconAuthorities, chain, evaluators, treasury, validators } = fixture();
  const owners = [generateWallet(), generateWallet()];
  const definitions = owners.map((owner, index) => ({
    owner,
    artifactHash: `sha256:${fingerprint(`batch-artifact-${index}`)}`,
    contentHash: `sha256:${fingerprint(`batch-content-${index}`)}`,
    suiteCommitment: fingerprint(`batch-suite-${index}`),
  }));
  const admissions = definitions.map((definition) => createProgressCommitment({
    wallet: definition.owner, networkId: chain.networkId, recipient: definition.owner.address,
    artifactHash: definition.artifactHash, baselineHash: `sha256:${fingerprint("baseline")}`,
    baselineContentHash: `sha256:${fingerprint("baseline-content")}`,
    contentHash: definition.contentHash, suiteCommitment: definition.suiteCommitment, nonce: 0,
  }));
  const bonds = admissions.map((admission, index) => createCandidateBond({
    wallet: treasury, networkId: chain.networkId, candidateId: admission.candidateId,
    candidateOwner: owners[index].address, purpose: "progress",
    amount: INITIAL_EPOCH_REWARD.toString(), fee: "0", nonce: index,
  }));
  let block = chain.buildBlock({ transactions: bonds, timestamp: TREASURY_VESTING_MS });
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  block = chain.buildBlock({ transactions: admissions, timestamp: TREASURY_VESTING_MS });
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  advanceEpochRandomness(chain, beaconAuthorities, validators, TREASURY_VESTING_MS);

  const round = chain.height + 1;
  const progressBeacons = admissions.map((admission) => {
    const wallets = chain.progressBeaconCommittee(admission.candidateId)
      .map((address) => beaconAuthorities.find((wallet) => wallet.address === address));
    return createProgressBeacon({
      networkId: chain.networkId, candidateId: admission.candidateId, round,
      shares: wallets.map((wallet, index) => createProgressBeaconShare({
        wallet, networkId: chain.networkId, candidateId: admission.candidateId, round,
        value: fingerprint(`${admission.candidateId}-batch-beacon-${index}`),
      })),
    });
  });
  block = chain.buildBlock({ progressBeacons, timestamp: TREASURY_VESTING_MS });
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));

  const claims = admissions.map((admission, index) => {
    const challenge = chain.progressChallenge(admission.candidateId);
    const evaluation = chain.prepareProgressEvaluation({
      artifactHash: definitions[index].artifactHash,
      baselineHash: `sha256:${fingerprint("baseline")}`,
      baselineContentHash: `sha256:${fingerprint("baseline-content")}`,
      contentHash: definitions[index].contentHash,
      candidateId: admission.candidateId,
      executionBundleHash: fingerprint(`batch-execution-${index}`),
      suiteCommitment: definitions[index].suiteCommitment,
      parents: [`sha256:${fingerprint("baseline")}`],
      committedEpoch: challenge.committedHeight, challengeEpoch: chain.height + 1,
      challengeSeed: challenge.challengeSeed,
      behaviorCommitment: fingerprint(`batch-behavior-${index}`),
      capabilitiesBps: index === 0
        ? { "code-v1": 8_400, "reasoning-v1": 8_200 }
        : { "code-v1": 7_000, "reasoning-v1": 8_000, "vision-v1": 1_000 },
      gainPpm: 10_000, generalityBps: 10_000, reproducibilityBps: 10_000,
      safetyBps: 10_000, safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT,
      criticalSafetyPass: true, candidateEnergyWh: 100, baselineEnergyWh: 100,
      energyAttested: true,
    });
    return createProgressClaim({
      networkId: chain.networkId, epoch: chain.height + 1, recipient: owners[index].address,
      evaluation, evaluatorWallets: challenge.committee.map((address) =>
        evaluators.find((wallet) => wallet.address === address)),
    });
  });
  const memoryBefore = chain.capabilityMemoryRoot;
  block = chain.buildBlock({ rewardClaims: claims, timestamp: TREASURY_VESTING_MS });
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  const allocations = new Map(block.progressRewards.map((reward) =>
    [reward.recipient, BigInt(reward.amount)]));
  advanceEmptyBlocks(chain, validators, PROGRESS_REWARD_ESCROW_DELAY_BLOCKS - 1,
    TREASURY_VESTING_MS);
  assert.deepEqual(owners.map(({ address }) => chain.balance(address)), [0n, 0n]);
  assert.equal(chain.capabilityMemoryRoot, memoryBefore);
  advanceEmptyBlocks(chain, validators, 1, TREASURY_VESTING_MS);
  assert.deepEqual(owners.map(({ address }) => chain.balance(address)),
    owners.map(({ address }) => allocations.get(address)));
  assert.notEqual(chain.capabilityMemoryRoot, memoryBefore);
  assert.equal(chain.consensusSnapshot().state.progressEscrows.length, 0);
});

test("objective evaluator equivocation slashes once and bonded replacements recover progress", () => {
  const { beaconAuthorities, chain, evaluators, genesisConfig, treasury, validators } = fixture();
  const miner = generateWallet();
  const memoryRootBefore = chain.capabilityMemoryRoot;
  const claim = progressClaim(chain, evaluators, validators, miner, "escrow-fraud");
  const rewardBlock = chain.buildBlock({ rewardClaims: [claim], timestamp: currentTimestamp(chain) });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  const proof = chain.accountStateProof(miner.address);
  assert.equal(proof.account.resources.pendingProgressReward.amount, INITIAL_EPOCH_REWARD.toString());
  assert.deepEqual(verifyAccountStateProof(proof.account, proof.inclusionProof, proof.accountStateRoot),
    proof.account);
  const tamperedAccount = structuredClone(proof.account);
  tamperedAccount.resources.pendingProgressReward.amount =
    (INITIAL_EPOCH_REWARD + 1n).toString();
  assert.throws(() => verifyAccountStateProof(
    tamperedAccount, proof.inclusionProof, proof.accountStateRoot,
  ), /root does not match/);

  const exported = chain.consensusSnapshot();
  const checkpoint = chain.blocks().at(-1);
  const tamperedSnapshot = structuredClone(exported);
  tamperedSnapshot.state.progressEscrows[0][1].acceptedReceiptHash = "0".repeat(64);
  const tamperedRoot = computeChainStateRoot(tamperedSnapshot.state);
  assert.throws(() => NirChain.fromVerifiedSnapshot(genesisConfig, {
    capabilityMemory: tamperedSnapshot.capabilityMemory,
    checkpoint: { ...checkpoint, stateRoot: tamperedRoot }, height: chain.height,
    networkId: chain.networkId, state: tamperedSnapshot.state, stateRoot: tamperedRoot,
    ...(chain.protocolVersion >= 25 ? { recoveryStateCommitment: chain.recoveryStateCommitment } : {}),
    tipHash: checkpoint.hash,
  }), /escrow bond or role binding is invalid/);
  const restored = NirChain.fromVerifiedSnapshot(genesisConfig, {
    capabilityMemory: exported.capabilityMemory, checkpoint, height: chain.height,
    networkId: chain.networkId, state: exported.state, stateRoot: chain.stateRoot,
    ...(chain.protocolVersion >= 25 ? { recoveryStateCommitment: chain.recoveryStateCommitment } : {}),
    tipHash: chain.tipHash,
  });
  assert.equal(restored.stateRoot, chain.stateRoot);
  assert.equal(restored.capabilityMemoryRoot, memoryRootBefore);

  const signerWallets = claim.attestations.map(({ evaluator }) =>
    evaluators.find((wallet) => wallet.address === evaluator));
  const conflictingClaim = createProgressClaim({
    networkId: chain.networkId,
    epoch: claim.epoch,
    recipient: claim.recipient,
    evaluation: { ...claim.evaluation,
      executionBundleHash: fingerprint("conflicting-execution-bundle") },
    evaluatorWallets: signerWallets,
  });
  const evidence = createProgressEvaluatorEquivocationEvidence({
    candidateId: claim.evaluation.candidateId, conflictingClaim,
  });
  advanceEmptyBlocks(restored, validators, PROGRESS_REWARD_ESCROW_DELAY_BLOCKS - 1);
  const duplicateBlock = restored.buildBlock({
    progressFraudProofs: [evidence, evidence], timestamp: currentTimestamp(restored),
  });
  const boundaryRoot = restored.stateRoot;
  assert.throws(() => restored.appendBlock(finalizeBlock(duplicateBlock,
    quorumFor(duplicateBlock, validators))), /duplicate progress fraud proof/);
  assert.equal(restored.stateRoot, boundaryRoot);
  const fraudBlock = restored.buildBlock({
    progressFraudProofs: [evidence], timestamp: currentTimestamp(restored),
  });
  restored.appendBlock(finalizeBlock(fraudBlock, quorumFor(fraudBlock, validators)));
  assert.equal(restored.capabilityMemoryRoot, memoryRootBefore);
  assert.equal(restored.balance(miner.address), 0n);
  assert.equal(restored.burned,
    INITIAL_EPOCH_REWARD * 2n + BigInt(signerWallets.length) * MIN_EVALUATOR_BOND);
  for (const signer of signerWallets) {
    assert.equal(restored.evaluatorBond(signer.address), 0n);
    assert.equal(restored.evaluatorFaultCount(signer.address), 1);
    assert.equal(restored.evaluatorDisabled(signer.address), true);
  }
  const slashedFork = restored.fork();
  for (const signer of signerWallets) {
    assert.equal(slashedFork.evaluatorBond(signer.address), 0n);
    assert.equal(slashedFork.evaluatorFaultCount(signer.address), 1);
    assert.equal(slashedFork.evaluatorDisabled(signer.address), true);
  }
  assert.equal(restored.accountState(miner.address).resources.pendingProgressReward, null);
  assertProgressBondConservation(restored);
  const settled = restored.consensusSnapshot();
  const recovered = NirChain.fromVerifiedSnapshot(genesisConfig, {
    capabilityMemory: settled.capabilityMemory, checkpoint: restored.blocks().at(-1),
    height: restored.height, networkId: restored.networkId, state: settled.state,
    ...(restored.protocolVersion >= 25 ? { recoveryStateCommitment: restored.recoveryStateCommitment } : {}),
    stateRoot: restored.stateRoot, tipHash: restored.tipHash,
  });
  const rootAfter = recovered.stateRoot;
  const replay = recovered.buildBlock({
    progressFraudProofs: [evidence], timestamp: currentTimestamp(recovered),
  });
  assert.throws(() => recovered.appendBlock(finalizeBlock(replay, quorumFor(replay, validators))),
    /invalid or replayed|late or has no escrow/);
  assert.equal(recovered.stateRoot, rootAfter);

  const replacements = Array.from({ length: signerWallets.length }, generateWallet);
  const overflowReplacement = generateWallet();
  const fundedReplacements = [...replacements, overflowReplacement];
  const fundingNonce = recovered.nextNonce(treasury.address);
  const funding = fundedReplacements.map((replacement, index) => createTransfer({
    wallet: treasury, networkId: recovered.networkId, recipient: replacement.address,
    amount: (MIN_EVALUATOR_BOND + MIN_VALIDATOR_BOND + 2n * MIN_TRANSFER_FEE).toString(),
    nonce: fundingNonce + index,
  }));
  const fundingBlock = recovered.buildBlock({ transactions: funding, timestamp: TREASURY_VESTING_MS });
  recovered.appendBlock(finalizeBlock(fundingBlock, quorumFor(fundingBlock, validators)));
  const registrationHeight = recovered.height + 1;
  const credentialsFor = (replacement, operatorId, validFromEpoch = registrationHeight) =>
    validators.slice(0, 3).map((validator) => createOperatorCredential({
      authorityWallet: validator, networkId: recovered.networkId,
      operator: { ...publicWallet(replacement), operatorId }, role: "evaluator",
      validFromEpoch,
      validUntilEpoch: validFromEpoch + EVALUATOR_ACTIVATION_DELAY_BLOCKS,
    }));
  const registrations = replacements.map((replacement, index) => createEvaluatorBond({
    wallet: replacement, networkId: recovered.networkId,
    amount: MIN_EVALUATOR_BOND.toString(), nonce: 0,
    operatorId: `replacement-evaluator-${index}`,
    activationHeight: registrationHeight + EVALUATOR_ACTIVATION_DELAY_BLOCKS,
    credentials: credentialsFor(replacement, `replacement-evaluator-${index}`),
  }));
  const uncredentialed = createEvaluatorBond({
    wallet: replacements[0], networkId: recovered.networkId,
    amount: MIN_EVALUATOR_BOND.toString(), nonce: 0,
    operatorId: "self-asserted-controller",
    activationHeight: registrationHeight + EVALUATOR_ACTIVATION_DELAY_BLOCKS,
    credentials: [],
  });
  const beforeUncredentialed = recovered.stateRoot;
  const uncredentialedBlock = recovered.buildBlock({
    transactions: [uncredentialed], timestamp: TREASURY_VESTING_MS,
  });
  assert.throws(() => recovered.appendBlock(finalizeBlock(
    uncredentialedBlock, quorumFor(uncredentialedBlock, validators),
  )), /credential quorum/);
  assert.equal(recovered.stateRoot, beforeUncredentialed);
  assert.equal(recovered.nextNonce(replacements[0].address), 0);

  const duplicatedCredentials = structuredClone(registrations[0].credentials);
  duplicatedCredentials[1] = structuredClone(duplicatedCredentials[0]);
  const duplicateCredentialRegistration = createEvaluatorBond({
    wallet: replacements[0], networkId: recovered.networkId,
    amount: MIN_EVALUATOR_BOND.toString(), nonce: 0,
    operatorId: "replacement-evaluator-0",
    activationHeight: registrationHeight + EVALUATOR_ACTIVATION_DELAY_BLOCKS,
    credentials: duplicatedCredentials,
  });
  const duplicateCredentialBlock = recovered.buildBlock({
    transactions: [duplicateCredentialRegistration], timestamp: TREASURY_VESTING_MS,
  });
  assert.throws(() => recovered.appendBlock(finalizeBlock(
    duplicateCredentialBlock, quorumFor(duplicateCredentialBlock, validators),
  )), /credential is duplicated/);
  assert.equal(recovered.stateRoot, beforeUncredentialed);

  const replayedIdentityCredentialRegistration = createEvaluatorBond({
    wallet: replacements[1], networkId: recovered.networkId,
    amount: MIN_EVALUATOR_BOND.toString(), nonce: 0,
    operatorId: "replacement-evaluator-1",
    activationHeight: registrationHeight + EVALUATOR_ACTIVATION_DELAY_BLOCKS,
    credentials: registrations[0].credentials,
  });
  const replayedIdentityCredentialBlock = recovered.buildBlock({
    transactions: [replayedIdentityCredentialRegistration], timestamp: TREASURY_VESTING_MS,
  });
  assert.throws(() => recovered.appendBlock(finalizeBlock(
    replayedIdentityCredentialBlock, quorumFor(replayedIdentityCredentialBlock, validators),
  )), /credential is duplicated, stale, or invalid/);
  assert.equal(recovered.stateRoot, beforeUncredentialed);
  assert.equal(recovered.nextNonce(replacements[1].address), 0);

  const expiredCredentials = validators.slice(0, 3).map((validator) => createOperatorCredential({
    authorityWallet: validator, networkId: recovered.networkId,
    operator: { ...publicWallet(replacements[1]), operatorId: "replacement-evaluator-1" },
    role: "evaluator", validFromEpoch: registrationHeight,
    validUntilEpoch: registrationHeight + EVALUATOR_ACTIVATION_DELAY_BLOCKS - 1,
  }));
  const expiredCredentialRegistration = createEvaluatorBond({
    wallet: replacements[1], networkId: recovered.networkId,
    amount: MIN_EVALUATOR_BOND.toString(), nonce: 0,
    operatorId: "replacement-evaluator-1",
    activationHeight: registrationHeight + EVALUATOR_ACTIVATION_DELAY_BLOCKS,
    credentials: expiredCredentials,
  });
  const expiredCredentialBlock = recovered.buildBlock({
    transactions: [expiredCredentialRegistration], timestamp: TREASURY_VESTING_MS,
  });
  assert.throws(() => recovered.appendBlock(finalizeBlock(
    expiredCredentialBlock, quorumFor(expiredCredentialBlock, validators),
  )), /credential is duplicated, stale, or invalid/);
  assert.equal(recovered.stateRoot, beforeUncredentialed);

  const raceEvaluator = registrations[1];
  const raceValidator = createValidatorBond({
    wallet: replacements[1], networkId: recovered.networkId,
    amount: MIN_VALIDATOR_BOND.toString(), nonce: 1, operatorId: "same-block-validator",
  });
  const raceBlock = recovered.buildBlock({
    transactions: [raceEvaluator, raceValidator], timestamp: TREASURY_VESTING_MS,
  });
  assert.throws(() => recovered.appendBlock(finalizeBlock(
    raceBlock, quorumFor(raceBlock, validators),
  )), /new validator operator id is invalid or duplicated/);
  assert.equal(recovered.stateRoot, beforeUncredentialed);
  const reverseValidator = createValidatorBond({
    wallet: replacements[2], networkId: recovered.networkId,
    amount: MIN_VALIDATOR_BOND.toString(), nonce: 0, operatorId: "reverse-race-validator",
  });
  const reverseEvaluator = createEvaluatorBond({
    wallet: replacements[2], networkId: recovered.networkId,
    amount: MIN_EVALUATOR_BOND.toString(), nonce: 1,
    operatorId: "reverse-race-evaluator",
    activationHeight: registrationHeight + EVALUATOR_ACTIVATION_DELAY_BLOCKS,
    credentials: credentialsFor(replacements[2], "reverse-race-evaluator"),
  });
  const reverseRaceBlock = recovered.buildBlock({
    transactions: [reverseValidator, reverseEvaluator], timestamp: TREASURY_VESTING_MS,
  });
  assert.throws(() => recovered.appendBlock(finalizeBlock(
    reverseRaceBlock, quorumFor(reverseRaceBlock, validators),
  )), /new evaluator registration is invalid/);
  assert.equal(recovered.stateRoot, beforeUncredentialed);
  const registrationBlock = recovered.buildBlock({
    transactions: registrations, timestamp: TREASURY_VESTING_MS,
  });
  recovered.appendBlock(finalizeBlock(registrationBlock, quorumFor(registrationBlock, validators)));
  assert.equal(recovered.consensusSnapshot().state.pendingEvaluatorRegistrations.length,
    replacements.length);
  assert.equal(recovered.consensusSnapshot().state.evaluatorBonds
    .filter(([address]) => replacements.some((wallet) => wallet.address === address))
    .reduce((sum, [, amount]) => sum + BigInt(amount), 0n),
  BigInt(replacements.length) * MIN_EVALUATOR_BOND);
  const overflowHeight = recovered.height + 1;
  const overflowRegistration = createEvaluatorBond({
    wallet: overflowReplacement, networkId: recovered.networkId,
    amount: MIN_EVALUATOR_BOND.toString(), nonce: 0,
    operatorId: "overflow-evaluator",
    activationHeight: overflowHeight + EVALUATOR_ACTIVATION_DELAY_BLOCKS,
    credentials: credentialsFor(overflowReplacement, "overflow-evaluator", overflowHeight),
  });
  const beforeOverflow = recovered.stateRoot;
  const overflowBlock = recovered.buildBlock({
    transactions: [overflowRegistration], timestamp: TREASURY_VESTING_MS,
  });
  assert.throws(() => recovered.appendBlock(finalizeBlock(
    overflowBlock, quorumFor(overflowBlock, validators),
  )), /no vacant slot/);
  assert.equal(recovered.stateRoot, beforeOverflow);
  assert.equal(recovered.nextNonce(overflowReplacement.address), 0);
  const pendingSnapshot = recovered.consensusSnapshot();
  const restartedPending = NirChain.fromVerifiedSnapshot(genesisConfig, {
    capabilityMemory: pendingSnapshot.capabilityMemory, checkpoint: recovered.blocks().at(-1),
    height: recovered.height, networkId: recovered.networkId, state: pendingSnapshot.state,
    ...(recovered.protocolVersion >= 25 ? { recoveryStateCommitment: recovered.recoveryStateCommitment } : {}),
    stateRoot: recovered.stateRoot, tipHash: recovered.tipHash,
  });
  advanceEmptyBlocks(restartedPending, validators, EVALUATOR_ACTIVATION_DELAY_BLOCKS,
    TREASURY_VESTING_MS);
  assert.equal(restartedPending.consensusSnapshot().state.pendingEvaluatorRegistrations.length, 0);
  for (const replacement of replacements) {
    assert.equal(restartedPending.evaluatorBond(replacement.address), MIN_EVALUATOR_BOND);
    assert.equal(restartedPending.evaluatorDisabled(replacement.address), false);
  }
  const disabledRebond = createEvaluatorBond({
    wallet: signerWallets[0], networkId: restartedPending.networkId,
    amount: "1", nonce: restartedPending.nextNonce(signerWallets[0].address),
  });
  const disabledBlock = restartedPending.buildBlock({
    transactions: [disabledRebond], timestamp: TREASURY_VESTING_MS,
  });
  assert.throws(() => restartedPending.appendBlock(finalizeBlock(
    disabledBlock, quorumFor(disabledBlock, validators),
  )), /disabled evaluator identity cannot bond again/);
  TEST_BEACON_WALLETS.set(restartedPending, beaconAuthorities);
  TEST_TREASURY_WALLETS.set(restartedPending, treasury);
  const nextMiner = generateWallet();
  const recoveredClaim = progressClaim(
    restartedPending, [...evaluators, ...replacements], validators, nextMiner,
    "replacement-quorum", nextMiner.address, "replacement-quorum-content",
  );
  const recoveredReward = restartedPending.buildBlock({
    rewardClaims: [recoveredClaim],
    timestamp: currentTimestamp(restartedPending, MIN_REWARD_INTERVAL_MS),
  });
  restartedPending.appendBlock(finalizeBlock(
    recoveredReward, quorumFor(recoveredReward, validators),
  ));
  assert.equal(restartedPending.accountState(nextMiner.address)
    .resources.pendingProgressReward.amount, INITIAL_EPOCH_REWARD.toString());
  assertProgressBondConservation(restartedPending);
});

test("false and late progress evidence cannot confiscate escrow", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const claim = progressClaim(chain, evaluators, validators, miner, "false-evidence");
  const rewardBlock = chain.buildBlock({ rewardClaims: [claim], timestamp: currentTimestamp(chain) });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  const falseEvidence = createProgressEvaluatorEquivocationEvidence({
    candidateId: claim.evaluation.candidateId, conflictingClaim: claim,
  });
  const before = chain.stateRoot;
  const evaluatorStateBefore = evaluators.map(({ address }) => ({
    bond: chain.evaluatorBond(address), disabled: chain.evaluatorDisabled(address),
    faults: chain.evaluatorFaultCount(address),
  }));
  const falseBlock = chain.buildBlock({ progressFraudProofs: [falseEvidence],
    timestamp: currentTimestamp(chain) });
  assert.throws(() => chain.appendBlock(finalizeBlock(falseBlock, quorumFor(falseBlock, validators))),
    /does not prove a conflicting receipt/);
  assert.equal(chain.stateRoot, before);
  assert.deepEqual(evaluators.map(({ address }) => ({
    bond: chain.evaluatorBond(address), disabled: chain.evaluatorDisabled(address),
    faults: chain.evaluatorFaultCount(address),
  })), evaluatorStateBefore);
  const signerWallets = claim.attestations.map(({ evaluator }) =>
    evaluators.find((wallet) => wallet.address === evaluator));
  const partialClaim = createProgressClaim({
    networkId: chain.networkId, epoch: claim.epoch, recipient: claim.recipient,
    evaluation: { ...claim.evaluation, executionBundleHash: fingerprint("partial-conflict") },
    evaluatorWallets: signerWallets,
  });
  partialClaim.attestations.pop();
  const partialEvidence = createProgressEvaluatorEquivocationEvidence({
    candidateId: claim.evaluation.candidateId, conflictingClaim: partialClaim,
  });
  const partialBlock = chain.buildBlock({ progressFraudProofs: [partialEvidence],
    timestamp: currentTimestamp(chain) });
  assert.throws(() => chain.appendBlock(finalizeBlock(partialBlock,
    quorumFor(partialBlock, validators))), /no assigned quorum/);
  assert.equal(chain.stateRoot, before);
  assert.deepEqual(evaluators.map(({ address }) => ({
    bond: chain.evaluatorBond(address), disabled: chain.evaluatorDisabled(address),
    faults: chain.evaluatorFaultCount(address),
  })), evaluatorStateBefore);
  matureProgressRewards(chain, validators);
  assert.equal(chain.balance(miner.address), INITIAL_EPOCH_REWARD);
  const lateBlock = chain.buildBlock({ progressFraudProofs: [falseEvidence],
    timestamp: currentTimestamp(chain) });
  assert.throws(() => chain.appendBlock(finalizeBlock(lateBlock, quorumFor(lateBlock, validators))),
    /late or has no escrow/);
  assert.equal(chain.balance(miner.address), INITIAL_EPOCH_REWARD);
});

test("pending capability is not a baseline and independent reservations survive another fraud", () => {
  const { chain, evaluators, validators } = fixture();
  const firstMiner = generateWallet();
  const secondMiner = generateWallet();
  const memoryRootBefore = chain.capabilityMemoryRoot;
  const firstClaim = progressClaim(chain, evaluators, validators, firstMiner, "pending-parent");
  const firstReward = chain.buildBlock({ rewardClaims: [firstClaim],
    timestamp: currentTimestamp(chain) });
  chain.appendBlock(finalizeBlock(firstReward, quorumFor(firstReward, validators)));

  const illegalChild = createProgressCommitment({
    wallet: secondMiner, networkId: chain.networkId, recipient: secondMiner.address,
    artifactHash: `sha256:${fingerprint("pending-child-artifact")}`,
    baselineHash: firstClaim.evaluation.artifactHash,
    baselineContentHash: firstClaim.evaluation.contentHash,
    contentHash: `sha256:${fingerprint("pending-child-content")}`,
    suiteCommitment: fingerprint("pending-child-suite"), nonce: 0,
  });
  lockProgressBond(chain, validators, secondMiner.address, illegalChild.candidateId,
    currentTimestamp(chain), INITIAL_EPOCH_REWARD);
  const illegalBlock = chain.buildBlock({ transactions: [illegalChild],
    timestamp: currentTimestamp(chain) });
  assert.throws(() => chain.appendBlock(finalizeBlock(illegalBlock,
    quorumFor(illegalBlock, validators))), /pending progress escrow cannot be used as a baseline/);
  assert.equal(chain.capabilityMemoryRoot, memoryRootBefore);

  const independentMiner = generateWallet();
  const independentClaim = progressClaim(
    chain, evaluators, validators, independentMiner, "independent-vision",
  );
  const independentReward = chain.buildBlock({ rewardClaims: [independentClaim],
    timestamp: currentTimestamp(chain, MIN_REWARD_INTERVAL_MS) });
  chain.appendBlock(finalizeBlock(independentReward,
    quorumFor(independentReward, validators)));

  const signers = firstClaim.attestations.map(({ evaluator }) =>
    evaluators.find((wallet) => wallet.address === evaluator));
  const conflicting = createProgressClaim({
    networkId: chain.networkId, epoch: firstClaim.epoch, recipient: firstClaim.recipient,
    evaluation: { ...firstClaim.evaluation,
      executionBundleHash: fingerprint("pending-parent-conflict") },
    evaluatorWallets: signers,
  });
  const evidence = createProgressEvaluatorEquivocationEvidence({
    candidateId: firstClaim.evaluation.candidateId, conflictingClaim: conflicting,
  });
  const firstEscrow = chain.consensusSnapshot().state.progressEscrows
    .find(([candidateId]) => candidateId === firstClaim.evaluation.candidateId)[1];
  advanceEmptyBlocks(chain, validators, firstEscrow.unlockHeight - chain.height - 1);
  const fraud = chain.buildBlock({ progressFraudProofs: [evidence],
    timestamp: currentTimestamp(chain) });
  chain.appendBlock(finalizeBlock(fraud, quorumFor(fraud, validators)));
  assert.equal(chain.capabilityMemoryRoot, memoryRootBefore);
  assert.equal(chain.accountState(independentMiner.address).resources.pendingProgressReward.amount,
    independentReward.progressRewards[0].amount);
  matureProgressRewards(chain, validators);
  assert.equal(chain.balance(independentMiner.address),
    BigInt(independentReward.progressRewards[0].amount));
  assert.notEqual(chain.capabilityMemoryRoot, memoryRootBefore);
});

test("snapshot rejects unbounded progress escrow and fraud replay state", () => {
  const { chain, genesisConfig, validators } = fixture();
  const block = chain.buildBlock({ timestamp: 1 });
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  const exported = chain.consensusSnapshot();
  exported.state.progressFraudEvidence = Array.from(
    { length: MAX_PROGRESS_FRAUD_EVIDENCE + 1 },
    (_, index) => [fingerprint(`oversized-fraud-${index}`), 1],
  );
  const forgedRoot = computeChainStateRoot(exported.state);
  const checkpoint = { ...chain.blocks().at(-1), stateRoot: forgedRoot };
  assert.throws(() => NirChain.fromVerifiedSnapshot(genesisConfig, {
    capabilityMemory: exported.capabilityMemory, checkpoint, height: chain.height,
    networkId: chain.networkId, state: exported.state, stateRoot: forgedRoot,
    ...(chain.protocolVersion >= 25 ? { recoveryStateCommitment: chain.recoveryStateCommitment } : {}),
    tipHash: checkpoint.hash,
  }), /replay snapshot state is invalid/);

  const oversizedEscrows = chain.consensusSnapshot();
  oversizedEscrows.state.progressEscrows = Array.from(
    { length: MAX_PROGRESS_REWARD_ESCROWS + 1 },
    (_, index) => [fingerprint(`oversized-escrow-${index}`), {}],
  );
  const escrowRoot = computeChainStateRoot(oversizedEscrows.state);
  const escrowCheckpoint = { ...chain.blocks().at(-1), stateRoot: escrowRoot };
  assert.throws(() => NirChain.fromVerifiedSnapshot(genesisConfig, {
    capabilityMemory: oversizedEscrows.capabilityMemory, checkpoint: escrowCheckpoint,
    height: chain.height, networkId: chain.networkId, state: oversizedEscrows.state,
    ...(chain.protocolVersion >= 25 ? { recoveryStateCommitment: chain.recoveryStateCommitment } : {}),
    stateRoot: escrowRoot, tipHash: escrowCheckpoint.hash,
  }), /escrow snapshot capacity is exceeded/);
});

test("protocol operator keys cannot submit progress or receive its issuance", () => {
  for (const role of ["evaluator", "validator", "beacon"]) {
    const context = fixture();
    const operator = role === "evaluator" ? context.evaluators[0]
      : role === "validator" ? context.validators[0] : context.beaconAuthorities[0];
    const ordinary = generateWallet();
    for (const mode of ["submitter", "recipient"]) {
      const sender = mode === "submitter" ? operator : ordinary;
      const recipient = mode === "recipient" ? operator.address : sender.address;
      const admission = createProgressCommitment({
        wallet: sender, networkId: context.chain.networkId, recipient,
        artifactHash: `sha256:${fingerprint(`${role}-${mode}-artifact`)}`,
        baselineHash: `sha256:${fingerprint("baseline")}`,
        baselineContentHash: `sha256:${fingerprint("baseline-content")}`,
        contentHash: `sha256:${fingerprint(`${role}-${mode}-content`)}`,
        suiteCommitment: fingerprint(`${role}-${mode}-suite`), nonce: 0,
      });
      lockProgressBond(
        context.chain, context.validators, sender.address, admission.candidateId,
        TREASURY_VESTING_MS, INITIAL_EPOCH_REWARD,
      );
      const rootBefore = context.chain.stateRoot;
      const proposal = context.chain.buildBlock({ transactions: [admission],
        timestamp: currentTimestamp(context.chain) });
      assert.throws(() => context.chain.appendBlock(finalizeBlock(
        proposal, quorumFor(proposal, context.validators))), /outside protocol operator roles/);
      assert.equal(context.chain.stateRoot, rootBefore);
      assert.equal(context.chain.nextNonce(sender.address), 0);
    }
  }
});

test("same-block validator registration cannot race progress role separation", () => {
  for (const progressFirst of [true, false]) {
    const { chain, treasury, validators } = fixture();
    const operator = generateWallet();
    const funding = createTransfer({ wallet: treasury, networkId: chain.networkId,
      recipient: operator.address, amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE).toString(),
      nonce: chain.nextNonce(treasury.address) });
    const fundingBlock = chain.buildBlock({ transactions: [funding], timestamp: TREASURY_VESTING_MS });
    chain.appendBlock(finalizeBlock(fundingBlock, quorumFor(fundingBlock, validators)));
    const admission = createProgressCommitment({ wallet: operator, networkId: chain.networkId,
      recipient: operator.address, artifactHash: `sha256:${fingerprint(`race-artifact-${progressFirst}`)}`,
      baselineHash: `sha256:${fingerprint("baseline")}`,
      baselineContentHash: `sha256:${fingerprint("baseline-content")}`,
      contentHash: `sha256:${fingerprint(`race-content-${progressFirst}`)}`,
      suiteCommitment: fingerprint(`race-suite-${progressFirst}`),
      nonce: progressFirst ? 0 : 1 });
    lockProgressBond(chain, validators, operator.address, admission.candidateId,
      currentTimestamp(chain), INITIAL_EPOCH_REWARD);
    const validatorBond = createValidatorBond({ wallet: operator, networkId: chain.networkId,
      amount: MIN_VALIDATOR_BOND.toString(), nonce: progressFirst ? 1 : 0,
      operatorId: `race-validator-${progressFirst}` });
    const rootBefore = chain.stateRoot;
    const proposal = chain.buildBlock({ transactions: progressFirst
      ? [admission, validatorBond] : [validatorBond, admission], timestamp: currentTimestamp(chain) });
    assert.throws(() => chain.appendBlock(finalizeBlock(proposal, quorumFor(proposal, validators))),
      /validator key cannot have a pending progress commitment|outside protocol operator roles/);
    assert.equal(chain.stateRoot, rootBefore);
    assert.equal(chain.nextNonce(operator.address), 0);
  }
});

test("weak-baseline gain cannot exceed the measured world-frontier delta", () => {
  const { chain, evaluators, validators } = fixture();
  const firstMiner = generateWallet();
  const first = progressClaim(chain, evaluators, validators, firstMiner, "frontier-anchor");
  const firstBlock = chain.buildBlock({ rewardClaims: [first], timestamp: currentTimestamp(chain) });
  chain.appendBlock(finalizeBlock(firstBlock, quorumFor(firstBlock, validators)));

  const attacker = generateWallet();
  const valid = progressClaim(chain, evaluators, validators, attacker, "second-frontier");
  const assigned = valid.attestations.map(({ evaluator }) =>
    evaluators.find((wallet) => wallet.address === evaluator));
  const inflated = createProgressClaim({
    networkId: chain.networkId, epoch: valid.epoch, recipient: attacker.address,
    evaluation: { ...valid.evaluation,
      gainPpm: valid.evaluation.noveltyBps * 100 + 1 },
    evaluatorWallets: assigned,
  });
  assert.throws(() => chain.buildBlock({ rewardClaims: [inflated],
    timestamp: currentTimestamp(chain, MIN_REWARD_INTERVAL_MS) }), /world-frontier improvement bound/);
});

test("simultaneous wrappers cannot split one frontier delta into two rewards", () => {
  const { chain, evaluators, validators } = fixture();
  const firstOriginal = progressClaim(chain, evaluators, validators, generateWallet(), "split-first");
  const secondOriginal = progressClaim(chain, evaluators, validators, generateWallet(), "split-second");
  const targetEpoch = chain.height + 1;
  const retarget = (claim) => createProgressClaim({ networkId: chain.networkId,
    epoch: targetEpoch, recipient: claim.recipient,
    evaluation: { ...claim.evaluation, challengeEpoch: targetEpoch },
    evaluatorWallets: claim.attestations.map(({ evaluator }) =>
      evaluators.find((wallet) => wallet.address === evaluator)) });
  const first = retarget(firstOriginal); const second = retarget(secondOriginal);
  assert.deepEqual(first.evaluation.capabilitiesBps, second.evaluation.capabilitiesBps);
  const rootBefore = chain.stateRoot;
  assert.throws(() => chain.buildBlock({ rewardClaims: [second, first],
    timestamp: currentTimestamp(chain) }), /pending escrow reservation/);
  assert.equal(chain.stateRoot, rootBefore);
  const accepted = chain.buildBlock({ rewardClaims: [first], timestamp: currentTimestamp(chain) });
  chain.appendBlock(finalizeBlock(accepted, quorumFor(accepted, validators)));
  assert.equal(accepted.progressRewards.length, 1);
});

test("free multi-key progress committee grinding is rejected before state transition", () => {
  const { chain, validators } = fixture();
  const attackers = Array.from({ length: 8 }, generateWallet);
  const commitments = attackers.map((wallet, index) => createProgressCommitment({
    wallet, networkId: chain.networkId, recipient: wallet.address,
    artifactHash: `sha256:${fingerprint(`grind-artifact-${index}`)}`,
    baselineHash: `sha256:${fingerprint("baseline")}`,
    baselineContentHash: `sha256:${fingerprint("baseline-content")}`,
    contentHash: `sha256:${fingerprint(`grind-wrapper-${index}`)}`,
    suiteCommitment: fingerprint("grind-suite"), nonce: 0,
  }));
  const rootBefore = chain.stateRoot;
  const proposal = chain.buildBlock({ transactions: commitments, timestamp: 0 });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(proposal, quorumFor(proposal, validators))),
    /prior unbound candidate bond/,
  );
  assert.equal(chain.height, 0);
  assert.equal(chain.stateRoot, rootBefore);
});

test("progress bond cannot bypass treasury vesting", () => {
  const { chain, treasury, validators } = fixture();
  const owner = generateWallet();
  const bond = createCandidateBond({
    wallet: treasury, networkId: chain.networkId,
    candidateId: fingerprint("premature-treasury-progress-bond"),
    candidateOwner: owner.address, purpose: "progress",
    amount: MIN_PROGRESS_CANDIDATE_BOND.toString(), fee: "0", nonce: 0,
  });
  const rootBefore = chain.stateRoot;
  const balanceBefore = chain.balance(treasury.address);
  const nonceBefore = chain.nextNonce(treasury.address);
  const proposal = chain.buildBlock({ transactions: [bond], timestamp: 0 });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(proposal, quorumFor(proposal, validators))),
    /treasury funds are still vesting/,
  );
  assert.equal(chain.stateRoot, rootBefore);
  assert.equal(chain.balance(treasury.address), balanceBefore);
  assert.equal(chain.nextNonce(treasury.address), nonceBefore);
});

test("deterministic state model covers parallel progress bond lifecycle", () => {
  const { chain, evaluators, genesisConfig, treasury, validators } = fixture();
  const fundedSponsor = generateWallet();
  const fundingClaim = progressClaim(
    chain, evaluators, validators, fundedSponsor, "model-sponsor-funding",
  );
  const fundingReward = chain.buildBlock({
    rewardClaims: [fundingClaim], timestamp: currentTimestamp(chain),
  });
  chain.appendBlock(finalizeBlock(fundingReward, quorumFor(fundingReward, validators)));
  matureProgressRewards(chain, validators);
  assertProgressBondConservation(chain);
  const sponsorBalancesBefore = new Map([
    [treasury.address, chain.balance(treasury.address)],
    [fundedSponsor.address, chain.balance(fundedSponsor.address)],
  ]);

  let randomState = 0x6d2b79f5;
  const nextRandom = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState;
  };
  const plans = Array.from({ length: 12 }, (_, index) => {
    const owner = generateWallet();
    const admission = createProgressCommitment({
      wallet: owner, networkId: chain.networkId, recipient: owner.address,
      artifactHash: `sha256:${fingerprint(`model-artifact-${index}`)}`,
      baselineHash: `sha256:${fingerprint("baseline")}`,
      baselineContentHash: `sha256:${fingerprint("baseline-content")}`,
      contentHash: `sha256:${fingerprint(`model-content-${index}`)}`,
      suiteCommitment: fingerprint(`model-suite-${index}`), nonce: 0,
    });
    return { admission, owner, sponsor: nextRandom() & 1 ? treasury : fundedSponsor };
  });
  const bondTransactions = [];
  assert.equal(new Set(plans.map(({ admission }) => admission.candidateId)).size, plans.length);
  for (const plan of plans) {
    const bond = createCandidateBond({
      wallet: plan.sponsor, networkId: chain.networkId,
      candidateId: plan.admission.candidateId, candidateOwner: plan.owner.address,
      purpose: "progress", amount: MIN_PROGRESS_CANDIDATE_BOND.toString(), fee: "0",
      nonce: chain.nextNonce(plan.sponsor.address),
    });
    bondTransactions.push(bond);
    const block = chain.buildBlock({ transactions: [bond], timestamp: currentTimestamp(chain) });
    chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
    assertProgressBondConservation(chain);
    assert.throws(() => chain.assignedSafetyEvaluators(plan.admission.candidateId), /not assigned/);
  }

  const order = [...plans.keys()];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const other = nextRandom() % (index + 1);
    [order[index], order[other]] = [order[other], order[index]];
  }
  const boundIndexes = new Set(order.slice(0, 6));
  for (const index of order.slice(0, 6)) {
    const block = chain.buildBlock({
      transactions: [plans[index].admission], timestamp: currentTimestamp(chain),
    });
    chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
    assertProgressBondConservation(chain);
  }

  const rootBeforeReplay = chain.stateRoot;
  const sponsorNonceBeforeReplay = chain.nextNonce(plans[0].sponsor.address);
  const replay = chain.buildBlock({
    transactions: [bondTransactions[0]], timestamp: currentTimestamp(chain),
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(replay, quorumFor(replay, validators))),
    /duplicated/,
  );
  assert.equal(chain.stateRoot, rootBeforeReplay);
  assert.equal(chain.nextNonce(plans[0].sponsor.address), sponsorNonceBeforeReplay);

  const targetReuseNonce = chain.nextNonce(fundedSponsor.address);
  const safetyTargetReuse = createCandidateBond({
    wallet: fundedSponsor, networkId: chain.networkId,
    candidateId: plans[1].admission.candidateId,
    amount: MIN_PROGRESS_CANDIDATE_BOND.toString(), nonce: targetReuseNonce,
  });
  const rootBeforeTargetReuse = chain.stateRoot;
  const targetReuseBlock = chain.buildBlock({
    transactions: [safetyTargetReuse], timestamp: currentTimestamp(chain),
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(targetReuseBlock, quorumFor(targetReuseBlock, validators))),
    /duplicated/,
  );
  assert.equal(chain.stateRoot, rootBeforeTargetReuse);
  assert.equal(chain.nextNonce(fundedSponsor.address), targetReuseNonce);

  const noBondOwner = generateWallet();
  const noBondAdmission = createProgressCommitment({
    wallet: noBondOwner, networkId: chain.networkId, recipient: noBondOwner.address,
    artifactHash: `sha256:${fingerprint("model-no-bond-artifact")}`,
    baselineHash: `sha256:${fingerprint("baseline")}`,
    baselineContentHash: `sha256:${fingerprint("baseline-content")}`,
    contentHash: `sha256:${fingerprint("model-no-bond-content")}`,
    suiteCommitment: fingerprint("model-no-bond-suite"), nonce: 0,
  });
  const noBondRoot = chain.stateRoot;
  const invalid = chain.buildBlock({
    transactions: [noBondAdmission], timestamp: currentTimestamp(chain),
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(invalid, quorumFor(invalid, validators))),
    /prior unbound candidate bond/,
  );
  assert.equal(chain.stateRoot, noBondRoot);
  assert.equal(chain.nextNonce(noBondOwner.address), 0);

  const exported = chain.consensusSnapshot();
  const checkpoint = chain.blocks().at(-1);
  const restored = NirChain.fromVerifiedSnapshot(genesisConfig, {
    capabilityMemory: exported.capabilityMemory, checkpoint, height: chain.height,
    networkId: chain.networkId, state: exported.state, stateRoot: chain.stateRoot,
    ...(chain.protocolVersion >= 25 ? { recoveryStateCommitment: chain.recoveryStateCommitment } : {}),
    tipHash: chain.tipHash,
  });
  const fork = chain.fork();
  const replayed = new NirChain(genesisConfig);
  for (const block of chain.blocks().slice(1)) replayed.appendBlock(block);
  assert.equal(fork.stateRoot, chain.stateRoot);
  assert.equal(restored.stateRoot, chain.stateRoot);
  assert.equal(replayed.stateRoot, chain.stateRoot);

  for (let index = 0; index <= PROGRESS_BOND_BINDING_TIMEOUT_BLOCKS; index += 1) {
    const empty = fork.buildBlock({ timestamp: currentTimestamp(fork) });
    fork.appendBlock(finalizeBlock(empty, quorumFor(empty, validators)));
    assertProgressBondConservation(fork);
  }
  const remaining = new Map(fork.consensusSnapshot().state.candidateBonds);
  assert.equal(remaining.size, boundIndexes.size);
  for (const index of boundIndexes) {
    assert.equal(remaining.get(plans[index].admission.candidateId).admissionBound, true);
  }
  for (const sponsor of [treasury, fundedSponsor]) {
    const boundForSponsor = [...boundIndexes]
      .filter((index) => plans[index].sponsor.address === sponsor.address).length;
    assert.equal(
      fork.balance(sponsor.address),
      sponsorBalancesBefore.get(sponsor.address) -
        (BigInt(boundForSponsor) * MIN_PROGRESS_CANDIDATE_BOND),
    );
  }
  assert.equal(fork.burned, 0n);
});

test("unused pre-admission bond is reclaimed only after a committee-free delay", () => {
  const { chain, treasury, validators } = fixture();
  const owner = generateWallet();
  const candidateId = fingerprint("unused-progress-bond");
  const balanceBefore = chain.balance(treasury.address);
  lockProgressBond(chain, validators, owner.address, candidateId, TREASURY_VESTING_MS);
  assert.equal(chain.balance(treasury.address), balanceBefore - MIN_PROGRESS_CANDIDATE_BOND);
  assert.throws(() => chain.assignedSafetyEvaluators(candidateId), /not assigned/);
  for (let index = 0; index <= PROGRESS_BOND_BINDING_TIMEOUT_BLOCKS; index += 1) {
    const empty = chain.buildBlock({ timestamp: currentTimestamp(chain) });
    chain.appendBlock(finalizeBlock(empty, quorumFor(empty, validators)));
    if (index === 62 || index === 63) {
      assert.equal(chain.consensusSnapshot().state.candidateBonds.length, 1);
      assert.equal(chain.balance(treasury.address), balanceBefore - MIN_PROGRESS_CANDIDATE_BOND);
    }
    assertProgressBondConservation(chain);
  }
  assert.equal(chain.balance(treasury.address), balanceBefore);
  assert.equal(chain.burned, 0n);
  assert.deepEqual(chain.consensusSnapshot().state.candidateBonds, []);
});

test("unbound progress bond gets no committee and abandoned admission burns after restart", () => {
  const { chain, genesisConfig, treasury, validators } = fixture();
  const author = generateWallet();
  const admission = createProgressCommitment({
    wallet: author, networkId: chain.networkId, recipient: author.address,
    artifactHash: `sha256:${fingerprint("abandoned-artifact")}`,
    baselineHash: `sha256:${fingerprint("baseline")}`,
    baselineContentHash: `sha256:${fingerprint("baseline-content")}`,
    contentHash: `sha256:${fingerprint("abandoned-content")}`,
    suiteCommitment: fingerprint("abandoned-suite"), nonce: 0,
  });
  const sponsorBefore = chain.balance(treasury.address);
  lockProgressBond(
    chain, validators, author.address, admission.candidateId, TREASURY_VESTING_MS,
  );
  assert.throws(() => chain.assignedSafetyEvaluators(admission.candidateId), /not assigned/);
  assert.throws(() => chain.progressChallenge(admission.candidateId), /unknown or expired/);
  for (let index = 0; index < 4; index += 1) {
    const empty = chain.buildBlock({ timestamp: currentTimestamp(chain) });
    chain.appendBlock(finalizeBlock(empty, quorumFor(empty, validators)));
  }
  const unbound = chain.consensusSnapshot().state.candidateBonds[0][1];
  assert.equal(unbound.purpose, "progress");
  assert.equal(unbound.admissionBound, false);
  assert.equal(unbound.committee, null);

  const admissionBlock = chain.buildBlock({
    transactions: [admission], timestamp: currentTimestamp(chain),
  });
  chain.appendBlock(finalizeBlock(admissionBlock, quorumFor(admissionBlock, validators)));
  const exported = chain.consensusSnapshot();
  const checkpoint = chain.blocks().at(-1);
  const restored = NirChain.fromVerifiedSnapshot(genesisConfig, {
    capabilityMemory: exported.capabilityMemory, checkpoint, height: chain.height,
    networkId: chain.networkId, state: exported.state, stateRoot: chain.stateRoot,
    ...(chain.protocolVersion >= 25 ? { recoveryStateCommitment: chain.recoveryStateCommitment } : {}),
    tipHash: chain.tipHash,
  });
  const replayed = new NirChain(genesisConfig);
  for (const block of chain.blocks().slice(1)) replayed.appendBlock(block);
  assert.equal(replayed.stateRoot, restored.stateRoot);

  const burnedBefore = restored.burned;
  for (let index = 0; index <= MAX_PROGRESS_COMMITMENT_AGE; index += 1) {
    const empty = restored.buildBlock({ timestamp: currentTimestamp(restored) });
    const finalized = finalizeBlock(empty, quorumFor(empty, validators));
    restored.appendBlock(finalized);
    replayed.appendBlock(finalized);
    if (index === 1022 || index === 1023) {
      assert.equal(restored.consensusSnapshot().state.candidateBonds.length, 1);
      assert.equal(restored.burned, burnedBefore);
    }
    assertProgressBondConservation(restored);
    assertProgressBondConservation(replayed);
  }
  assert.equal(replayed.stateRoot, restored.stateRoot);
  assert.equal(replayed.burned, restored.burned);
  assert.equal(restored.burned, burnedBefore + MIN_PROGRESS_CANDIDATE_BOND);
  assert.equal(restored.circulatingSupply, restored.issued - restored.burned);
  assert.ok(restored.issued <= MAX_SUPPLY);
  assert.equal(restored.balance(treasury.address), sponsorBefore - MIN_PROGRESS_CANDIDATE_BOND);
  assert.throws(() => restored.progressChallenge(admission.candidateId), /unknown or expired/);
  assert.deepEqual(restored.consensusSnapshot().state.candidateBonds, []);
});

test("a progress challenge requires an independent beacon quorum after commitment", () => {
  const { beaconAuthorities, chain, validators } = fixture();
  const miner = generateWallet();
  const admission = createProgressCommitment({
    wallet: miner,
    networkId: chain.networkId,
    recipient: miner.address,
    artifactHash: `sha256:${fingerprint("challenge-order-candidate")}`,
    baselineHash: `sha256:${fingerprint("baseline")}`,
    baselineContentHash: `sha256:${fingerprint("baseline-content")}`,
    suiteCommitment: fingerprint("challenge-order-suite"),
    nonce: 0,
  });
  const bondedAt = lockProgressBond(
    chain, validators, miner.address, admission.candidateId, TREASURY_VESTING_MS,
  );
  assert.throws(
    () => chain.progressChallenge(admission.candidateId),
    /unknown or expired/,
  );
  const rootBefore = chain.stateRoot;
  const commitBlock = chain.buildBlock({ transactions: [admission], timestamp: bondedAt });
  chain.appendBlock(finalizeBlock(commitBlock, quorumFor(commitBlock, validators)));
  assert.notEqual(chain.stateRoot, rootBefore);
  assert.throws(
    () => chain.progressChallenge(admission.candidateId),
    /not available yet/,
  );
  assert.throws(
    () => chain.progressBeaconCommittee(admission.candidateId),
    /not assigned yet/,
  );
  advanceEpochRandomness(chain, beaconAuthorities, validators, bondedAt);
  assert.throws(
    () => chain.progressChallenge(admission.candidateId),
    /not available yet/,
  );
  const round = chain.height + 1;
  const assignedBeacons = chain.progressBeaconCommittee(admission.candidateId)
    .map((address) => beaconAuthorities.find((wallet) => wallet.address === address));
  const shares = assignedBeacons.map((wallet, index) => createProgressBeaconShare({
    wallet, networkId: chain.networkId, candidateId: admission.candidateId,
    round, value: fingerprint(`challenge-beacon-${index}`),
  }));
  const insufficient = chain.buildBlock({
    progressBeacons: [createProgressBeacon({
      shares: shares.slice(0, 2), networkId: chain.networkId,
      candidateId: admission.candidateId, round,
    })],
    timestamp: currentTimestamp(chain),
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(insufficient, quorumFor(insufficient, validators))),
    /progress beacon is invalid/,
  );
  const wrongDomain = createFallbackBeacon({
    shares: assignedBeacons.map((wallet, index) =>
      createFallbackBeaconShare({
        wallet, networkId: chain.networkId, candidateId: admission.candidateId,
        round, value: fingerprint(`wrong-domain-beacon-${index}`),
      })),
    networkId: chain.networkId,
    candidateId: admission.candidateId,
    round,
  });
  const wrongDomainBlock = chain.buildBlock({
    progressBeacons: [wrongDomain],
    timestamp: currentTimestamp(chain),
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(wrongDomainBlock, quorumFor(wrongDomainBlock, validators))),
    /signature is invalid/,
  );
  const outsider = beaconAuthorities.find((wallet) =>
    !assignedBeacons.some((assigned) => assigned.address === wallet.address));
  const substitutedShares = [
    ...shares.slice(0, -1),
    createProgressBeaconShare({
      wallet: outsider, networkId: chain.networkId, candidateId: admission.candidateId,
      round, value: fingerprint("unassigned-progress-beacon"),
    }),
  ];
  const substituted = chain.buildBlock({
    progressBeacons: [createProgressBeacon({
      shares: substitutedShares, networkId: chain.networkId,
      candidateId: admission.candidateId, round,
    })],
    timestamp: currentTimestamp(chain),
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(substituted, quorumFor(substituted, validators))),
    /signature is invalid/,
  );
  const validBeacon = createProgressBeacon({
    shares, networkId: chain.networkId,
    candidateId: admission.candidateId, round,
  });
  const forgedAggregate = chain.buildBlock({
    progressBeacons: [{ ...validBeacon, value: fingerprint("forged-progress-aggregate") }],
    timestamp: currentTimestamp(chain),
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(forgedAggregate, quorumFor(forgedAggregate, validators))),
    /aggregate is invalid/,
  );
  const crossGeneration = chain.buildBlock({
    progressBeacons: [{ ...validBeacon, generation: 1 }],
    timestamp: currentTimestamp(chain),
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(crossGeneration, quorumFor(crossGeneration, validators))),
    /progress beacon is invalid/,
  );
  const source = chain.buildBlock({
    progressBeacons: [validBeacon],
    timestamp: currentTimestamp(chain),
  });
  const finalizedSource = finalizeBlock(source, quorumFor(source, validators));
  chain.appendBlock(finalizedSource);
  const challenge = chain.progressChallenge(admission.candidateId);
  assert.equal(challenge.sourceHeight, finalizedSource.height);
  assert.equal(challenge.beaconValue, finalizedSource.progressBeacons[0].value);
  assert.equal(challenge.committee.length, 3);
  assert.equal(new Set(challenge.committee).size, 3);
});

test("finalized blocks advance post-quantum epoch randomness in two phases", () => {
  const { beaconAuthorities, chain, validators } = fixture();
  const initial = chain.epochRandomnessStatus();
  const members = initial.committee.map((address) =>
    beaconAuthorities.find((wallet) => wallet.address === address));
  const secrets = members.map((_, index) => fingerprint(`chain-epoch-secret-${index}`));
  const commits = members.map((wallet, index) => createEpochRandomnessCommit({
    wallet, networkId: chain.networkId, round: initial.round, secret: secrets[index],
  }));
  const reveals = members.map((wallet, index) => createEpochRandomnessReveal({
    wallet, networkId: chain.networkId, round: initial.round, secret: secrets[index],
  }));
  const premature = chain.buildBlock({
    epochRandomnessCommits: commits, epochRandomnessReveals: reveals, timestamp: 0,
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(premature, quorumFor(premature, validators))),
    /premature/,
  );
  const commitBlock = chain.buildBlock({ epochRandomnessCommits: commits, timestamp: 0 });
  chain.appendBlock(finalizeBlock(commitBlock, quorumFor(commitBlock, validators)));
  assert.equal(chain.epochRandomnessStatus().commitHeight, commitBlock.height);
  const rootAfterCommit = chain.stateRoot;
  const revealBlock = chain.buildBlock({ epochRandomnessReveals: reveals, timestamp: 0 });
  chain.appendBlock(finalizeBlock(revealBlock, quorumFor(revealBlock, validators)));
  const completed = chain.epochRandomnessStatus();
  assert.equal(completed.round, initial.round + 1);
  assert.notEqual(completed.previousSeed, initial.previousSeed);
  assert.notEqual(chain.stateRoot, rootAfterCommit);
  assert.equal(completed.commitments.length, 0);
  assert.equal(completed.reveals.length, 0);
});

test("an epoch non-revealer is excluded and the same round safely rotates", () => {
  const { beaconAuthorities, chain, validators } = fixture();
  const initial = chain.epochRandomnessStatus();
  const members = initial.committee.map((address) =>
    beaconAuthorities.find((wallet) => wallet.address === address));
  const secrets = members.map((_, index) => fingerprint(`withheld-epoch-${index}`));
  const commitBlock = chain.buildBlock({
    epochRandomnessCommits: members.map((wallet, index) => createEpochRandomnessCommit({
      wallet, networkId: chain.networkId, round: initial.round, secret: secrets[index],
    })),
    timestamp: 0,
  });
  chain.appendBlock(finalizeBlock(commitBlock, quorumFor(commitBlock, validators)));
  const partialReveal = chain.buildBlock({
    epochRandomnessReveals: members.slice(0, -1).map((wallet, index) =>
      createEpochRandomnessReveal({
        wallet, networkId: chain.networkId, round: initial.round, secret: secrets[index],
      })),
    timestamp: 0,
  });
  chain.appendBlock(finalizeBlock(partialReveal, quorumFor(partialReveal, validators)));
  while (chain.height <= commitBlock.height + EPOCH_REVEAL_TIMEOUT_BLOCKS) {
    const block = chain.buildBlock({ timestamp: 0 });
    chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  }
  const rotated = chain.epochRandomnessStatus();
  const withheld = members.at(-1).address;
  assert.equal(rotated.round, initial.round);
  assert.equal(rotated.attempt, 1);
  assert.deepEqual(rotated.excluded, [withheld]);
  assert.ok(!rotated.committee.includes(withheld));
  assert.deepEqual(rotated.lastFault.nonRevealers, [withheld]);
  assert.equal(rotated.commitments.length, 0);
  assert.equal(rotated.reveals.length, 0);
});

test("bonded epoch randomness sabotage burns NIR and disables the offender", () => {
  const { beaconAuthorities, chain, treasury, validators } = fixture();
  const timestamp = TREASURY_VESTING_MS;
  const outsider = generateWallet();
  const outsiderBlock = chain.buildBlock({
    transactions: [createBeaconBond({
      wallet: outsider, networkId: chain.networkId, amount: MIN_BEACON_BOND.toString(), nonce: 0,
    })],
    timestamp,
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(outsiderBlock, quorumFor(outsiderBlock, validators))),
    /beacon bond transaction is invalid/,
  );
  const funding = beaconAuthorities.map((authority, index) => createTransfer({
    wallet: treasury,
    networkId: chain.networkId,
    recipient: authority.address,
    amount: (MIN_BEACON_BOND + MIN_TRANSFER_FEE).toString(),
    nonce: chain.nextNonce(treasury.address) + index,
  }));
  const fundingBlock = chain.buildBlock({ transactions: funding, timestamp });
  chain.appendBlock(finalizeBlock(fundingBlock, quorumFor(fundingBlock, validators)));
  const bonds = beaconAuthorities.map((authority) => createBeaconBond({
    wallet: authority,
    networkId: chain.networkId,
    amount: MIN_BEACON_BOND.toString(),
    nonce: chain.nextNonce(authority.address),
  }));
  const bondBlock = chain.buildBlock({ transactions: bonds, timestamp });
  chain.appendBlock(finalizeBlock(bondBlock, quorumFor(bondBlock, validators)));
  assert.equal(chain.beaconBondingActive, true);

  const initial = chain.epochRandomnessStatus();
  const members = initial.committee.map((address) =>
    beaconAuthorities.find((wallet) => wallet.address === address));
  const secrets = members.map((_, index) => fingerprint(`bonded-withhold-${index}`));
  const commitBlock = chain.buildBlock({
    epochRandomnessCommits: members.map((wallet, index) => createEpochRandomnessCommit({
      wallet, networkId: chain.networkId, round: initial.round, secret: secrets[index],
    })),
    timestamp,
  });
  chain.appendBlock(finalizeBlock(commitBlock, quorumFor(commitBlock, validators)));
  const revealBlock = chain.buildBlock({
    epochRandomnessReveals: members.slice(0, -1).map((wallet, index) =>
      createEpochRandomnessReveal({
        wallet, networkId: chain.networkId, round: initial.round, secret: secrets[index],
      })),
    timestamp,
  });
  chain.appendBlock(finalizeBlock(revealBlock, quorumFor(revealBlock, validators)));
  while (chain.height <= commitBlock.height + EPOCH_REVEAL_TIMEOUT_BLOCKS) {
    const block = chain.buildBlock({ timestamp });
    chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  }
  const offender = members.at(-1).address;
  const expectedPenalty = (MIN_BEACON_BOND * BEACON_NON_REVEAL_SLASH_BPS) / 10_000n;
  assert.equal(chain.beaconBond(offender), MIN_BEACON_BOND - expectedPenalty);
  assert.equal(chain.beaconFaultCount(offender), 1);
  assert.equal(chain.burned, expectedPenalty);
  assert.deepEqual(chain.epochRandomnessStatus().disabled, [offender]);
  assert.ok(!chain.epochRandomnessStatus().committee.includes(offender));
  const offenderWallet = members.at(-1);
  const disabledBond = chain.buildBlock({
    transactions: [createBeaconBond({
      wallet: offenderWallet, networkId: chain.networkId, amount: "1",
      nonce: chain.nextNonce(offender),
    })],
    timestamp,
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(disabledBond, quorumFor(disabledBond, validators))),
    /beacon bond transaction is invalid/,
  );
});

test("known capability cannot mint against a weaker selected baseline", () => {
  const { chain } = fixture();
  assert.throws(
    () => chain.prepareProgressEvaluation({
      artifactHash: `sha256:${fingerprint("repackaged-known-model")}`,
      baselineHash: `sha256:${fingerprint("baseline")}`,
      executionBundleHash: fingerprint("repackaged-known-model-bundle"),
      suiteCommitment: fingerprint("hidden-suite-v1"),
      parents: [`sha256:${fingerprint("baseline")}`],
      committedEpoch: 0,
      challengeEpoch: 1,
      challengeSeed: fingerprint("challenge-1"),
      behaviorCommitment: fingerprint("repackaged-behavior"),
      capabilitiesBps: { "code-v1": 7_000, "reasoning-v1": 8_000 },
      gainPpm: 10_000,
      generalityBps: 10_000,
      reproducibilityBps: 10_000,
      safetyBps: 10_000,
      safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT,
      criticalSafetyPass: true,
      candidateEnergyWh: 100,
      baselineEnergyWh: 100,
      energyAttested: true,
    }),
    /no new world-frontier capability/,
  );
});

test("empty blocks do not consume intelligence issuance epochs", () => {
  const { chain, evaluators, validators } = fixture();
  const empty = chain.buildBlock({ timestamp: 1 });
  chain.appendBlock(finalizeBlock(empty, quorumFor(empty, validators)));
  assert.equal(chain.nextIssuanceEpoch, 0);

  const miner = generateWallet();
  const rewarded = chain.buildBlock({
    rewardClaims: [progressClaim(chain, evaluators, validators, miner)],
    timestamp: currentTimestamp(chain),
  });
  assert.equal(rewarded.issuanceEpoch, 0);
  chain.appendBlock(finalizeBlock(rewarded, quorumFor(rewarded, validators)));
  assert.equal(chain.nextIssuanceEpoch, 1);
  assert.equal(formatNir(chain.balance(miner.address)), "0.00000000 NIR");
  assert.equal(chain.accountState(miner.address).resources.pendingProgressReward.amount,
    INITIAL_EPOCH_REWARD.toString());
});

test("fast hardware cannot accelerate intelligence issuance", () => {
  const { chain, evaluators, validators } = fixture();
  const firstMiner = generateWallet();
  const first = chain.buildBlock({
    rewardClaims: [progressClaim(chain, evaluators, validators, firstMiner)],
    timestamp: currentTimestamp(chain),
  });
  chain.appendBlock(finalizeBlock(first, quorumFor(first, validators)));
  matureProgressRewards(chain, validators);

  const secondMiner = generateWallet();
  const secondClaim = progressClaim(
    chain,
    evaluators,
    validators,
    secondMiner,
    "second-frontier",
  );
  assert.throws(
    () => chain.buildBlock({
      rewardClaims: [secondClaim],
      timestamp: chain.blocks().at(-1).timestamp + MIN_REWARD_INTERVAL_MS - 1,
    }),
    /too quickly/,
  );
});

test("fewer than two-thirds plus one validator votes cannot finalize", () => {
  const { chain, evaluators, validators } = fixture();
  const block = chain.buildBlock({ timestamp: 1 });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(block, validators.slice(0, 2))),
    /quorum/,
  );
});

test("commit votes cannot replace or bypass the prepare certificate", () => {
  const { chain, validators } = fixture();
  const block = chain.buildBlock({ timestamp: 1 });
  const finalized = finalizeBlock(block, quorumFor(block, validators));
  assert.throws(() => chain.appendBlock({
    ...finalized,
    prepareCertificate: finalized.prepareCertificate.slice(0, 2),
  }), /prepare quorum/);
  assert.throws(() => chain.appendBlock({
    ...finalized,
    certificate: finalized.prepareCertificate,
  }), /validator signature/);
  assert.equal(chain.height, 0);
});

test("a post-quantum signed transfer changes balances and nonce", () => {
  const { chain, evaluators, validators } = fixture();
  const alice = generateWallet();
  const bob = generateWallet();
  const rewardBlock = chain.buildBlock({
    rewardClaims: [
      progressClaim(chain, evaluators, validators, alice),
    ],
    timestamp: currentTimestamp(chain),
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  matureProgressRewards(chain, validators);
  const earlierAliceTransactions = chain.blocks().flatMap(({ transactions }) => transactions)
    .filter(({ sender, recipient }) => sender === alice.address || recipient === alice.address)
    .map(transactionId);

  const transaction = createTransfer({
    wallet: alice,
    networkId: chain.networkId,
    recipient: bob.address,
    amount: "125000000",
    nonce: chain.nextNonce(alice.address),
    fee: "1000",
  });
  const beforeTransferRoot = chain.stateRoot;
  const block = chain.buildBlock({ transactions: [transaction], timestamp: currentTimestamp(chain) });
  assert.notEqual(block.stateRoot, beforeTransferRoot);
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  assert.equal(chain.stateRoot, block.stateRoot);
  assert.equal(chain.balance(bob.address), 125_000_000n);
  assert.equal(chain.nextNonce(alice.address), 2);
  assert.deepEqual(chain.accountState(alice.address).history,
    accountHistoryCommitment([...earlierAliceTransactions, transactionId(transaction)]));
  assert.deepEqual(chain.accountState(bob.address).history,
    accountHistoryCommitment([transactionId(transaction)]));
});

test("a transfer below the consensus fee floor is rejected", () => {
  const { chain, evaluators, validators } = fixture();
  const alice = generateWallet();
  const bob = generateWallet();
  const rewardBlock = chain.buildBlock({
    rewardClaims: [progressClaim(chain, evaluators, validators, alice)],
    timestamp: currentTimestamp(chain),
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  matureProgressRewards(chain, validators);
  const transaction = createTransfer({
    wallet: alice,
    networkId: chain.networkId,
    recipient: bob.address,
    amount: "1",
    nonce: chain.nextNonce(alice.address),
    fee: (MIN_TRANSFER_FEE - 1n).toString(),
  });
  const block = chain.buildBlock({ transactions: [transaction], timestamp: currentTimestamp(chain) });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(block, quorumFor(block, validators))),
    /below the protocol minimum/,
  );
  assert.equal(chain.balance(bob.address), 0n);
});

test("wallet fee display reports an exact conservative percentage", () => {
  assert.equal(formatFeePercent("100000000", "1000"), "0.001000%");
  assert.equal(formatFeePercent("300000000", "1000"), "0.000334%");
  assert.equal(quoteTransferFee("100000000", "1000").requiresExplicitConfirmation, false);
  assert.equal(quoteTransferFee("100000000", "1000000").requiresExplicitConfirmation, true);
});

test("a two-of-three post-quantum vault can spend only with its threshold", () => {
  const { chain, evaluators, validators } = fixture();
  const members = Array.from({ length: 3 }, generateWallet);
  const memberPublicKeys = members.map(({ publicKey }) => publicKey);
  const vaultAddress = multisigAddress(memberPublicKeys, 2);
  const recipient = generateWallet();
  const rewardBlock = chain.buildBlock({
    rewardClaims: [
      progressClaim(chain, evaluators, validators, members[0], "proof-a", vaultAddress),
    ],
    timestamp: currentTimestamp(chain),
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  matureProgressRewards(chain, validators);

  const insufficient = createMultisigTransfer({
    signerWallets: members.slice(0, 1), memberPublicKeys, threshold: 2,
    networkId: chain.networkId, recipient: recipient.address, amount: "100000000", nonce: 0,
  });
  const rejected = chain.buildBlock({ transactions: [insufficient], timestamp: currentTimestamp(chain) });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(rejected, quorumFor(rejected, validators))),
    /threshold not reached/,
  );

  const authorized = createMultisigTransfer({
    signerWallets: [members[0], members[2]], memberPublicKeys, threshold: 2,
    networkId: chain.networkId, recipient: recipient.address, amount: "100000000", nonce: 0,
  });
  const accepted = chain.buildBlock({ transactions: [authorized], timestamp: currentTimestamp(chain) });
  chain.appendBlock(finalizeBlock(accepted, quorumFor(accepted, validators)));
  assert.equal(chain.balance(recipient.address), 100000000n);
});

test("an unknown signer cannot join a multisignature transfer", () => {
  const members = Array.from({ length: 3 }, generateWallet);
  assert.throws(() => createMultisigTransfer({
    signerWallets: [members[0], generateWallet()],
    memberPublicKeys: members.map(({ publicKey }) => publicKey),
    threshold: 2,
    networkId: "nir-testnet",
    recipient: generateWallet().address,
    amount: "1",
    nonce: 0,
  }), /unknown or duplicated/);
});

test("candidate bonds, safety payouts, and burns are consensus state", () => {
  const { chain, evaluators, validators } = fixture();
  const submitter = generateWallet();
  const reporter = generateWallet();
  const candidateId = fingerprint("bonded-unsafe-candidate");
  const rewardBlock = chain.buildBlock({
    rewardClaims: [progressClaim(chain, evaluators, validators, submitter, "fund-bond")],
    timestamp: currentTimestamp(chain),
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  matureProgressRewards(chain, validators);
  const bondTimestamp = activateRandomnessValidators(
    chain, validators, submitter, currentTimestamp(chain),
  );

  const bond = createCandidateBond({
    wallet: submitter,
    networkId: chain.networkId,
    candidateId,
    amount: "1000000000",
    nonce: chain.nextNonce(submitter.address),
  });
  const bondBlock = chain.buildBlock({ transactions: [bond], timestamp: bondTimestamp });
  chain.appendBlock(finalizeBlock(bondBlock, quorumFor(bondBlock, validators)));

  assert.throws(
    () => chain.assignedSafetyEvaluators(candidateId),
    /committee is not assigned/,
  );
  finalizeRandomness(chain, candidateId, validators, bondTimestamp + 1);
  const assignedEvaluators = assignedEvaluatorWallets(chain, candidateId, evaluators);

  const unassignedEvaluator = evaluators.find(
    ({ address }) => !assignedEvaluators.some((wallet) => wallet.address === address),
  );
  const wrongCommittee = [assignedEvaluators[0], assignedEvaluators[1], unassignedEvaluator];
  const wrongClaim = createSafetyFailureClaim({
    networkId: chain.networkId,
    epoch: chain.height + 1,
    candidateId,
    evidenceHash: fingerprint("wrong-committee-evidence"),
    reporter: reporter.address,
    safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT,
    evaluatorWallets: wrongCommittee,
  });
  assert.throws(
    () => chain.buildBlock({ safetyClaims: [wrongClaim], timestamp: bondTimestamp + 3 }),
    /assigned committee/,
  );

  const claim = createSafetyFailureClaim({
    networkId: chain.networkId,
    epoch: chain.height + 1,
    candidateId,
    evidenceHash: fingerprint("bonded-critical-evidence"),
    reporter: reporter.address,
    safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT,
    evaluatorWallets: assignedEvaluators,
  });
  const safetyBlock = chain.buildBlock({ safetyClaims: [claim], timestamp: bondTimestamp + 3 });
  chain.appendBlock(finalizeBlock(safetyBlock, quorumFor(safetyBlock, validators)));
  assert.equal(chain.balance(reporter.address), 700000000n);
  assert.equal(chain.burned, 200000001n);
  assert.equal(chain.circulatingSupply, chain.issued - chain.burned);
  const replay = createSafetyFailureClaim({
    networkId: chain.networkId,
    epoch: chain.height + 1,
    candidateId,
    evidenceHash: fingerprint("bonded-critical-evidence"),
    reporter: reporter.address,
    safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT,
    evaluatorWallets: assignedEvaluators,
  });
  assert.throws(
    () => chain.buildBlock({ safetyClaims: [replay], timestamp: bondTimestamp + 4 }),
    /already settled|no locked candidate bond/,
  );
});

test("validators cannot approve a forged safety payout amount", () => {
  const { chain, evaluators, validators } = fixture();
  const submitter = generateWallet();
  const reporter = generateWallet();
  const candidateId = fingerprint("forged-payout-candidate");
  const rewardBlock = chain.buildBlock({
    rewardClaims: [progressClaim(chain, evaluators, validators, submitter, "fund-forgery")],
    timestamp: currentTimestamp(chain),
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  matureProgressRewards(chain, validators);
  const bondTimestamp = activateRandomnessValidators(
    chain, validators, submitter, currentTimestamp(chain),
  );
  const bond = createCandidateBond({
    wallet: submitter, networkId: chain.networkId, candidateId,
    amount: "1000000000", nonce: chain.nextNonce(submitter.address),
  });
  const bondBlock = chain.buildBlock({ transactions: [bond], timestamp: bondTimestamp });
  chain.appendBlock(finalizeBlock(bondBlock, quorumFor(bondBlock, validators)));
  finalizeRandomness(chain, candidateId, validators, bondTimestamp + 1);
  const assignedEvaluators = assignedEvaluatorWallets(chain, candidateId, evaluators);
  const unapproved = createSafetyFailureClaim({
    networkId: chain.networkId, epoch: chain.height + 1, candidateId,
    evidenceHash: fingerprint("unapproved-policy-evidence"), reporter: reporter.address,
    safetyPolicyHash: fingerprint("attacker-policy"),
    evaluatorWallets: assignedEvaluators,
  });
  assert.throws(
    () => chain.buildBlock({ safetyClaims: [unapproved], timestamp: bondTimestamp + 3 }),
    /unapproved safety policy/,
  );
  const claim = createSafetyFailureClaim({
    networkId: chain.networkId, epoch: chain.height + 1, candidateId,
    evidenceHash: fingerprint("forged-payout-evidence"), reporter: reporter.address,
    safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT,
    evaluatorWallets: assignedEvaluators,
  });
  const forged = chain.buildBlock({ safetyClaims: [claim], timestamp: bondTimestamp + 3 });
  forged.safetySettlements[0].settlement.reporterReward.amount = "1000000000";
  assert.throws(
    () => chain.appendBlock(finalizeBlock(forged, quorumFor(forged, validators))),
    /invalid safety settlement allocation/,
  );
  assert.equal(chain.balance(reporter.address), 0n);
  assert.equal(chain.burned, 0n);
});

test("a fallback beacon assigns the committee and slashes a missing revealer", () => {
  const { beaconAuthorities, chain, evaluators, validators } = fixture();
  const submitter = generateWallet();
  const candidateId = fingerprint("withheld-randomness-candidate");
  const rewardBlock = chain.buildBlock({
    rewardClaims: [progressClaim(chain, evaluators, validators, submitter, "fund-withholding")],
    timestamp: currentTimestamp(chain),
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  matureProgressRewards(chain, validators);
  const bondTimestamp = activateRandomnessValidators(
    chain, validators, submitter, currentTimestamp(chain),
  );
  const funded = chain.balance(submitter.address);
  const bond = createCandidateBond({
    wallet: submitter, networkId: chain.networkId, candidateId,
    amount: "1000000000", nonce: chain.nextNonce(submitter.address),
  });
  const bondBlock = chain.buildBlock({ transactions: [bond], timestamp: bondTimestamp });
  chain.appendBlock(finalizeBlock(bondBlock, quorumFor(bondBlock, validators)));
  const unbondedSecret = fingerprint("unbonded-validator-secret");
  const unbondedCommitBlock = chain.buildBlock({
    randomnessCommits: [createRandomnessCommit({
      wallet: validators[3], networkId: chain.networkId, candidateId, secret: unbondedSecret,
    })],
    timestamp: bondTimestamp + 1,
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(unbondedCommitBlock, quorumFor(unbondedCommitBlock, validators))),
    /invalid or duplicate randomness commitment/,
  );
  const contributors = validators.slice(0, 3).map((wallet, index) => ({
    secret: fingerprint(`withhold-${index}`), wallet,
  }));
  const commitBlock = chain.buildBlock({
    randomnessCommits: contributors.map(({ secret, wallet }) => createRandomnessCommit({
      wallet, networkId: chain.networkId, candidateId, secret,
    })), timestamp: bondTimestamp + 1,
  });
  chain.appendBlock(finalizeBlock(commitBlock, quorumFor(commitBlock, validators)));
  const revealBlock = chain.buildBlock({
    randomnessReveals: contributors.slice(0, 2).map(({ secret, wallet }) => createRandomnessReveal({
      wallet, networkId: chain.networkId, candidateId, secret,
    })), timestamp: bondTimestamp + 2,
  });
  chain.appendBlock(finalizeBlock(revealBlock, quorumFor(revealBlock, validators)));
  const timeoutHeight = chain.height + 1;
  const insufficientBeaconBlock = chain.buildBlock({
    fallbackBeacons: [createFallbackBeacon({
      shares: beaconAuthorities.slice(0, 2).map((wallet, index) => createFallbackBeaconShare({
        wallet, networkId: chain.networkId, candidateId, round: timeoutHeight,
        value: fingerprint(`insufficient-fallback-round-${index}`),
      })), networkId: chain.networkId, candidateId, round: timeoutHeight,
    })],
    timestamp: bondTimestamp + 3,
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(insufficientBeaconBlock, quorumFor(insufficientBeaconBlock, validators))),
    /fallback beacon quorum not reached/,
  );
  const timeoutBlock = chain.buildBlock({
    fallbackBeacons: [createFallbackBeacon({
      shares: beaconAuthorities.slice(0, 3).map((wallet, index) => createFallbackBeaconShare({
        wallet, networkId: chain.networkId, candidateId, round: timeoutHeight,
        value: fingerprint(`independent-fallback-round-${index}`),
      })), networkId: chain.networkId, candidateId, round: timeoutHeight,
    })],
    timestamp: bondTimestamp + 3,
  });
  const forgedAggregate = structuredClone(timeoutBlock);
  forgedAggregate.fallbackBeacons[0].value = fingerprint("aggregator-chosen-value");
  assert.throws(
    () => chain.appendBlock(finalizeBlock(forgedAggregate, quorumFor(forgedAggregate, validators))),
    /fallback beacon aggregate is invalid/,
  );
  const crossGeneration = structuredClone(timeoutBlock);
  crossGeneration.fallbackBeacons[0].generation = 1;
  assert.throws(
    () => chain.appendBlock(finalizeBlock(crossGeneration, quorumFor(crossGeneration, validators))),
    /fallback beacon is invalid/,
  );
  chain.appendBlock(finalizeBlock(timeoutBlock, quorumFor(timeoutBlock, validators)));

  assert.deepEqual(chain.randomnessFault(candidateId).nonRevealers, [contributors[2].wallet.address]);
  assert.equal(chain.validatorRandomnessFaults(contributors[2].wallet.address), 1);
  assert.equal(
    chain.validatorBond(contributors[2].wallet.address),
    MIN_VALIDATOR_BOND - (MIN_VALIDATOR_BOND / 100n),
  );
  assert.equal(chain.burned, MIN_VALIDATOR_BOND / 100n);
  assert.equal(chain.balance(submitter.address), funded - 1000000000n - MIN_TRANSFER_FEE);
  assert.equal(chain.assignedSafetyEvaluators(candidateId).length, 3);
});

test("a modified transfer signature is rejected atomically", () => {
  const { chain, evaluators, validators } = fixture();
  const alice = generateWallet();
  const bob = generateWallet();
  const rewardBlock = chain.buildBlock({
    rewardClaims: [
      progressClaim(chain, evaluators, validators, alice),
    ],
    timestamp: currentTimestamp(chain),
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  matureProgressRewards(chain, validators);
  const transaction = createTransfer({
    wallet: alice,
    networkId: chain.networkId,
    recipient: bob.address,
    amount: "1",
    nonce: 0,
  });
  transaction.amount = "2";
  const heightBefore = chain.height;
  const block = chain.buildBlock({ transactions: [transaction], timestamp: currentTimestamp(chain) });
  const finalized = finalizeBlock(block, quorumFor(block, validators));
  assert.throws(() => chain.appendBlock(finalized), /signature/);
  assert.equal(chain.height, heightBefore);
  assert.equal(chain.balance(bob.address), 0n);
});

test("a signed transfer cannot be replayed on another network", () => {
  const { chain, evaluators, validators } = fixture();
  const alice = generateWallet();
  const bob = generateWallet();
  const transaction = createTransfer({
    wallet: alice,
    networkId: "nir-other-network",
    recipient: bob.address,
    amount: "1",
    nonce: 0,
  });
  const block = chain.buildBlock({ transactions: [transaction], timestamp: 1 });
  const finalized = finalizeBlock(block, quorumFor(block, validators));
  assert.throws(() => chain.appendBlock(finalized), /another network/);
  assert.equal(chain.height, 0);
});

test("a fee sponsor can pay for an exact transfer without controlling its funds", () => {
  const { chain, evaluators, validators } = fixture();
  const sponsor = generateWallet();
  const alice = generateWallet();
  const bob = generateWallet();
  const rewardBlock = chain.buildBlock({
    rewardClaims: [progressClaim(chain, evaluators, validators, sponsor, "sponsor-funds")],
    timestamp: currentTimestamp(chain),
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  matureProgressRewards(chain, validators);
  const funding = createTransfer({
    wallet: sponsor, networkId: chain.networkId, recipient: alice.address,
    amount: "100", nonce: chain.nextNonce(sponsor.address),
  });
  const fundingBlock = chain.buildBlock({ transactions: [funding], timestamp: currentTimestamp(chain) });
  chain.appendBlock(finalizeBlock(fundingBlock, quorumFor(fundingBlock, validators)));
  const sponsorBefore = chain.balance(sponsor.address);
  const sponsorNonce = chain.nextNonce(sponsor.address);
  const transfer = createSponsoredTransfer({
    wallet: alice,
    sponsorWallet: sponsor,
    networkId: chain.networkId,
    recipient: bob.address,
    amount: "100",
    nonce: chain.nextNonce(alice.address),
    sponsorNonce,
  });
  const forged = chain.buildBlock({
    transactions: [{ ...transfer, feePayerSignature: transfer.signature }],
    timestamp: currentTimestamp(chain),
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(forged, quorumFor(forged, validators))),
    /fee payer signature/,
  );
  const block = chain.buildBlock({ transactions: [transfer], timestamp: currentTimestamp(chain) });
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  assert.equal(chain.balance(alice.address), 0n);
  assert.equal(chain.balance(bob.address), 100n);
  assert.equal(chain.balance(sponsor.address), sponsorBefore - MIN_TRANSFER_FEE);
  assert.equal(chain.nextNonce(alice.address), 1);
  assert.equal(chain.nextNonce(sponsor.address), sponsorNonce + 1);
  const replay = chain.buildBlock({ transactions: [transfer], timestamp: currentTimestamp(chain) });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(replay, quorumFor(replay, validators))),
    /nonce/,
  );
});

test("locked NIR supplies bounded renewable credits for sponsored transfers", () => {
  const { chain, treasury, validators } = fixture();
  const sponsor = generateWallet();
  const alice = generateWallet();
  const bob = generateWallet();
  const timestamp = TREASURY_VESTING_MS;
  const funding = [
    createTransfer({
      wallet: treasury, networkId: chain.networkId, recipient: sponsor.address,
      amount: (TRANSFER_CREDIT_STAKE_UNIT + MIN_TRANSFER_FEE).toString(), nonce: 0,
    }),
    createTransfer({
      wallet: treasury, networkId: chain.networkId, recipient: alice.address,
      amount: "100", nonce: 1,
    }),
  ];
  const fundingBlock = chain.buildBlock({ transactions: funding, timestamp });
  chain.appendBlock(finalizeBlock(fundingBlock, quorumFor(fundingBlock, validators)));
  const stake = createCreditStake({
    wallet: sponsor, networkId: chain.networkId,
    amount: TRANSFER_CREDIT_STAKE_UNIT.toString(), nonce: 0,
  });
  const stakeBlock = chain.buildBlock({ transactions: [stake], timestamp });
  chain.appendBlock(finalizeBlock(stakeBlock, quorumFor(stakeBlock, validators)));
  assert.equal(chain.creditStake(sponsor.address), TRANSFER_CREDIT_STAKE_UNIT);
  assert.equal(chain.transferCredits(sponsor.address), BigInt(TRANSFER_CREDITS_PER_STAKE_UNIT));

  const sponsorBalance = chain.balance(sponsor.address);
  const transfer = createSponsoredTransfer({
    wallet: alice,
    sponsorWallet: sponsor,
    networkId: chain.networkId,
    recipient: bob.address,
    amount: "25",
    nonce: 0,
    sponsorNonce: 1,
    useCredits: true,
  });
  const block = chain.buildBlock({ transactions: [transfer], timestamp });
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  assert.equal(chain.balance(alice.address), 75n);
  assert.equal(chain.balance(bob.address), 25n);
  assert.equal(chain.balance(sponsor.address), sponsorBalance);
  assert.equal(
    chain.transferCredits(sponsor.address),
    BigInt(TRANSFER_CREDITS_PER_STAKE_UNIT - 1),
  );
  assert.equal(
    chain.transferCredits(sponsor.address, 721),
    BigInt(TRANSFER_CREDITS_PER_STAKE_UNIT),
  );

  const forgedFree = createCreditTransfer({
    wallet: alice, networkId: chain.networkId, recipient: bob.address,
    amount: "1", nonce: 1,
  });
  const rejected = chain.buildBlock({ transactions: [forgedFree], timestamp });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(rejected, quorumFor(rejected, validators))),
    /quota is exhausted/,
  );
  const overCapacity = chain.buildBlock({
    transactions: Array.from({ length: 101 }, () => forgedFree), timestamp,
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(overCapacity, quorumFor(overCapacity, validators))),
    /too many credit-paid transfers/,
  );
});

test("credit delegation is revocable and stake exits only after the delay", () => {
  const { chain, treasury, validators } = fixture();
  const owner = generateWallet();
  const delegate = generateWallet();
  const recipient = generateWallet();
  const timestamp = TREASURY_VESTING_MS;
  const funding = [
    createTransfer({
      wallet: treasury, networkId: chain.networkId, recipient: owner.address,
      amount: (TRANSFER_CREDIT_STAKE_UNIT + 2n * MIN_TRANSFER_FEE).toString(), nonce: 0,
    }),
    createTransfer({
      wallet: treasury, networkId: chain.networkId, recipient: delegate.address,
      amount: "10", nonce: 1,
    }),
  ];
  const fundingBlock = chain.buildBlock({ transactions: funding, timestamp });
  chain.appendBlock(finalizeBlock(fundingBlock, quorumFor(fundingBlock, validators)));
  const stake = createCreditStake({
    wallet: owner, networkId: chain.networkId,
    amount: TRANSFER_CREDIT_STAKE_UNIT.toString(), nonce: 0,
  });
  const stakeBlock = chain.buildBlock({ transactions: [stake], timestamp });
  chain.appendBlock(finalizeBlock(stakeBlock, quorumFor(stakeBlock, validators)));
  const delegation = createCreditDelegation({
    wallet: owner, delegate: delegate.address, networkId: chain.networkId,
    limit: 2, nonce: 1,
  });
  const delegationBlock = chain.buildBlock({ transactions: [delegation], timestamp });
  chain.appendBlock(finalizeBlock(delegationBlock, quorumFor(delegationBlock, validators)));
  const delegated = createDelegatedCreditTransfer({
    wallet: delegate, creditOwner: owner.address, networkId: chain.networkId,
    recipient: recipient.address, amount: "1", nonce: 0,
  });
  const transferBlock = chain.buildBlock({ transactions: [delegated], timestamp });
  chain.appendBlock(finalizeBlock(transferBlock, quorumFor(transferBlock, validators)));
  assert.equal(chain.balance(recipient.address), 1n);
  assert.equal(chain.creditDelegation(owner.address, delegate.address).spent, 1);

  const revoke = createCreditDelegation({
    wallet: owner, delegate: delegate.address, networkId: chain.networkId,
    limit: 0, nonce: 2,
  });
  const revokeBlock = chain.buildBlock({ transactions: [revoke], timestamp });
  chain.appendBlock(finalizeBlock(revokeBlock, quorumFor(revokeBlock, validators)));
  assert.equal(chain.creditDelegation(owner.address, delegate.address), null);
  assert.equal(chain.creditStake(owner.address), TRANSFER_CREDIT_STAKE_UNIT - MIN_TRANSFER_FEE);
  const replay = createDelegatedCreditTransfer({
    wallet: delegate, creditOwner: owner.address, networkId: chain.networkId,
    recipient: recipient.address, amount: "1", nonce: 1,
  });
  const rejected = chain.buildBlock({ transactions: [replay], timestamp });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(rejected, quorumFor(rejected, validators))),
    /delegation is missing/,
  );

  const request = createCreditUnstakeRequest({
    wallet: owner, networkId: chain.networkId,
    amount: (TRANSFER_CREDIT_STAKE_UNIT - MIN_TRANSFER_FEE).toString(), nonce: 3,
  });
  const requestBlock = chain.buildBlock({ transactions: [request], timestamp });
  chain.appendBlock(finalizeBlock(requestBlock, quorumFor(requestBlock, validators)));
  assert.equal(chain.creditStake(owner.address), 0n);
  const pending = chain.creditUnstake(owner.address);
  assert.equal(pending.unlockHeight, requestBlock.height + CREDIT_UNSTAKE_DELAY_BLOCKS);
  const earlyClaim = createCreditUnstakeClaim({
    wallet: owner, networkId: chain.networkId, nonce: 4,
  });
  const earlyBlock = chain.buildBlock({ transactions: [earlyClaim], timestamp });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(earlyBlock, quorumFor(earlyBlock, validators))),
    /not unlocked/,
  );
  while (chain.height + 1 < pending.unlockHeight) {
    const block = chain.buildBlock({ timestamp });
    chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  }
  const claim = createCreditUnstakeClaim({
    wallet: owner, networkId: chain.networkId, nonce: 4,
  });
  const claimBlock = chain.buildBlock({ transactions: [claim], timestamp });
  chain.appendBlock(finalizeBlock(claimBlock, quorumFor(claimBlock, validators)));
  assert.equal(chain.creditUnstake(owner.address), null);
  assert.equal(chain.balance(owner.address), TRANSFER_CREDIT_STAKE_UNIT - 2n * MIN_TRANSFER_FEE);
});

test("a delegation cannot be reduced below current-epoch consumption", () => {
  const { chain, genesisConfig, treasury, validators } = fixture();
  const owner = generateWallet();
  const delegate = generateWallet();
  const recipient = generateWallet();
  const timestamp = TREASURY_VESTING_MS;
  const funding = chain.buildBlock({
    transactions: [
      createTransfer({
        wallet: treasury, networkId: chain.networkId, recipient: owner.address,
        amount: (TRANSFER_CREDIT_STAKE_UNIT + 3n * MIN_TRANSFER_FEE).toString(), nonce: 0,
      }),
      createTransfer({
        wallet: treasury, networkId: chain.networkId, recipient: delegate.address,
        amount: "2", nonce: 1,
      }),
    ],
    timestamp,
  });
  chain.appendBlock(finalizeBlock(funding, quorumFor(funding, validators)));
  const stake = createCreditStake({
    wallet: owner, networkId: chain.networkId,
    amount: TRANSFER_CREDIT_STAKE_UNIT.toString(), nonce: 0,
  });
  const delegation = createCreditDelegation({
    wallet: owner, delegate: delegate.address, networkId: chain.networkId,
    limit: 3, nonce: 1,
  });
  const setup = chain.buildBlock({ transactions: [stake, delegation], timestamp });
  chain.appendBlock(finalizeBlock(setup, quorumFor(setup, validators)));
  const spends = [0, 1].map((nonce) => createDelegatedCreditTransfer({
    wallet: delegate, creditOwner: owner.address, networkId: chain.networkId,
    recipient: recipient.address, amount: "1", nonce,
  }));
  const spendBlock = chain.buildBlock({ transactions: spends, timestamp });
  chain.appendBlock(finalizeBlock(spendBlock, quorumFor(spendBlock, validators)));
  assert.equal(chain.creditDelegation(owner.address, delegate.address).spent, 2);

  const invalidReduction = createCreditDelegation({
    wallet: owner, delegate: delegate.address, networkId: chain.networkId,
    limit: 1, nonce: 2,
  });
  const rootBefore = chain.stateRoot;
  const nonceBefore = chain.nextNonce(owner.address);
  const rejected = chain.buildBlock({ transactions: [invalidReduction], timestamp });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(rejected, quorumFor(rejected, validators))),
    /below already spent credits/,
  );
  assert.equal(chain.stateRoot, rootBefore);
  assert.equal(chain.nextNonce(owner.address), nonceBefore);
  assert.deepEqual(chain.creditDelegation(owner.address, delegate.address), {
    delegate: delegate.address,
    epoch: 0,
    limit: 3,
    owner: owner.address,
    spent: 2,
  });

  const snapshot = chain.consensusSnapshot();
  const restored = NirChain.fromVerifiedSnapshot(genesisConfig, {
    capabilityMemory: snapshot.capabilityMemory,
    checkpoint: chain.blocks().at(-1),
    height: chain.height,
    networkId: chain.networkId,
    ...(chain.protocolVersion >= 25 ? { recoveryStateCommitment: chain.recoveryStateCommitment } : {}),
    state: snapshot.state,
    stateRoot: chain.stateRoot,
    tipHash: chain.tipHash,
  });
  assert.equal(restored.stateRoot, chain.stateRoot);
  assert.deepEqual(
    restored.creditDelegation(owner.address, delegate.address),
    chain.creditDelegation(owner.address, delegate.address),
  );
});

test("one thousand credit transfers conserve NIR across fork restart and replay", () => {
  const { chain, genesisConfig, treasury, validators } = fixture();
  const owner = generateWallet();
  const recipient = generateWallet();
  const timestamp = TREASURY_VESTING_MS;
  const stakeAmount = 100n * TRANSFER_CREDIT_STAKE_UNIT;
  const transferCount = 1_000;
  const fundingAmount = stakeAmount + 2n * MIN_TRANSFER_FEE + BigInt(transferCount + 1);
  const fundingTransaction = createTransfer({
    wallet: treasury, networkId: chain.networkId, recipient: owner.address,
    amount: fundingAmount.toString(), nonce: 0,
  });
  const funding = chain.buildBlock({ transactions: [fundingTransaction], timestamp });
  chain.appendBlock(finalizeBlock(funding, quorumFor(funding, validators)));
  const stake = createCreditStake({
    wallet: owner, networkId: chain.networkId, amount: stakeAmount.toString(), nonce: 0,
  });
  const stakeBlock = chain.buildBlock({ transactions: [stake], timestamp });
  chain.appendBlock(finalizeBlock(stakeBlock, quorumFor(stakeBlock, validators)));
  assert.equal(chain.transferCredits(owner.address), 1_000n);

  let replicas = [chain];
  for (let batch = 0; batch < transferCount / MAX_CREDIT_TRANSFERS_PER_BLOCK; batch += 1) {
    const firstNonce = 1 + batch * MAX_CREDIT_TRANSFERS_PER_BLOCK;
    const transactions = Array.from(
      { length: MAX_CREDIT_TRANSFERS_PER_BLOCK },
      (_, index) => createCreditTransfer({
        wallet: owner, networkId: chain.networkId, recipient: recipient.address,
        amount: "1", nonce: firstNonce + index,
      }),
    );
    const proposal = chain.buildBlock({ transactions, timestamp });
    const finalized = finalizeBlock(proposal, quorumFor(proposal, validators));
    for (const replica of replicas) replica.appendBlock(finalized);

    if (batch === 4) {
      const snapshot = chain.consensusSnapshot();
      const restored = NirChain.fromVerifiedSnapshot(genesisConfig, {
        capabilityMemory: snapshot.capabilityMemory,
        checkpoint: chain.blocks().at(-1),
        height: chain.height,
        networkId: chain.networkId,
        ...(chain.protocolVersion >= 25 ? { recoveryStateCommitment: chain.recoveryStateCommitment } : {}),
        state: snapshot.state,
        stateRoot: chain.stateRoot,
        tipHash: chain.tipHash,
      });
      const replayed = new NirChain(genesisConfig);
      for (const block of chain.blocks().slice(1)) replayed.appendBlock(block);
      replicas = [chain, chain.fork(), restored, replayed];
      assert.ok(replicas.every((replica) => replica.stateRoot === chain.stateRoot));
    }
  }

  for (const replica of replicas) {
    assert.equal(replica.balance(recipient.address), 1_000n);
    assert.equal(replica.transferCredits(owner.address), 0n);
    assert.equal(replica.creditStake(owner.address), stakeAmount);
    assert.equal(replica.stateRoot, chain.stateRoot);
  }

  const exhausted = createCreditTransfer({
    wallet: owner, networkId: chain.networkId, recipient: recipient.address,
    amount: "1", nonce: transferCount + 1,
  });
  const rootBefore = chain.stateRoot;
  const rejected = chain.buildBlock({ transactions: [exhausted], timestamp });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(rejected, quorumFor(rejected, validators))),
    /quota is exhausted/,
  );
  assert.equal(chain.stateRoot, rootBefore);
  assert.equal(chain.nextNonce(owner.address), transferCount + 1);

  const underpricedFallback = createTransfer({
    wallet: owner, networkId: chain.networkId, recipient: recipient.address,
    amount: "1", fee: "0", nonce: transferCount + 1,
  });
  const underpricedBlock = chain.buildBlock({ transactions: [underpricedFallback], timestamp });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(underpricedBlock, quorumFor(underpricedBlock, validators))),
    /fee is below the protocol minimum/,
  );
  assert.equal(chain.stateRoot, rootBefore);
  assert.equal(chain.nextNonce(owner.address), transferCount + 1);

  const feeFallback = createTransfer({
    wallet: owner, networkId: chain.networkId, recipient: recipient.address,
    amount: "1", fee: MIN_TRANSFER_FEE.toString(), nonce: transferCount + 1,
  });
  const fallbackBlock = chain.buildBlock({ transactions: [feeFallback], timestamp });
  chain.appendBlock(finalizeBlock(fallbackBlock, quorumFor(fallbackBlock, validators)));
  assert.equal(chain.balance(recipient.address), 1_001n);
  const state = chain.consensusSnapshot().state;
  const liquid = state.balances.reduce((sum, [, amount]) => sum + BigInt(amount), 0n);
  const locked = state.creditStakes.reduce((sum, [, amount]) => sum + BigInt(amount), 0n);
  const pending = state.creditUnstakes.reduce(
    (sum, [, unstake]) => sum + BigInt(unstake.amount), 0n,
  );
  const evaluatorBonds = state.evaluatorBonds.reduce(
    (sum, [, amount]) => sum + BigInt(amount), 0n,
  );
  assert.equal(liquid + locked + pending + evaluatorBonds + chain.burned, chain.issued);
  assert.equal(chain.issued, TREASURY_ALLOCATION);
});

test("account proof and snapshot credit views reset after, not at, the epoch boundary", () => {
  const { chain, genesisConfig, treasury, validators } = fixture();
  const owner = generateWallet();
  const recipient = generateWallet();
  const timestamp = TREASURY_VESTING_MS;
  const funding = chain.buildBlock({
    transactions: [createTransfer({
      wallet: treasury, networkId: chain.networkId, recipient: owner.address,
      amount: (TRANSFER_CREDIT_STAKE_UNIT + MIN_TRANSFER_FEE + 1n).toString(), nonce: 0,
    })],
    timestamp,
  });
  chain.appendBlock(finalizeBlock(funding, quorumFor(funding, validators)));
  const stake = chain.buildBlock({
    transactions: [createCreditStake({
      wallet: owner, networkId: chain.networkId,
      amount: TRANSFER_CREDIT_STAKE_UNIT.toString(), nonce: 0,
    })],
    timestamp,
  });
  chain.appendBlock(finalizeBlock(stake, quorumFor(stake, validators)));
  const spend = chain.buildBlock({
    transactions: [createCreditTransfer({
      wallet: owner, networkId: chain.networkId, recipient: recipient.address,
      amount: "1", nonce: 1,
    })],
    timestamp,
  });
  chain.appendBlock(finalizeBlock(spend, quorumFor(spend, validators)));
  const exported = chain.consensusSnapshot();

  for (const [height, expected] of [[719, "9"], [720, "9"], [721, "10"]]) {
    const snapshot = structuredClone({
      capabilityMemory: exported.capabilityMemory,
      checkpoint: chain.blocks().at(-1),
      height,
      networkId: chain.networkId,
      ...(chain.protocolVersion >= 25 ? { recoveryStateCommitment: chain.recoveryStateCommitment } : {}),
      state: exported.state,
      stateRoot: chain.stateRoot,
      tipHash: chain.tipHash,
    });
    snapshot.checkpoint.height = height;
    snapshot.checkpoint.hash = blockHash(snapshot.checkpoint);
    snapshot.tipHash = snapshot.checkpoint.hash;
    const view = NirChain.fromVerifiedSnapshot(genesisConfig, snapshot);
    snapshot.checkpoint.accountStateRoot = view.accountStateRoot;
    snapshot.checkpoint.hash = blockHash(snapshot.checkpoint);
    snapshot.tipHash = snapshot.checkpoint.hash;
    const restored = NirChain.fromVerifiedSnapshot(genesisConfig, snapshot);
    const proof = restored.accountStateProof(owner.address);

    assert.equal(restored.height, height);
    assert.equal(restored.accountState(owner.address).resources.availableTransferCredits, expected);
    assert.equal(proof.account.resources.availableTransferCredits, expected);
    assert.equal(proof.accountStateRoot, restored.accountStateRoot);
    assert.deepEqual(
      verifyAccountStateProof(proof.account, proof.inclusionProof, proof.accountStateRoot),
      proof.account,
    );
    assert.deepEqual(restored.consensusSnapshot().state.creditUsage, exported.state.creditUsage);
  }
});

test("a transfer cannot spend more than the sender owns", () => {
  const { chain, validators } = fixture();
  const alice = generateWallet();
  const bob = generateWallet();
  const transaction = createTransfer({
    wallet: alice,
    networkId: chain.networkId,
    recipient: bob.address,
    amount: "1",
    nonce: 0,
  });
  const block = chain.buildBlock({ transactions: [transaction], timestamp: 1 });
  const finalized = finalizeBlock(block, quorumFor(block, validators));
  assert.throws(() => chain.appendBlock(finalized), /insufficient balance/);
  assert.equal(chain.height, 0);
});

test("one progress proof cannot mint twice", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const claim = {
    ...progressClaim(chain, evaluators, validators, miner),
  };
  const first = chain.buildBlock({ rewardClaims: [claim], timestamp: currentTimestamp(chain) });
  chain.appendBlock(finalizeBlock(first, quorumFor(first, validators)));
  assert.throws(
    () => progressClaim(chain, evaluators, validators, miner),
    /duplicated|already known/,
  );
});

test("a new key and artifact wrapper cannot reward the same canonical content after fork or restart", () => {
  const { chain, evaluators, genesisConfig, treasury, validators } = fixture();
  const firstMiner = generateWallet();
  const canonicalContentLabel = "shared-canonical-model-weights";
  const claim = progressClaim(
    chain, evaluators, validators, firstMiner, "original-package", firstMiner.address,
    canonicalContentLabel,
  );
  const reward = chain.buildBlock({ rewardClaims: [claim], timestamp: currentTimestamp(chain) });
  chain.appendBlock(finalizeBlock(reward, quorumFor(reward, validators)));

  const exported = chain.consensusSnapshot();
  const checkpoint = chain.blocks().at(-1);
  const restored = NirChain.fromVerifiedSnapshot(genesisConfig, {
    capabilityMemory: exported.capabilityMemory,
    checkpoint,
    height: chain.height,
    networkId: chain.networkId,
    ...(chain.protocolVersion >= 25 ? { recoveryStateCommitment: chain.recoveryStateCommitment } : {}),
    state: exported.state,
    stateRoot: chain.stateRoot,
    tipHash: chain.tipHash,
  });
  const replayed = new NirChain(genesisConfig);
  for (const block of chain.blocks().slice(1)) replayed.appendBlock(block);

  for (const [mode, target] of [
    ["fork", chain.fork()], ["snapshot restart", restored], ["journal replay", replayed],
  ]) {
    TEST_TREASURY_WALLETS.set(target, treasury);
    const attacker = generateWallet();
    const repackaged = createProgressCommitment({
      wallet: attacker,
      networkId: target.networkId,
      recipient: attacker.address,
      artifactHash: `sha256:${fingerprint(`wrapper-${mode}`)}`,
      baselineHash: `sha256:${fingerprint("baseline")}`,
      baselineContentHash: `sha256:${fingerprint("baseline-content")}`,
      contentHash: `sha256:${fingerprint(canonicalContentLabel)}`,
      suiteCommitment: fingerprint(`new-metadata-${mode}`),
      nonce: target.nextNonce(attacker.address),
    });
    const timestamp = target.blocks().at(-1).timestamp;
    lockProgressBond(target, validators, attacker.address, repackaged.candidateId, timestamp);
    const proposal = target.buildBlock({ transactions: [repackaged], timestamp });
    assert.throws(
      () => target.appendBlock(finalizeBlock(proposal, quorumFor(proposal, validators))),
      /progress commitment is duplicated/,
      mode,
    );
  }
});

test("an arbitrary intelligence score cannot mint NIR", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const claim = progressClaim(chain, evaluators, validators, miner);
  claim.score = String(BigInt(claim.score) * 1_000_000n);
  assert.throws(
    () => chain.buildBlock({ rewardClaims: [claim], timestamp: 1 }),
    /does not match/,
  );
});

test("chain scoring matches the evaluator output", () => {
  assert.equal(
    computeProgressScore({
      artifactHash: `sha256:${fingerprint("candidate")}`,
      baselineHash: `sha256:${fingerprint("baseline")}`,
      baselineContentHash: `sha256:${fingerprint("baseline-content")}`,
      contentHash: `sha256:${fingerprint("candidate-content")}`,
      candidateId: fingerprint("candidate-admission"),
      executionBundleHash: fingerprint("candidate-bundle"),
      suiteCommitment: fingerprint("suite"),
      gainPpm: 375_000,
      generalityBps: 7_500,
      reproducibilityBps: 10_000,
      safetyBps: 10_000,
      safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT,
      criticalSafetyPass: true,
      noveltyBps: 10_000,
      candidateEnergyWh: 710,
      baselineEnergyWh: 1_000,
      energyAttested: true,
    }),
    "396112",
  );
});

test("progress cannot mint without a committed execution bundle", () => {
  assert.throws(
    () => computeProgressScore({
      artifactHash: `sha256:${fingerprint("candidate")}`,
      baselineHash: `sha256:${fingerprint("baseline")}`,
      suiteCommitment: fingerprint("suite"),
      gainPpm: 375_000,
      generalityBps: 7_500,
      reproducibilityBps: 10_000,
      safetyBps: 10_000,
      safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT,
      criticalSafetyPass: true,
      noveltyBps: 10_000,
      candidateEnergyWh: 710,
      baselineEnergyWh: 1_000,
      energyAttested: true,
    }),
    /evaluation commitments/,
  );
});

test("critical safety failure cannot produce an intelligence score", () => {
  assert.throws(
    () => computeProgressScore({
      artifactHash: `sha256:${fingerprint("unsafe-candidate")}`,
      baselineHash: `sha256:${fingerprint("baseline")}`,
      baselineContentHash: `sha256:${fingerprint("baseline-content")}`,
      contentHash: `sha256:${fingerprint("unsafe-candidate-content")}`,
      candidateId: fingerprint("unsafe-candidate-admission"),
      executionBundleHash: fingerprint("unsafe-candidate-bundle"),
      suiteCommitment: fingerprint("suite"),
      gainPpm: 900_000,
      generalityBps: 10_000,
      reproducibilityBps: 10_000,
      safetyBps: 9_999,
      safetyPolicyHash: SAFETY_POLICY_V1_COMMITMENT,
      criticalSafetyPass: false,
      noveltyBps: 10_000,
      candidateEnergyWh: 100,
      baselineEnergyWh: 100,
      energyAttested: true,
    }),
    /critical safety clearance/,
  );
});

test("an unapproved safety policy cannot authorize mining", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const claim = progressClaim(chain, evaluators, validators, miner);
  claim.evaluation.safetyPolicyHash = fingerprint("easy-private-policy");
  assert.throws(
    () => chain.buildBlock({ rewardClaims: [claim], timestamp: 1 }),
    /unapproved safety policy/,
  );
});

test("progress needs independently signed evaluator receipts", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const claim = progressClaim(chain, evaluators, validators, miner);
  claim.attestations = [claim.attestations[0]];
  assert.throws(
    () => chain.buildBlock({ rewardClaims: [claim], timestamp: 1 }),
    /quorum/,
  );
});

test("progress must match an earlier finalized on-chain admission", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const valid = progressClaim(chain, evaluators, validators, miner);
  const forgedEvaluation = {
    ...valid.evaluation,
    candidateId: fingerprint("candidate-that-was-never-committed"),
  };
  const forged = createProgressClaim({
    networkId: chain.networkId,
    epoch: valid.epoch,
    recipient: miner.address,
    evaluation: forgedEvaluation,
    evaluatorWallets: evaluators.slice(0, 3),
  });
  assert.throws(
    () => chain.buildBlock({ rewardClaims: [forged], timestamp: 1 }),
    /not committed on chain/,
  );
});

test("a committed candidate cannot substitute its artifact after challenge", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const valid = progressClaim(chain, evaluators, validators, miner);
  const assigned = valid.attestations.map(({ evaluator }) =>
    evaluators.find((wallet) => wallet.address === evaluator));
  const forged = createProgressClaim({
    networkId: chain.networkId,
    epoch: valid.epoch,
    recipient: miner.address,
    evaluation: {
      ...valid.evaluation,
      artifactHash: `sha256:${fingerprint("substituted-after-challenge")}`,
    },
    evaluatorWallets: assigned,
  });
  assert.throws(
    () => chain.buildBlock({ rewardClaims: [forged], timestamp: 1 }),
    /does not match its finalized admission/,
  );
});

test("baseline artifact identity and canonical baseline content are independently bound", () => {
  const { chain, evaluators, validators } = fixture();
  const attacker = generateWallet();
  const mismatchedAdmission = createProgressCommitment({
    wallet: attacker,
    networkId: chain.networkId,
    recipient: attacker.address,
    artifactHash: `sha256:${fingerprint("weak-candidate")}`,
    baselineHash: `sha256:${fingerprint("baseline")}`,
    baselineContentHash: `sha256:${fingerprint("attacker-selected-weak-baseline")}`,
    contentHash: `sha256:${fingerprint("weak-candidate-content")}`,
    suiteCommitment: fingerprint("weak-suite"),
    nonce: 0,
  });
  lockProgressBond(
    chain, validators, attacker.address, mismatchedAdmission.candidateId, TREASURY_VESTING_MS,
  );
  const proposal = chain.buildBlock({
    transactions: [mismatchedAdmission], timestamp: TREASURY_VESTING_MS,
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(proposal, quorumFor(proposal, validators))),
    /does not match the known baseline artifact/,
  );

  const miner = generateWallet();
  const valid = progressClaim(chain, evaluators, validators, miner);
  const changedContent = {
    ...valid.evaluation,
    baselineContentHash: `sha256:${fingerprint("substituted-baseline-content")}`,
  };
  assert.notEqual(
    progressCandidateId({
      ...changedContent,
      networkId: chain.networkId,
      sender: miner.address,
      recipient: miner.address,
    }),
    valid.evaluation.candidateId,
  );
  const assigned = valid.attestations.map(({ evaluator }) =>
    evaluators.find((wallet) => wallet.address === evaluator));
  const forged = createProgressClaim({
    networkId: chain.networkId,
    epoch: valid.epoch,
    recipient: miner.address,
    evaluation: changedContent,
    evaluatorWallets: assigned,
  });
  assert.throws(
    () => chain.buildBlock({ rewardClaims: [forged], timestamp: 1 }),
    /does not match its finalized admission/,
  );
});

test("a candidate cannot choose a different lineage after its challenge", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const claim = progressClaim(chain, evaluators, validators, miner);
  claim.evaluation.parents = [`sha256:${fingerprint("post-challenge-parent")}`];
  assert.throws(
    () => chain.buildBlock({ rewardClaims: [claim], timestamp: 1 }),
    /does not match its finalized admission/,
  );
});

test("only the post-commit randomly assigned committee can approve progress", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const valid = progressClaim(chain, evaluators, validators, miner);
  const assignedAddresses = new Set(
    valid.attestations.map(({ evaluator }) => evaluator),
  );
  const assigned = evaluators.filter(({ address }) => assignedAddresses.has(address));
  const unassigned = evaluators.find(({ address }) => !assignedAddresses.has(address));
  const wrongCommittee = [assigned[0], assigned[1], unassigned];
  const forged = createProgressClaim({
    networkId: chain.networkId,
    epoch: valid.epoch,
    recipient: miner.address,
    evaluation: valid.evaluation,
    evaluatorWallets: wrongCommittee,
  });
  assert.throws(
    () => chain.buildBlock({ rewardClaims: [forged], timestamp: 1 }),
    /assigned committee/,
  );
});

test("consensus validator keys cannot approve intelligence evaluations", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const valid = progressClaim(chain, evaluators, validators, miner);
  const wrongRole = createProgressClaim({
    networkId: chain.networkId,
    epoch: valid.epoch,
    recipient: miner.address,
    evaluation: valid.evaluation,
    evaluatorWallets: validators.slice(0, 3),
  });
  assert.throws(
    () => chain.buildBlock({ rewardClaims: [wrongRole], timestamp: 1 }),
    /invalid progress evaluator signature/,
  );
});

test("treasury allocation cannot be spent before it vests", () => {
  const { chain, treasury, validators } = fixture();
  const recipient = generateWallet();
  const transaction = createTransfer({
    wallet: treasury,
    networkId: chain.networkId,
    recipient: recipient.address,
    amount: "100000000",
    nonce: 0,
  });
  const block = chain.buildBlock({ transactions: [transaction], timestamp: 1 });
  const finalized = finalizeBlock(block, quorumFor(block, validators));
  assert.throws(() => chain.appendBlock(finalized), /still vesting/);
});

test("treasury allocation becomes spendable only after elapsed vesting time", () => {
  const { chain, treasury, validators } = fixture();
  const recipient = generateWallet();
  const transaction = createTransfer({
    wallet: treasury,
    networkId: chain.networkId,
    recipient: recipient.address,
    amount: "100000000",
    nonce: 0,
  });
  const block = chain.buildBlock({
    transactions: [transaction],
    timestamp: TREASURY_VESTING_MS,
  });
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  assert.equal(chain.balance(recipient.address), 100_000_000n);
});

test("treasury vesting unlocks only the elapsed linear share", () => {
  const first = fixture();
  const recipient = generateWallet();
  const midpoint = Math.floor(TREASURY_VESTING_MS / 2);
  const tooMuch = createTransfer({
    wallet: first.treasury,
    networkId: first.chain.networkId,
    recipient: recipient.address,
    amount: (TREASURY_ALLOCATION / 2n + 1n).toString(),
    nonce: 0,
  });
  const rejected = first.chain.buildBlock({
    transactions: [tooMuch],
    timestamp: midpoint,
  });
  assert.throws(
    () => first.chain.appendBlock(
      finalizeBlock(rejected, quorumFor(rejected, first.validators)),
    ),
    /still vesting/,
  );

  const second = fixture();
  const exactShare = createTransfer({
    wallet: second.treasury,
    networkId: second.chain.networkId,
    recipient: recipient.address,
    amount: (TREASURY_ALLOCATION / 2n - MIN_TRANSFER_FEE).toString(),
    nonce: 0,
  });
  const accepted = second.chain.buildBlock({
    transactions: [exactShare],
    timestamp: midpoint,
  });
  second.chain.appendBlock(
    finalizeBlock(accepted, quorumFor(accepted, second.validators)),
  );
  assert.equal(
    second.chain.balance(recipient.address),
    TREASURY_ALLOCATION / 2n - MIN_TRANSFER_FEE,
  );
});

test("blocks too far in the future are rejected", () => {
  const { chain, validators } = fixture();
  const block = chain.buildBlock({
    timestamp: Date.now() + MAX_FUTURE_DRIFT_MS + 10_000,
  });
  const finalized = finalizeBlock(block, quorumFor(block, validators));
  assert.throws(() => chain.appendBlock(finalized), /future/);
});

test("oversized transaction batches are rejected before execution", () => {
  const { chain, validators } = fixture();
  const block = chain.buildBlock({
    transactions: Array(MAX_TRANSACTIONS_PER_BLOCK + 1).fill({}),
    timestamp: 1,
  });
  const finalized = finalizeBlock(block, quorumFor(block, validators));
  assert.throws(() => chain.appendBlock(finalized), /too many transactions/);
});

test("tampering with a finalized block invalidates its quorum certificate", () => {
  const { chain, validators } = fixture();
  const block = chain.buildBlock({ timestamp: 1 });
  const finalized = finalizeBlock(block, quorumFor(block, validators));
  finalized.timestamp = 2;
  assert.throws(() => chain.appendBlock(finalized), /block hash mismatch|intrinsic context/);
});

test("a block cannot claim a false world capability memory root", () => {
  const { chain, validators } = fixture();
  const block = chain.buildBlock({ timestamp: 1 });
  block.capabilityMemoryRoot = fingerprint("false-world-memory");
  const finalized = finalizeBlock(block, quorumFor(block, validators));
  assert.throws(() => chain.appendBlock(finalized), /capability memory root/);
});

test("a finalized block cannot claim a false complete state root", () => {
  const { chain, validators } = fixture();
  const before = chain.stateRoot;
  const block = chain.buildBlock({ timestamp: 1 });
  assert.match(block.stateRoot, /^[0-9a-f]{64}$/);
  block.stateRoot = fingerprint("false-complete-state");
  const finalized = finalizeBlock(block, quorumFor(block, validators));
  assert.throws(() => chain.appendBlock(finalized), /state root/);
  assert.equal(chain.stateRoot, before);
  assert.equal(chain.height, 0);
});

test("the same validator vote cannot be counted twice", () => {
  const { chain, validators } = fixture();
  const block = chain.buildBlock({ timestamp: 1 });
  const finalized = finalizeBlock(block, quorumFor(block, validators));
  finalized.certificate[2] = finalized.certificate[1];
  assert.throws(() => chain.appendBlock(finalized), /duplicate validator vote/);
});

test("the hard cap truncates the final mining reward", () => {
  const miner = generateWallet();
  const rewards = allocateProgressRewards(
    0,
    [
      { fingerprint: fingerprint("last-proof"), recipient: miner.address, score: "1" },
    ],
    7n,
  );
  assert.equal(BigInt(rewards[0].amount), 7n);
  assert.equal(TREASURY_ALLOCATION + MINING_POOL, MAX_SUPPLY);
});

test("a coalition cannot replace one epoch budget with the remaining mining pool", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const proposal = chain.buildBlock({
    rewardClaims: [progressClaim(chain, evaluators, validators, miner, "giant-block")],
    timestamp: currentTimestamp(chain),
  });
  const rootBefore = chain.stateRoot;
  const issuedBefore = chain.issued;
  proposal.progressRewards[0].amount = MINING_POOL.toString();

  assert.throws(
    () => chain.appendBlock(finalizeBlock(proposal, quorumFor(proposal, validators))),
    /invalid progress reward allocation/,
  );
  assert.equal(chain.stateRoot, rootBefore);
  assert.equal(chain.issued, issuedBefore);
  assert.equal(chain.balance(miner.address), 0n);
});

test("reward allocation is deterministic and conserves every atomic unit", () => {
  const recipients = Array.from({ length: 5 }, generateWallet);
  for (let round = 0; round < 100; round += 1) {
    const claims = recipients.map((wallet, index) => ({
      fingerprint: fingerprint(`proof-${round}-${index}`),
      recipient: wallet.address,
      score: String(((round + 1) * (index + 3) * 7919) % 1_000_003 + 1),
    }));
    const forward = allocateProgressRewards(round, claims);
    const reverse = allocateProgressRewards(round, [...claims].reverse());
    assert.deepEqual(forward, reverse);
    assert.equal(
      forward.reduce((total, reward) => total + BigInt(reward.amount), 0n),
      scheduledEpochBudget(round),
    );
  }
});

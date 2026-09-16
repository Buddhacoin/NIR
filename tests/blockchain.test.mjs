import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  NirChain,
  allocateProgressRewards,
  computeProgressScore,
  createCandidateBond,
  createProgressCommitment,
  createValidatorBond,
  createProgressClaim,
  createSponsoredTransfer,
  createTransfer,
  createMultisigTransfer,
  finalizeBlock,
  formatFeePercent,
  formatNir,
  multisigAddress,
  quoteTransferFee,
} from "../blockchain/chain.mjs";
import {
  MAX_FUTURE_DRIFT_MS,
  MIN_REWARD_INTERVAL_MS,
  MINING_POOL,
  MIN_TRANSFER_FEE,
  MAX_SUPPLY,
  MAX_TRANSACTIONS_PER_BLOCK,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_ALLOCATION,
  TREASURY_VESTING_MS,
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
  const chain = new NirChain({
    capabilityReferences: [
      {
        artifactHash: `sha256:${fingerprint("baseline")}`,
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
  });
  TEST_BEACON_WALLETS.set(chain, beaconAuthorities);
  return { beaconAuthorities, chain, evaluators, treasury, validators };
}

const TEST_BEACON_WALLETS = new WeakMap();

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

function progressClaim(
  chain,
  evaluators,
  validators,
  submitterWallet,
  label = "proof-a",
  recipient = submitterWallet.address,
) {
  const artifactHash = `sha256:${fingerprint(`artifact-${label}`)}`;
  const baselineHash = `sha256:${fingerprint("baseline")}`;
  const suiteCommitment = fingerprint("hidden-suite-v1");
  const timestamp = chain.blocks().at(-1).timestamp;
  const admission = createProgressCommitment({
    wallet: submitterWallet,
    networkId: chain.networkId,
    recipient,
    artifactHash,
    baselineHash,
    suiteCommitment,
    nonce: chain.nextNonce(submitterWallet.address),
  });
  const admissionBlock = chain.buildBlock({ transactions: [admission], timestamp });
  chain.appendBlock(finalizeBlock(admissionBlock, quorumFor(admissionBlock, validators)));
  const beaconAuthorities = TEST_BEACON_WALLETS.get(chain);
  const assignmentBlock = chain.buildBlock({ timestamp });
  chain.appendBlock(finalizeBlock(assignmentBlock, quorumFor(assignmentBlock, validators)));
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
  const capabilitiesBps = label === "second-frontier"
    ? { "code-v1": 8_600, "reasoning-v1": 8_400 }
    : { "code-v1": 8_400, "reasoning-v1": 8_200 };
  const evaluation = chain.prepareProgressEvaluation({
    artifactHash,
    baselineHash,
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

test("genesis supply contains only the locked treasury allocation", () => {
  const { chain, treasury } = fixture();
  assert.equal(chain.issued, TREASURY_ALLOCATION);
  assert.equal(chain.balance(treasury.address), TREASURY_ALLOCATION);
  assert.ok(chain.issued < MAX_SUPPLY);
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
    "74fe4a4f969946c880ad08924f88ee8bc7d3feef4e28ede7351e462a6e84ea19",
  );
});

test("a finalized progress block mints its fixed epoch budget", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const memoryRootBefore = chain.capabilityMemoryRoot;
  const block = chain.buildBlock({
    rewardClaims: [
      progressClaim(chain, evaluators, validators, miner),
    ],
    timestamp: 1,
  });
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  assert.equal(formatNir(chain.balance(miner.address)), "50.00000000 NIR");
  assert.notEqual(chain.capabilityMemoryRoot, memoryRootBefore);
  assert.equal(
    chain.capabilityMemoryRoot,
    block.progressRewards[0].evaluation.frontierRootAfter,
  );
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
    suiteCommitment: fingerprint("challenge-order-suite"),
    nonce: 0,
  });
  assert.throws(
    () => chain.progressChallenge(admission.candidateId),
    /unknown or expired/,
  );
  const rootBefore = chain.stateRoot;
  const commitBlock = chain.buildBlock({ transactions: [admission], timestamp: 0 });
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
  const assignment = chain.buildBlock({ timestamp: 0 });
  chain.appendBlock(finalizeBlock(assignment, quorumFor(assignment, validators)));
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
    timestamp: 0,
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
    timestamp: 0,
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
    timestamp: 0,
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
    timestamp: 0,
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(forgedAggregate, quorumFor(forgedAggregate, validators))),
    /aggregate is invalid/,
  );
  const source = chain.buildBlock({
    progressBeacons: [validBeacon],
    timestamp: 0,
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
    timestamp: 2,
  });
  assert.equal(rewarded.issuanceEpoch, 0);
  chain.appendBlock(finalizeBlock(rewarded, quorumFor(rewarded, validators)));
  assert.equal(chain.nextIssuanceEpoch, 1);
  assert.equal(formatNir(chain.balance(miner.address)), "50.00000000 NIR");
});

test("fast hardware cannot accelerate intelligence issuance", () => {
  const { chain, evaluators, validators } = fixture();
  const firstMiner = generateWallet();
  const first = chain.buildBlock({
    rewardClaims: [progressClaim(chain, evaluators, validators, firstMiner)],
    timestamp: 1,
  });
  chain.appendBlock(finalizeBlock(first, quorumFor(first, validators)));

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
      timestamp: 1 + MIN_REWARD_INTERVAL_MS - 1,
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
    timestamp: 1,
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));

  const transaction = createTransfer({
    wallet: alice,
    networkId: chain.networkId,
    recipient: bob.address,
    amount: "125000000",
    nonce: chain.nextNonce(alice.address),
    fee: "1000",
  });
  const beforeTransferRoot = chain.stateRoot;
  const block = chain.buildBlock({ transactions: [transaction], timestamp: 2 });
  assert.notEqual(block.stateRoot, beforeTransferRoot);
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  assert.equal(chain.stateRoot, block.stateRoot);
  assert.equal(chain.balance(bob.address), 125_000_000n);
  assert.equal(chain.nextNonce(alice.address), 2);
});

test("a transfer below the consensus fee floor is rejected", () => {
  const { chain, evaluators, validators } = fixture();
  const alice = generateWallet();
  const bob = generateWallet();
  const rewardBlock = chain.buildBlock({
    rewardClaims: [progressClaim(chain, evaluators, validators, alice)],
    timestamp: 1,
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  const transaction = createTransfer({
    wallet: alice,
    networkId: chain.networkId,
    recipient: bob.address,
    amount: "1",
    nonce: chain.nextNonce(alice.address),
    fee: (MIN_TRANSFER_FEE - 1n).toString(),
  });
  const block = chain.buildBlock({ transactions: [transaction], timestamp: 2 });
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
    timestamp: 1,
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));

  const insufficient = createMultisigTransfer({
    signerWallets: members.slice(0, 1), memberPublicKeys, threshold: 2,
    networkId: chain.networkId, recipient: recipient.address, amount: "100000000", nonce: 0,
  });
  const rejected = chain.buildBlock({ transactions: [insufficient], timestamp: 2 });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(rejected, quorumFor(rejected, validators))),
    /threshold not reached/,
  );

  const authorized = createMultisigTransfer({
    signerWallets: [members[0], members[2]], memberPublicKeys, threshold: 2,
    networkId: chain.networkId, recipient: recipient.address, amount: "100000000", nonce: 0,
  });
  const accepted = chain.buildBlock({ transactions: [authorized], timestamp: 2 });
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
    timestamp: 1,
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  const bondTimestamp = activateRandomnessValidators(chain, validators, submitter, 2);

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
    timestamp: 1,
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  const bondTimestamp = activateRandomnessValidators(chain, validators, submitter, 2);
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
    timestamp: 1,
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  const bondTimestamp = activateRandomnessValidators(chain, validators, submitter, 2);
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
    timestamp: 1,
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  const transaction = createTransfer({
    wallet: alice,
    networkId: chain.networkId,
    recipient: bob.address,
    amount: "1",
    nonce: 0,
  });
  transaction.amount = "2";
  const heightBefore = chain.height;
  const block = chain.buildBlock({ transactions: [transaction], timestamp: 2 });
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
    timestamp: 1,
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  const funding = createTransfer({
    wallet: sponsor, networkId: chain.networkId, recipient: alice.address,
    amount: "100", nonce: chain.nextNonce(sponsor.address),
  });
  const fundingBlock = chain.buildBlock({ transactions: [funding], timestamp: 2 });
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
    timestamp: 3,
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(forged, quorumFor(forged, validators))),
    /fee payer signature/,
  );
  const block = chain.buildBlock({ transactions: [transfer], timestamp: 3 });
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  assert.equal(chain.balance(alice.address), 0n);
  assert.equal(chain.balance(bob.address), 100n);
  assert.equal(chain.balance(sponsor.address), sponsorBefore - MIN_TRANSFER_FEE);
  assert.equal(chain.nextNonce(alice.address), 1);
  assert.equal(chain.nextNonce(sponsor.address), sponsorNonce + 1);
  const replay = chain.buildBlock({ transactions: [transfer], timestamp: 4 });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(replay, quorumFor(replay, validators))),
    /nonce/,
  );
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
  const first = chain.buildBlock({ rewardClaims: [claim], timestamp: 1 });
  chain.appendBlock(finalizeBlock(first, quorumFor(first, validators)));
  assert.throws(
    () => progressClaim(chain, evaluators, validators, miner),
    /already known/,
  );
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
  assert.throws(() => chain.appendBlock(finalized), /block hash mismatch/);
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

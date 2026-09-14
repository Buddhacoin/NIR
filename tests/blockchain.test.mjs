import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  NirChain,
  allocateProgressRewards,
  computeProgressScore,
  createProgressClaim,
  createTransfer,
  createMultisigTransfer,
  finalizeBlock,
  formatNir,
  multisigAddress,
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

function operatorMembers(wallets, prefix) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet),
    operatorId: `${prefix}-${index}`,
  }));
}

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const chain = new NirChain({
    capabilityReferences: [
      {
        artifactHash: `sha256:${fingerprint("baseline")}`,
        behaviorCommitment: fingerprint("baseline-behavior"),
        capabilitiesBps: { "code-v1": 7_000, "reasoning-v1": 8_000 },
      },
    ],
    genesisTimestamp: 0,
    networkId: "nir-testnet",
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    validators: operatorMembers(validators, "validator"),
    evaluators: operatorMembers(evaluators, "evaluator"),
    treasuryAddress: treasury.address,
  });
  return { chain, evaluators, treasury, validators };
}

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

function progressClaim(chain, evaluators, recipient, label = "proof-a") {
  const evaluation = chain.prepareProgressEvaluation({
    artifactHash: `sha256:${fingerprint(`artifact-${label}`)}`,
    baselineHash: `sha256:${fingerprint("baseline")}`,
    suiteCommitment: fingerprint("hidden-suite-v1"),
    parents: [`sha256:${fingerprint("baseline")}`],
    committedEpoch: chain.height,
    challengeEpoch: chain.height + 1,
    challengeSeed: fingerprint(`challenge-${chain.height + 1}`),
    behaviorCommitment: fingerprint(`behavior-${label}`),
    capabilitiesBps: { "code-v1": 8_400, "reasoning-v1": 8_200 },
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
    evaluatorWallets: evaluators.slice(0, 3),
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
      progressClaim(chain, evaluators, miner.address),
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

test("known capability cannot mint against a weaker selected baseline", () => {
  const { chain } = fixture();
  assert.throws(
    () => chain.prepareProgressEvaluation({
      artifactHash: `sha256:${fingerprint("repackaged-known-model")}`,
      baselineHash: `sha256:${fingerprint("baseline")}`,
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
    rewardClaims: [progressClaim(chain, evaluators, miner.address)],
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
    rewardClaims: [progressClaim(chain, evaluators, firstMiner.address)],
    timestamp: 1,
  });
  chain.appendBlock(finalizeBlock(first, quorumFor(first, validators)));

  const secondMiner = generateWallet();
  const evaluation = chain.prepareProgressEvaluation({
    artifactHash: `sha256:${fingerprint("second-frontier-model")}`,
    baselineHash: `sha256:${fingerprint("baseline")}`,
    suiteCommitment: fingerprint("hidden-suite-v1"),
    parents: [`sha256:${fingerprint("baseline")}`],
    committedEpoch: 1,
    challengeEpoch: 2,
    challengeSeed: fingerprint("challenge-2"),
    behaviorCommitment: fingerprint("second-frontier-behavior"),
    capabilitiesBps: { "code-v1": 8_600, "reasoning-v1": 8_400 },
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
  const secondClaim = createProgressClaim({
    networkId: chain.networkId,
    epoch: 2,
    recipient: secondMiner.address,
    evaluation,
    evaluatorWallets: evaluators.slice(0, 3),
  });
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

test("a post-quantum signed transfer changes balances and nonce", () => {
  const { chain, evaluators, validators } = fixture();
  const alice = generateWallet();
  const bob = generateWallet();
  const rewardBlock = chain.buildBlock({
    rewardClaims: [
      progressClaim(chain, evaluators, alice.address),
    ],
    timestamp: 1,
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));

  const transaction = createTransfer({
    wallet: alice,
    networkId: chain.networkId,
    recipient: bob.address,
    amount: "125000000",
    nonce: 0,
    fee: "1000",
  });
  const block = chain.buildBlock({ transactions: [transaction], timestamp: 2 });
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  assert.equal(chain.balance(bob.address), 125_000_000n);
  assert.equal(chain.nextNonce(alice.address), 1);
});

test("a transfer below the consensus fee floor is rejected", () => {
  const { chain, evaluators, validators } = fixture();
  const alice = generateWallet();
  const bob = generateWallet();
  const rewardBlock = chain.buildBlock({
    rewardClaims: [progressClaim(chain, evaluators, alice.address)],
    timestamp: 1,
  });
  chain.appendBlock(finalizeBlock(rewardBlock, quorumFor(rewardBlock, validators)));
  const transaction = createTransfer({
    wallet: alice,
    networkId: chain.networkId,
    recipient: bob.address,
    amount: "1",
    nonce: 0,
    fee: (MIN_TRANSFER_FEE - 1n).toString(),
  });
  const block = chain.buildBlock({ transactions: [transaction], timestamp: 2 });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(block, quorumFor(block, validators))),
    /below the protocol minimum/,
  );
  assert.equal(chain.balance(bob.address), 0n);
});

test("a two-of-three post-quantum vault can spend only with its threshold", () => {
  const { chain, evaluators, validators } = fixture();
  const members = Array.from({ length: 3 }, generateWallet);
  const memberPublicKeys = members.map(({ publicKey }) => publicKey);
  const vaultAddress = multisigAddress(memberPublicKeys, 2);
  const recipient = generateWallet();
  const rewardBlock = chain.buildBlock({
    rewardClaims: [progressClaim(chain, evaluators, vaultAddress)],
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

test("a modified transfer signature is rejected atomically", () => {
  const { chain, evaluators, validators } = fixture();
  const alice = generateWallet();
  const bob = generateWallet();
  const rewardBlock = chain.buildBlock({
    rewardClaims: [
      progressClaim(chain, evaluators, alice.address),
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
  const block = chain.buildBlock({ transactions: [transaction], timestamp: 2 });
  const finalized = finalizeBlock(block, quorumFor(block, validators));
  assert.throws(() => chain.appendBlock(finalized), /signature/);
  assert.equal(chain.height, 1);
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
    ...progressClaim(chain, evaluators, miner.address),
  };
  const first = chain.buildBlock({ rewardClaims: [claim], timestamp: 1 });
  chain.appendBlock(finalizeBlock(first, quorumFor(first, validators)));
  assert.throws(
    () => progressClaim(chain, evaluators, miner.address),
    /already known/,
  );
});

test("an arbitrary intelligence score cannot mint NIR", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const claim = progressClaim(chain, evaluators, miner.address);
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

test("critical safety failure cannot produce an intelligence score", () => {
  assert.throws(
    () => computeProgressScore({
      artifactHash: `sha256:${fingerprint("unsafe-candidate")}`,
      baselineHash: `sha256:${fingerprint("baseline")}`,
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
  const { chain, evaluators } = fixture();
  const miner = generateWallet();
  const claim = progressClaim(chain, evaluators, miner.address);
  claim.evaluation.safetyPolicyHash = fingerprint("easy-private-policy");
  assert.throws(
    () => chain.buildBlock({ rewardClaims: [claim], timestamp: 1 }),
    /unapproved safety policy/,
  );
});

test("progress needs independently signed evaluator receipts", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const claim = progressClaim(chain, evaluators, miner.address);
  claim.attestations = [claim.attestations[0]];
  assert.throws(
    () => chain.buildBlock({ rewardClaims: [claim], timestamp: 1 }),
    /quorum/,
  );
});

test("consensus validator keys cannot approve intelligence evaluations", () => {
  const { chain, evaluators, validators } = fixture();
  const miner = generateWallet();
  const valid = progressClaim(chain, evaluators, miner.address);
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

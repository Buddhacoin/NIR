import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  NirChain,
  allocateProgressRewards,
  createTransfer,
  finalizeBlock,
  formatNir,
} from "../blockchain/chain.mjs";
import {
  MAX_FUTURE_DRIFT_MS,
  MINING_POOL,
  MAX_SUPPLY,
  MAX_TRANSACTIONS_PER_BLOCK,
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

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const chain = new NirChain({
    genesisTimestamp: 0,
    networkId: "nir-testnet",
    validators: validators.map(publicWallet),
    treasuryAddress: treasury.address,
  });
  return { chain, treasury, validators };
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

test("a finalized progress block mints its fixed epoch budget", () => {
  const { chain, validators } = fixture();
  const miner = generateWallet();
  const block = chain.buildBlock({
    rewardClaims: [
      { fingerprint: fingerprint("proof-a"), recipient: miner.address, score: "10" },
    ],
    timestamp: 1,
  });
  chain.appendBlock(finalizeBlock(block, quorumFor(block, validators)));
  assert.equal(formatNir(chain.balance(miner.address)), "50.00000000 NIR");
});

test("fewer than two-thirds plus one validator votes cannot finalize", () => {
  const { chain, validators } = fixture();
  const block = chain.buildBlock({ timestamp: 1 });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(block, validators.slice(0, 2))),
    /quorum/,
  );
});

test("a post-quantum signed transfer changes balances and nonce", () => {
  const { chain, validators } = fixture();
  const alice = generateWallet();
  const bob = generateWallet();
  const rewardBlock = chain.buildBlock({
    rewardClaims: [
      { fingerprint: fingerprint("proof-a"), recipient: alice.address, score: "10" },
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

test("a modified transfer signature is rejected atomically", () => {
  const { chain, validators } = fixture();
  const alice = generateWallet();
  const bob = generateWallet();
  const rewardBlock = chain.buildBlock({
    rewardClaims: [
      { fingerprint: fingerprint("proof-a"), recipient: alice.address, score: "10" },
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
  const { chain, validators } = fixture();
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
  const { chain, validators } = fixture();
  const miner = generateWallet();
  const claim = {
    fingerprint: fingerprint("proof-a"),
    recipient: miner.address,
    score: "10",
  };
  const first = chain.buildBlock({ rewardClaims: [claim], timestamp: 1 });
  chain.appendBlock(finalizeBlock(first, quorumFor(first, validators)));
  const second = chain.buildBlock({ rewardClaims: [claim], timestamp: 2 });
  const finalized = finalizeBlock(second, quorumFor(second, validators));
  assert.throws(() => chain.appendBlock(finalized), /already rewarded/);
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

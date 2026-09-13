import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  NirChain,
  createTransfer,
  finalizeBlock,
  formatNir,
} from "../blockchain/chain.mjs";
import { MAX_SUPPLY, TREASURY_ALLOCATION } from "../blockchain/constants.mjs";
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
  const signature = signObject({ value: 1 }, wallet);
  assert.equal(verifyObject({ value: 1 }, signature, wallet.publicKey), true);
  assert.equal(verifyObject({ value: 2 }, signature, wallet.publicKey), false);
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

test("a transfer cannot spend more than the sender owns", () => {
  const { chain, validators } = fixture();
  const alice = generateWallet();
  const bob = generateWallet();
  const transaction = createTransfer({
    wallet: alice,
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

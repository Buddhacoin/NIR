import assert from "node:assert/strict";
import test from "node:test";

import { publicWallet, generateWallet } from "../blockchain/crypto.mjs";
import {
  createTransfer,
  createValidatorBond,
  finalizeBlock,
  NirChain,
} from "../blockchain/chain.mjs";
import {
  MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";
import {
  activeValidatorSet,
  scheduleValidatorRotation,
  validatorSetId,
} from "../blockchain/validator-rotation.mjs";

function member(wallet, operatorId) { return { ...publicWallet(wallet), operatorId }; }

test("finality rotation is delayed and keeps a safe overlap", () => {
  const oldWallets = Array.from({ length: 4 }, generateWallet);
  const newcomers = Array.from({ length: 2 }, generateWallet);
  const current = oldWallets.map((wallet, index) => member(wallet, `old-${index}`));
  const proposed = [current[0], current[1], member(newcomers[0], "new-0"), member(newcomers[1], "new-1")];
  const bonds = new Map([...oldWallets, ...newcomers].map((wallet) => [wallet.address, MIN_VALIDATOR_BOND]));
  const pending = scheduleValidatorRotation({ current, proposed, bonds, currentHeight: 10, activationHeight: 15 });
  assert.deepEqual(activeValidatorSet({ current, pending, height: 14 }), current);
  assert.deepEqual(activeValidatorSet({ current, pending, height: 15 }), pending.validators);
});

test("an abrupt takeover, short notice, or unbonded member is rejected", () => {
  const oldWallets = Array.from({ length: 4 }, generateWallet);
  const newWallets = Array.from({ length: 4 }, generateWallet);
  const current = oldWallets.map((wallet, index) => member(wallet, `old-${index}`));
  const replacement = newWallets.map((wallet, index) => member(wallet, `new-${index}`));
  const bonds = new Map([...oldWallets, ...newWallets].map((wallet) => [wallet.address, MIN_VALIDATOR_BOND]));
  assert.throws(() => scheduleValidatorRotation({
    current, proposed: replacement, bonds, currentHeight: 10, activationHeight: 15,
  }), /one-third overlap/);
  assert.throws(() => scheduleValidatorRotation({
    current, proposed: current, bonds, currentHeight: 10, activationHeight: 14,
  }), /delay/);
  bonds.delete(oldWallets[0].address);
  assert.throws(() => scheduleValidatorRotation({
    current, proposed: current, bonds, currentHeight: 10, activationHeight: 15,
  }), /bond/);
});

test("the finalized chain activates a scheduled set and rejects old-set certificates", () => {
  const oldWallets = Array.from({ length: 4 }, generateWallet);
  const newWallets = Array.from({ length: 2 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const current = oldWallets.map((wallet, index) => member(wallet, `old-${index}`));
  const chain = new NirChain({
    networkId: "nir-rotation-test", validators: current,
    evaluators: evaluators.map((wallet, index) => member(wallet, `evaluator-${index}`)),
    beaconAuthorities: beacons.map((wallet, index) => member(wallet, `beacon-${index}`)),
    treasuryAddress: treasury.address, genesisTimestamp: 0,
    capabilityReferences: [{
      artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64),
      capabilitiesBps: { "reasoning-v1": 1 },
    }],
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
  });
  const all = [...oldWallets, ...newWallets];
  const quorum = (block, wallets) => {
    const proposer = wallets.find(({ address }) => address === block.proposer);
    return [proposer, ...wallets.filter((wallet) => wallet !== proposer).slice(0, 2)];
  };
  const append = (block, wallets) => chain.appendBlock(finalizeBlock(block, quorum(block, wallets)));
  const funding = all.map((wallet, index) => createTransfer({
    wallet: treasury, networkId: chain.networkId, recipient: wallet.address,
    amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE).toString(), nonce: index,
  }));
  append(chain.buildBlock({ transactions: funding, timestamp: TREASURY_VESTING_MS }), oldWallets);
  const bonds = all.map((wallet, index) => createValidatorBond({
    wallet, networkId: chain.networkId, amount: MIN_VALIDATOR_BOND.toString(), nonce: 0,
    operatorId: index >= oldWallets.length ? `new-${index - oldWallets.length}` : undefined,
  }));
  append(chain.buildBlock({ transactions: bonds, timestamp: TREASURY_VESTING_MS + 1 }), oldWallets);

  const nextWallets = [oldWallets[0], oldWallets[1], ...newWallets];
  const nextMembers = [current[0], current[1], member(newWallets[0], "new-0"), member(newWallets[1], "new-1")];
  const rotationBlock = chain.buildBlock({
    validatorRotation: { activationHeight: 7, validators: nextMembers },
    timestamp: TREASURY_VESTING_MS + 2,
  });
  append(rotationBlock, oldWallets);
  assert.equal(chain.pendingValidatorRotation.activationHeight, 7);
  for (let height = 4; height <= 6; height += 1) {
    append(chain.buildBlock({ timestamp: TREASURY_VESTING_MS + height }), oldWallets);
  }
  const activationBlock = chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 7 });
  assert.throws(() => chain.appendBlock(finalizeBlock(activationBlock, oldWallets.slice(0, 3))),
    /unknown validator|finality quorum|proposer did not sign/);
  assert.throws(() => chain.appendBlock(finalizeBlock(activationBlock, quorum(activationBlock, nextWallets))),
    /old-set transition quorum/);
  const transitionSigners = [...new Map([
    ...oldWallets.slice(0, 3),
    ...quorum(activationBlock, nextWallets),
  ].map((wallet) => [wallet.address, wallet])).values()];
  chain.appendBlock(finalizeBlock(activationBlock, transitionSigners));
  assert.equal(chain.pendingValidatorRotation, null);
  assert.equal(chain.validatorSetId, validatorSetId(nextMembers.sort((a, b) => a.address.localeCompare(b.address))));
});

import assert from "node:assert/strict";
import test from "node:test";

import { publicWallet, generateWallet } from "../blockchain/crypto.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";
import {
  activeValidatorSet,
  scheduleValidatorRotation,
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

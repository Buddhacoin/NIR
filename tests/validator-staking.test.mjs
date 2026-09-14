import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { generateWallet } from "../blockchain/crypto.mjs";
import {
  MIN_VALIDATOR_BOND, NON_REVEAL_SLASH_BPS, ValidatorStakeBook,
} from "../blockchain/validator-staking.mjs";

const fingerprint = (value) => createHash("sha256").update(value).digest("hex");

test("only sufficiently bonded validators are eligible", () => {
  const stakes = new ValidatorStakeBook();
  const wallet = generateWallet();
  assert.throws(() => stakes.register(wallet.address, MIN_VALIDATOR_BOND - 1n), /insufficient/);
  stakes.register(wallet.address, MIN_VALIDATOR_BOND);
  assert.equal(stakes.eligible(wallet.address), true);
});

test("proven randomness non-reveal burns one percent exactly once", () => {
  const stakes = new ValidatorStakeBook();
  const wallet = generateWallet();
  stakes.register(wallet.address, MIN_VALIDATOR_BOND);
  const result = stakes.slashNonReveal({
    address: wallet.address, candidateId: fingerprint("candidate"), committedHeight: 10, detectedHeight: 13,
  });
  assert.equal(result.burned, (MIN_VALIDATOR_BOND * NON_REVEAL_SLASH_BPS) / 10_000n);
  assert.equal(stakes.burned, result.burned);
  assert.throws(() => stakes.slashNonReveal({
    address: wallet.address, candidateId: fingerprint("candidate"), committedHeight: 10, detectedHeight: 13,
  }), /already used/);
});

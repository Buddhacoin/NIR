import assert from "node:assert/strict";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  advanceValidatorTrust,
  createValidatorHandoff,
  createValidatorHandoffCandidate,
  mergeValidatorHandoffCandidates,
  selectValidatorHandoffHistories,
  verifyValidatorHandoff,
} from "../blockchain/validator-handoff.mjs";

function members(wallets) {
  return wallets.map((wallet) => ({
    ...publicWallet(wallet), operatorId: `validator-${wallet.address.slice(4, 16)}`,
  }));
}

function fields(previousWallets, nextWallets, height = 10) {
  return {
    activationBlockHash: "a".repeat(64),
    activationHeight: height,
    activationStateRoot: "b".repeat(64),
    networkId: "nir-handoff-test",
    nextValidators: members(nextWallets),
    previousValidators: members(previousWallets),
  };
}

test("validator trust advances only after old and new quorums sign the same handoff", () => {
  const previous = Array.from({ length: 4 }, generateWallet);
  const next = [previous[0], previous[1], ...Array.from({ length: 2 }, generateWallet)];
  const handoff = createValidatorHandoff(fields(previous, next), previous.slice(0, 3), next.slice(0, 3));
  const verified = verifyValidatorHandoff(handoff, {
    expectedNetworkId: "nir-handoff-test",
    trustedValidators: members(previous),
  });
  assert.equal(verified.activationHeight, 10);
  assert.deepEqual(verified.trustedValidators, members(next)
    .sort((left, right) => left.address.localeCompare(right.address)));
});

test("handoff history selection tolerates stale and malformed independent sources", () => {
  const first = Array.from({ length: 4 }, generateWallet);
  const second = [first[0], first[1], ...Array.from({ length: 2 }, generateWallet)];
  const handoff = createValidatorHandoff(
    fields(first, second, 10), first.slice(0, 3), second.slice(0, 3),
  );
  const selected = selectValidatorHandoffHistories([
    [], [handoff], [handoff], [{ broken: true }],
  ], {
    expectedNetworkId: "nir-handoff-test",
    trustedValidators: members(first),
  });
  assert.equal(selected.handoffs.length, 1);
  assert.equal(selected.matchingSources, 2);
  const alternate = [first[0], first[2], ...Array.from({ length: 2 }, generateWallet)];
  const conflicting = createValidatorHandoff(
    fields(first, alternate, 10), first.slice(0, 3), alternate.slice(0, 3),
  );
  assert.throws(() => selectValidatorHandoffHistories([[handoff], [conflicting]], {
    expectedNetworkId: "nir-handoff-test",
    trustedValidators: members(first),
  }), /histories conflict/);
});

test("independent activation candidates merge only with old and new quorums", () => {
  const previous = Array.from({ length: 4 }, generateWallet);
  const next = [previous[0], previous[1], ...Array.from({ length: 2 }, generateWallet)];
  const transition = fields(previous, next);
  const signers = [...new Map([...previous, ...next].map((wallet) =>
    [wallet.address, wallet])).values()];
  const candidates = signers.map((wallet) => createValidatorHandoffCandidate(transition, wallet));
  const merged = mergeValidatorHandoffCandidates(candidates, {
    expectedNetworkId: transition.networkId,
    trustedValidators: transition.previousValidators,
  });
  assert.equal(merged.verified.activationHeight, transition.activationHeight);
  assert.equal(merged.handoff.previousAttestations.length, 4);
  assert.equal(merged.handoff.nextAttestations.length, 4);
  assert.throws(() => mergeValidatorHandoffCandidates(candidates.slice(0, 2), {
    expectedNetworkId: transition.networkId,
    trustedValidators: transition.previousValidators,
  }), /candidate quorum is not reached/);
});

test("a new validator set cannot self-authorize or alter a signed transition", () => {
  const previous = Array.from({ length: 4 }, generateWallet);
  const next = [previous[0], previous[1], ...Array.from({ length: 2 }, generateWallet)];
  const base = fields(previous, next);
  const selfAuthorized = createValidatorHandoff(base, next.slice(0, 3), next.slice(0, 3));
  assert.throws(() => verifyValidatorHandoff(selfAuthorized, {
    expectedNetworkId: base.networkId,
    trustedValidators: base.previousValidators,
  }), /attestation is invalid/);

  const minority = createValidatorHandoff(base, previous.slice(0, 2), next.slice(0, 3));
  assert.throws(() => verifyValidatorHandoff(minority, {
    expectedNetworkId: base.networkId,
    trustedValidators: base.previousValidators,
  }), /quorum is not reached/);

  const changed = structuredClone(createValidatorHandoff(
    base, previous.slice(0, 3), next.slice(0, 3),
  ));
  changed.activationHeight += 1;
  assert.throws(() => verifyValidatorHandoff(changed, {
    expectedNetworkId: base.networkId,
    trustedValidators: base.previousValidators,
  }), /trust chain is invalid|one-third overlap/);
});

test("multiple handoffs form an ordered chain rooted in the original set", () => {
  const first = Array.from({ length: 4 }, generateWallet);
  const second = [first[0], first[1], ...Array.from({ length: 2 }, generateWallet)];
  const third = [second[0], second[2], ...Array.from({ length: 2 }, generateWallet)];
  const handoff1 = createValidatorHandoff(fields(first, second, 10), first.slice(0, 3), second.slice(0, 3));
  const handoff2Fields = fields(second, third, 20);
  const handoff2 = createValidatorHandoff(handoff2Fields, second.slice(0, 3), third.slice(0, 3));
  const advanced = advanceValidatorTrust({
    expectedNetworkId: "nir-handoff-test",
    handoffs: [handoff1, handoff2],
    trustedValidators: members(first),
  });
  assert.equal(advanced.lastHandoff.activationHeight, 20);
  assert.deepEqual(advanced.trustedValidators, members(third)
    .sort((left, right) => left.address.localeCompare(right.address)));
  assert.throws(() => advanceValidatorTrust({
    expectedNetworkId: "nir-handoff-test",
    handoffs: [handoff2],
    trustedValidators: members(first),
  }), /trust chain is invalid|one-third overlap/);
});

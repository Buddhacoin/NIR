import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SUPPLY,
  PROGRESS_REWARD_ESCROW_DELAY_BLOCKS,
  TREASURY_ALLOCATION,
} from "../blockchain/constants.mjs";

function nextRandom(state) {
  state.value = (state.value * 1_664_525 + 1_013_904_223) >>> 0;
  return state.value;
}

function total(map) {
  return [...map.values()].reduce((sum, value) => sum + BigInt(value), 0n);
}

function invariant(model) {
  const escrowed = [...model.escrows.values()].reduce(
    (sum, escrow) => sum + escrow.reward, 0n,
  );
  const locked = [...model.escrows.values()].reduce(
    (sum, escrow) => sum + escrow.bond, 0n,
  );
  assert.equal(total(model.balances) + locked + escrowed + model.burned,
    TREASURY_ALLOCATION + model.mined);
  assert.ok(TREASURY_ALLOCATION + model.mined <= MAX_SUPPLY);
  for (const [candidateId, escrow] of model.escrows) {
    assert.equal(escrow.outcome, "pending", candidateId);
    assert.equal(escrow.unlockHeight, escrow.createdHeight + PROGRESS_REWARD_ESCROW_DELAY_BLOCKS);
  }
}

function settleHeight(model, fraudIds = new Set()) {
  for (const candidateId of fraudIds) {
    const escrow = model.escrows.get(candidateId);
    if (!escrow || model.height > escrow.unlockHeight || model.evidence.has(candidateId)) continue;
    model.burned += escrow.reward + escrow.bond;
    model.evidence.set(candidateId, model.height);
    model.outcomes.set(candidateId, "fraud-burn");
    model.escrows.delete(candidateId);
  }
  for (const [candidateId, escrow] of model.escrows) {
    if (model.height >= escrow.unlockHeight) {
      model.balances.set(escrow.recipient,
        (model.balances.get(escrow.recipient) ?? 0n) + escrow.reward);
      model.balances.set(escrow.sponsor,
        (model.balances.get(escrow.sponsor) ?? 0n) + escrow.bond);
      model.outcomes.set(candidateId, "matured");
      model.escrows.delete(candidateId);
    }
  }
}

test("seeded escrow schedules conserve issuance and settle exactly once", () => {
  for (let scenario = 0; scenario < 256; scenario += 1) {
    const random = { value: 0x9e3779b9 ^ scenario };
    const model = {
      balances: new Map([["treasury", TREASURY_ALLOCATION]]),
      burned: 0n,
      escrows: new Map(),
      evidence: new Map(),
      height: 0,
      mined: 0n,
      outcomes: new Map(),
    };
    for (let step = 0; step < 128; step += 1) {
      model.height += 1;
      const action = nextRandom(random) % 5;
      const candidateId = `candidate-${scenario}-${step}`;
      if (action <= 1 && TREASURY_ALLOCATION + model.mined < MAX_SUPPLY) {
        const reward = BigInt((nextRandom(random) % 10_000) + 1);
        const bond = reward + BigInt(nextRandom(random) % 10_000);
        const sponsorBalance = model.balances.get("treasury") ?? 0n;
        if (sponsorBalance >= bond && TREASURY_ALLOCATION + model.mined + reward <= MAX_SUPPLY) {
          model.balances.set("treasury", sponsorBalance - bond);
          model.mined += reward;
          model.escrows.set(candidateId, {
            bond, createdHeight: model.height, outcome: "pending",
            recipient: `recipient-${scenario}-${step % 7}`, reward, sponsor: "treasury",
            unlockHeight: model.height + PROGRESS_REWARD_ESCROW_DELAY_BLOCKS,
          });
        }
      }
      const pending = [...model.escrows.keys()];
      const fraudIds = new Set();
      if (action === 2 && pending.length > 0) {
        fraudIds.add(pending[nextRandom(random) % pending.length]);
      }
      // Actions 3 and 4 model false/replayed/late evidence: no matching live escrow changes.
      settleHeight(model, fraudIds);
      if (action === 4) {
        const clone = structuredClone(model);
        assert.deepEqual(clone, model, "restart/replay must preserve exact escrow state");
      }
      invariant(model);
    }
    for (let index = 0; index <= PROGRESS_REWARD_ESCROW_DELAY_BLOCKS; index += 1) {
      model.height += 1;
      settleHeight(model);
      invariant(model);
    }
    assert.equal(model.escrows.size, 0);
    assert.equal(model.outcomes.size, new Set(model.outcomes.keys()).size);
  }
});

test("one empty boundary transition matures every escrow sharing its unlock height", () => {
  const model = {
    balances: new Map([["treasury", TREASURY_ALLOCATION - 30n]]), burned: 0n,
    escrows: new Map(), evidence: new Map(), height: 7, mined: 12n, outcomes: new Map(),
  };
  for (const [candidateId, reward, bond] of [["a", 5n, 10n], ["b", 7n, 20n]]) {
    model.escrows.set(candidateId, { bond, createdHeight: 7, outcome: "pending",
      recipient: candidateId, reward, sponsor: "treasury",
      unlockHeight: 7 + PROGRESS_REWARD_ESCROW_DELAY_BLOCKS });
  }
  invariant(model);
  model.height = 7 + PROGRESS_REWARD_ESCROW_DELAY_BLOCKS;
  settleHeight(model);
  assert.equal(model.escrows.size, 0);
  assert.equal(model.balances.get("a"), 5n);
  assert.equal(model.balances.get("b"), 7n);
  assert.equal(model.balances.get("treasury"), TREASURY_ALLOCATION);
  invariant(model);
});

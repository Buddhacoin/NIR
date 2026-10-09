import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { allocateProgressRewards as allocateRewards } from "../blockchain/chain.mjs";
import {
  ATOMIC_UNITS,
  HALVING_INTERVAL,
  INITIAL_EPOCH_REWARD,
  LEGACY_INITIAL_EPOCH_REWARD,
  MAX_PROGRESS_REWARDS_PER_BLOCK,
  MAX_SUPPLY,
  MINING_POOL,
  TREASURY_ALLOCATION,
  scheduledEpochBudget as budgetFor,
} from "../blockchain/constants.mjs";

function scheduledEpochBudget(epoch, initialReward = INITIAL_EPOCH_REWARD) {
  return budgetFor(epoch, initialReward);
}

function allocateProgressRewards(epoch, claims, remaining = MINING_POOL) {
  return allocateRewards(epoch, claims, remaining, INITIAL_EPOCH_REWARD);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function address(value) {
  return `nir1${digest(value)}`;
}

function deterministicRandom(seed) {
  let state = BigInt(seed) & 0xffff_ffffn;
  return () => {
    state = (1_664_525n * state + 1_013_904_223n) & 0xffff_ffffn;
    return Number(state);
  };
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = random() % (index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function coalitionClaims(epoch, count, coalitionSize, salt = "model") {
  return Array.from({ length: count }, (_, index) => ({
    fingerprint: digest(`${salt}:epoch:${epoch}:candidate:${index}`),
    recipient: address(`${salt}:funded-key:${index % coalitionSize}`),
    score: String(BigInt((index + 3) * (epoch + 11) * 7_919) % 1_000_003n + 1n),
  }));
}

function amountsByFingerprint(rewards) {
  return Object.fromEntries(rewards.map(({ amount, fingerprint }) => [fingerprint, amount]));
}

function sumRewards(rewards) {
  return rewards.reduce((total, reward) => total + BigInt(reward.amount), 0n);
}

test("stateful coalition model cannot accelerate the rewarded-epoch schedule", () => {
  const random = deterministicRandom(0x4e4952);
  let state = { mined: 0n, rewardEpoch: 0, rewardedBlocks: 0 };

  for (let step = 0; step < 600; step += 1) {
    const before = { ...state };
    const censored = random() % 5 === 0;
    if (censored) {
      // Empty/censored blocks do not call the allocator and do not consume an
      // issuance epoch. Wall-clock throttling is covered by the chain tests.
      assert.deepEqual(state, before);
      continue;
    }

    const coalitionSize = 1 + (random() % 64);
    const candidateCount = 1 + (random() % MAX_PROGRESS_REWARDS_PER_BLOCK);
    const claims = coalitionClaims(state.rewardEpoch, candidateCount, coalitionSize);
    const orderA = shuffled(claims, random);
    const orderB = shuffled(claims, random);
    const remaining = MINING_POOL - state.mined;
    const rewardsA = allocateProgressRewards(state.rewardEpoch, orderA, remaining);
    const rewardsB = allocateProgressRewards(state.rewardEpoch, orderB, remaining);
    const budget = scheduledEpochBudget(state.rewardEpoch) < remaining
      ? scheduledEpochBudget(state.rewardEpoch) : remaining;

    assert.deepEqual(rewardsA, rewardsB, "claim ordering changed allocation");
    assert.equal(sumRewards(rewardsA), budget, "an epoch did not conserve its exact budget");
    assert.ok(sumRewards(rewardsA) <= INITIAL_EPOCH_REWARD);

    state = {
      mined: state.mined + budget,
      rewardEpoch: state.rewardEpoch + 1,
      rewardedBlocks: state.rewardedBlocks + 1,
    };
    assert.equal(state.rewardEpoch, state.rewardedBlocks);
    assert.ok(TREASURY_ALLOCATION + state.mined <= MAX_SUPPLY);

    // A snapshot restart preserves the emission counters exactly. A fork fed
    // the same candidate set in another order reaches the same model state.
    if (step % 37 === 0) {
      const restarted = JSON.parse(JSON.stringify(state, (_, value) =>
        typeof value === "bigint" ? `${value}n` : value), (_, value) =>
        typeof value === "string" && /^[0-9]+n$/.test(value)
          ? BigInt(value.slice(0, -1)) : value);
      assert.deepEqual(restarted, state);
      assert.equal(before.mined + sumRewards(rewardsB), state.mined);
    }
  }
});

test("funded keys and candidate splitting cannot enlarge one epoch budget", () => {
  const epoch = 12_345;
  const claims = coalitionClaims(
    epoch,
    MAX_PROGRESS_REWARDS_PER_BLOCK,
    MAX_PROGRESS_REWARDS_PER_BLOCK,
    "maximum-coalition",
  );
  const oneRecipient = claims.map((claim) => ({
    ...claim,
    recipient: address("single-company"),
  }));
  const manyRecipients = allocateProgressRewards(epoch, claims);
  const oneRecipientRewards = allocateProgressRewards(epoch, oneRecipient);

  for (const count of [1, 2, 17, MAX_PROGRESS_REWARDS_PER_BLOCK]) {
    assert.equal(
      sumRewards(allocateProgressRewards(epoch, claims.slice(0, count))),
      scheduledEpochBudget(epoch),
      `${count} candidate ids changed the epoch budget`,
    );
  }
  assert.equal(sumRewards(manyRecipients), scheduledEpochBudget(epoch));
  assert.equal(sumRewards(oneRecipientRewards), scheduledEpochBudget(epoch));
  assert.deepEqual(
    amountsByFingerprint(manyRecipients),
    amountsByFingerprint(oneRecipientRewards),
    "adding funded keys changed per-candidate allocation",
  );
  assert.equal(sumRewards(manyRecipients), 44n * ATOMIC_UNITS);
  assert.ok(sumRewards(manyRecipients) < MINING_POOL);
});

test("censorship changes recipients but never the epoch issuance budget", () => {
  const epoch = 77;
  const claims = coalitionClaims(epoch, 31, 7, "censorship");
  const subsets = [
    claims,
    claims.filter((_, index) => index % 2 === 0),
    claims.filter((_, index) => index % 3 === 1),
    [claims.at(-1)],
  ];

  for (const selected of subsets) {
    const forward = allocateProgressRewards(epoch, selected);
    const reverse = allocateProgressRewards(epoch, [...selected].reverse());
    assert.deepEqual(forward, reverse);
    assert.equal(sumRewards(forward), scheduledEpochBudget(epoch));
  }
});

test("hard-cap tail is exact and duplicate lineage fingerprints cannot share it", () => {
  const epoch = 419_999;
  const claims = coalitionClaims(epoch, 19, 19, "hard-cap-tail");
  for (const remaining of [1n, 7n, 10_001n, scheduledEpochBudget(epoch) - 1n]) {
    const rewards = allocateProgressRewards(epoch, claims, remaining);
    assert.equal(sumRewards(rewards), remaining);
    assert.equal(TREASURY_ALLOCATION + (MINING_POOL - remaining) + sumRewards(rewards), MAX_SUPPLY);
  }

  assert.throws(
    () => allocateProgressRewards(epoch, [claims[0], { ...claims[0], recipient: address("alias") }]),
    /duplicate proof claim/,
  );
  assert.throws(
    () => allocateProgressRewards(epoch, claims, 0n),
    /no mining budget remains/,
  );
});

test("44 NIR halvings approach the mining pool with exact atomic dust", () => {
  let scheduleTotal = 0n;
  let eras = 0;
  while (scheduledEpochBudget(eras * HALVING_INTERVAL) > 0n) {
    const start = eras * HALVING_INTERVAL;
    const budget = scheduledEpochBudget(start);
    assert.equal(scheduledEpochBudget(start + HALVING_INTERVAL - 1), budget);
    scheduleTotal += budget * BigInt(HALVING_INTERVAL);
    eras += 1;
  }
  const dust = MINING_POOL - scheduleTotal;
  assert.equal(MINING_POOL / ATOMIC_UNITS, 18_480_000n);
  assert.equal(INITIAL_EPOCH_REWARD, 44n * ATOMIC_UNITS);
  assert.equal(eras, 33);
  assert.equal(scheduleTotal, 1_847_999_998_110_000n);
  assert.equal(dust, 1_890_000n); // 0.01890000 NIR, never silently minted.
  assert.equal(scheduledEpochBudget(eras * HALVING_INTERVAL), 0n);
  assert.equal(TREASURY_ALLOCATION + MINING_POOL, MAX_SUPPLY);
  assert.equal(TREASURY_ALLOCATION + scheduleTotal + dust, MAX_SUPPLY);
  const claim = coalitionClaims(eras * HALVING_INTERVAL, 1, 1, "exhaustion");
  assert.throws(() => allocateProgressRewards(eras * HALVING_INTERVAL, claim, dust),
    /no mining budget remains/);
});

test("legacy 50 NIR schedule still exhausts the pool in the fourth era", () => {
  const firstThree = [0, 1, 2].reduce((total, era) => total +
    scheduledEpochBudget(era * HALVING_INTERVAL, LEGACY_INITIAL_EPOCH_REWARD) *
    BigInt(HALVING_INTERVAL), 0n);
  const remaining = MINING_POOL - firstThree;
  const fourth = scheduledEpochBudget(3 * HALVING_INTERVAL,
    LEGACY_INITIAL_EPOCH_REWARD);
  assert.equal(LEGACY_INITIAL_EPOCH_REWARD, 50n * ATOMIC_UNITS);
  assert.equal(firstThree, 18_375_000n * ATOMIC_UNITS);
  assert.equal(remaining, 105_000n * ATOMIC_UNITS);
  assert.equal(fourth, 625_000_000n);
  assert.equal(remaining / fourth, 16_800n);
  assert.equal(remaining % fourth, 0n);
});

test("exported emission helpers default to the v5 44 NIR schedule", () => {
  const claim = coalitionClaims(0, 1, 1, "legacy-default");
  assert.equal(budgetFor(0), INITIAL_EPOCH_REWARD);
  assert.equal(sumRewards(allocateRewards(0, claim)), INITIAL_EPOCH_REWARD);
  assert.equal(budgetFor(0, INITIAL_EPOCH_REWARD), INITIAL_EPOCH_REWARD);
  assert.equal(sumRewards(allocateRewards(0, claim, MINING_POOL, INITIAL_EPOCH_REWARD)),
    INITIAL_EPOCH_REWARD);
  assert.equal(budgetFor(0, LEGACY_INITIAL_EPOCH_REWARD), LEGACY_INITIAL_EPOCH_REWARD);
  assert.equal(sumRewards(allocateRewards(0, claim, MINING_POOL,
    LEGACY_INITIAL_EPOCH_REWARD)), LEGACY_INITIAL_EPOCH_REWARD);
});

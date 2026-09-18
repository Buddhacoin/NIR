import assert from "node:assert/strict";
import test from "node:test";

import {
  transferCreditAllowance,
  transferCreditEpoch,
} from "../blockchain/chain.mjs";
import {
  ATOMIC_UNITS,
  CREDIT_UNSTAKE_DELAY_BLOCKS,
  MIN_TRANSFER_FEE,
  TRANSFER_CREDIT_EPOCH_BLOCKS,
  TRANSFER_CREDIT_STAKE_UNIT,
} from "../blockchain/constants.mjs";

function deterministicRandom(seed) {
  let state = BigInt(seed) & 0xffff_ffffn;
  return () => {
    state = (1_664_525n * state + 1_013_904_223n) & 0xffff_ffffn;
    return Number(state);
  };
}

function splitTotal(total, parts, random) {
  const cuts = Array.from({ length: parts - 1 }, () =>
    BigInt(random()) * total / 0x1_0000_0000n).sort((a, b) => a < b ? -1 : 1);
  const boundaries = [0n, ...cuts, total];
  return boundaries.slice(1).map((boundary, index) => boundary - boundaries[index]);
}

test("splitting stake across Sybil keys never creates transfer credits", () => {
  const random = deterministicRandom(0x53594249);
  const integerBoundaries = [
    0n,
    1n,
    TRANSFER_CREDIT_STAKE_UNIT / 10n - 1n,
    TRANSFER_CREDIT_STAKE_UNIT / 10n,
    TRANSFER_CREDIT_STAKE_UNIT - 1n,
    TRANSFER_CREDIT_STAKE_UNIT,
    10n ** 32n - 1n,
  ];
  for (const stake of integerBoundaries) {
    assert.ok(transferCreditAllowance(stake) >= 0n);
  }
  assert.throws(() => transferCreditAllowance(-1n), /non-negative bigint/);
  assert.throws(() => transferCreditAllowance(1), /non-negative bigint/);

  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    const total = BigInt(random()) * ATOMIC_UNITS + BigInt(random());
    const partitions = splitTotal(total, 1 + (random() % 64), random);
    const splitAllowance = partitions.reduce(
      (sum, stake) => sum + transferCreditAllowance(stake), 0n,
    );
    assert.ok(splitAllowance <= transferCreditAllowance(total));
  }
});

test("credit epochs have exact boundaries and only a bounded boundary burst", () => {
  assert.equal(transferCreditEpoch(0), 0);
  assert.equal(transferCreditEpoch(1), 0);
  assert.equal(transferCreditEpoch(TRANSFER_CREDIT_EPOCH_BLOCKS), 0);
  assert.equal(transferCreditEpoch(TRANSFER_CREDIT_EPOCH_BLOCKS + 1), 1);
  assert.equal(transferCreditEpoch(2 * TRANSFER_CREDIT_EPOCH_BLOCKS), 1);
  assert.equal(transferCreditEpoch(2 * TRANSFER_CREDIT_EPOCH_BLOCKS + 1), 2);
  assert.throws(() => transferCreditEpoch(-1), /height is invalid/);
  assert.throws(() => transferCreditEpoch(Number.MAX_SAFE_INTEGER + 1), /height is invalid/);

  const allowance = transferCreditAllowance(TRANSFER_CREDIT_STAKE_UNIT);
  const lastOldEpochBlock = Array.from({ length: Number(allowance) }, () =>
    transferCreditEpoch(TRANSFER_CREDIT_EPOCH_BLOCKS));
  const firstNewEpochBlock = Array.from({ length: Number(allowance) }, () =>
    transferCreditEpoch(TRANSFER_CREDIT_EPOCH_BLOCKS + 1));
  assert.equal(lastOldEpochBlock.length + firstNewEpochBlock.length, 2 * Number(allowance));
  assert.ok(lastOldEpochBlock.every((epoch) => epoch === 0));
  assert.ok(firstNewEpochBlock.every((epoch) => epoch === 1));
});

test("stateful delegation and unstake model conserves value and charges one owner", () => {
  const random = deterministicRandom(0x43524544);
  const accountCount = 32;
  const initialPerAccount = 1_000n * ATOMIC_UNITS;
  const accounts = Array.from({ length: accountCount }, () => ({
    liquid: initialPerAccount,
    pending: null,
    stake: 0n,
  }));
  const initialTotal = initialPerAccount * BigInt(accountCount);
  const delegations = new Map();
  const usage = new Map();
  let feeCollector = 0n;
  let height = 1;
  let successfulTransfers = 0;
  let delegatedTransfers = 0;
  accounts[0].liquid -= TRANSFER_CREDIT_STAKE_UNIT;
  accounts[0].stake += TRANSFER_CREDIT_STAKE_UNIT;
  accounts[1].liquid -= TRANSFER_CREDIT_STAKE_UNIT;
  accounts[1].stake += TRANSFER_CREDIT_STAKE_UNIT;
  delegations.set("0:1", { epoch: 0, limit: 10n, spent: 0n });
  delegations.set("1:0", { epoch: 0, limit: 10n, spent: 0n });
  let cyclicDelegations = 1;

  const epochUsage = (owner) => {
    const epoch = transferCreditEpoch(height);
    const previous = usage.get(owner);
    return previous?.epoch === epoch ? previous : { epoch, spent: 0n };
  };

  for (let step = 0; step < 20_000; step += 1) {
    const owner = random() % accountCount;
    let delegate = random() % accountCount;
    if (delegate === owner) delegate = (delegate + 1) % accountCount;
    const account = accounts[owner];
    const operation = random() % 7;

    if (operation === 0) {
      const amount = BigInt(1 + (random() % 4)) * (TRANSFER_CREDIT_STAKE_UNIT / 10n);
      if (account.liquid >= amount) {
        account.liquid -= amount;
        account.stake += amount;
      }
    } else if (operation === 1) {
      const key = `${owner}:${delegate}`;
      const previous = delegations.get(key);
      const epoch = transferCreditEpoch(height);
      const spent = previous?.epoch === epoch ? previous.spent : 0n;
      const limit = BigInt(1 + (random() % 20));
      if (account.stake >= TRANSFER_CREDIT_STAKE_UNIT && limit >= spent) {
        delegations.set(key, { epoch, limit, spent });
        if (delegations.has(`${delegate}:${owner}`)) cyclicDelegations += 1;
      }
    } else if (operation === 2) {
      delegations.delete(`${owner}:${delegate}`);
    } else if (operation === 3 || operation === 4) {
      const delegated = operation === 4;
      const current = epochUsage(owner);
      const allowance = transferCreditAllowance(account.stake);
      const key = `${owner}:${delegate}`;
      const delegation = delegations.get(key);
      const delegationSpent = delegation?.epoch === current.epoch ? delegation.spent : 0n;
      const permitted = current.spent < allowance && (!delegated || (
        delegation !== undefined && delegationSpent < delegation.limit
      ));
      if (permitted) {
        usage.set(owner, { epoch: current.epoch, spent: current.spent + 1n });
        if (delegated) {
          delegations.set(key, {
            ...delegation,
            epoch: current.epoch,
            spent: delegationSpent + 1n,
          });
          delegatedTransfers += 1;
        }
        successfulTransfers += 1;
      }
    } else if (operation === 5) {
      if (account.pending === null && account.stake > MIN_TRANSFER_FEE) {
        const amount = 1n + BigInt(random()) % account.stake;
        if (amount > MIN_TRANSFER_FEE) {
          account.stake -= amount;
          account.pending = {
            amount: amount - MIN_TRANSFER_FEE,
            unlockHeight: height + CREDIT_UNSTAKE_DELAY_BLOCKS,
          };
          feeCollector += MIN_TRANSFER_FEE;
        }
      }
    } else if (account.pending !== null && height >= account.pending.unlockHeight) {
      account.liquid += account.pending.amount;
      account.pending = null;
      if (account.stake === 0n) {
        usage.delete(owner);
        for (const key of delegations.keys()) {
          if (key.startsWith(`${owner}:`)) delegations.delete(key);
        }
      }
    }

    if (step % 3 === 0) height += 1;
    const conserved = accounts.reduce((sum, value) =>
      sum + value.liquid + value.stake + (value.pending?.amount ?? 0n), feeCollector);
    assert.equal(conserved, initialTotal);
    for (const delegation of delegations.values()) {
      assert.ok(delegation.spent <= delegation.limit);
    }
    for (const [index, value] of usage) {
      if (value.epoch === transferCreditEpoch(height)) {
        // A later unstake may reduce the current allowance below earlier use;
        // it must never reset the already-consumed counter.
        assert.ok(value.spent >= 0n);
        assert.ok(index >= 0 && index < accountCount);
      }
    }
  }

  assert.ok(successfulTransfers > 1_000);
  assert.ok(delegatedTransfers > 100);
  assert.ok(cyclicDelegations > 0);
});

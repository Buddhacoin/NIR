import assert from "node:assert/strict";
import test from "node:test";

import {
  createCreditDelegation,
  createCreditStake,
  createCreditTransfer,
  createCreditUnstakeClaim,
  createCreditUnstakeRequest,
  createDelegatedCreditTransfer,
  createTransfer,
  finalizeBlock,
  NirChain,
} from "../blockchain/chain.mjs";
import {
  ATOMIC_UNITS,
  MAX_SUPPLY,
  MIN_EVALUATOR_BOND,
  MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT,
  TRANSFER_CREDIT_EPOCH_BLOCKS,
  TRANSFER_CREDIT_STAKE_UNIT,
  TRANSFER_CREDITS_PER_STAKE_UNIT,
  TREASURY_ALLOCATION,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function choose(values, random) { return values[Math.floor(random() * values.length)]; }
function member(wallet, operatorId) { return { ...publicWallet(wallet), operatorId }; }
function get(map, key) { return map.get(key) ?? 0n; }
function add(map, key, amount) { map.set(key, get(map, key) + amount); }

function fixture(seed) {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const users = Array.from({ length: 4 }, generateWallet);
  const genesis = {
    beaconAuthorities: beacons.map((wallet, index) => member(wallet, `beacon-${index}`)),
    capabilityReferences: [{
      artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64),
      capabilitiesBps: { "reasoning-v1": 1 },
    }],
    evaluators: evaluators.map((wallet, index) => member(wallet, `evaluator-${index}`)),
    genesisTimestamp: 0,
    networkId: `nir-economic-model-${seed}`,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: validators.map((wallet, index) => member(wallet, `validator-${index}`)),
  };
  return { chain: new NirChain(genesis), genesis, treasury, users, validators };
}

function quorum(block, validators) {
  const proposer = validators.find(({ address }) => address === block.proposer);
  return [proposer, ...validators.filter((wallet) => wallet !== proposer).slice(0, 2)];
}

function initialModel(treasury, evaluatorCount) {
  return {
    balances: new Map([[treasury.address,
      TREASURY_ALLOCATION - BigInt(evaluatorCount) * MIN_EVALUATOR_BOND]]),
    creditUsage: new Map(),
    delegations: new Map(),
    fees: 0n,
    nonces: new Map(),
    pending: new Map(),
    stakes: new Map(),
  };
}

function delegationKey(owner, delegate) { return `${owner}:${delegate}`; }

function spendCredit(model, owner, delegate, height) {
  const epoch = Math.floor((height - 1) / TRANSFER_CREDIT_EPOCH_BLOCKS);
  const usage = model.creditUsage.get(owner);
  const spent = usage?.epoch === epoch ? usage.spent : 0;
  model.creditUsage.set(owner, { epoch, spent: spent + 1 });
  if (delegate !== null) {
    const key = delegationKey(owner, delegate);
    const previous = model.delegations.get(key);
    const delegatedSpent = previous.epoch === epoch ? previous.spent : 0;
    model.delegations.set(key, { ...previous, epoch, spent: delegatedSpent + 1 });
  }
}

function applyModel(model, transaction, block) {
  const sender = transaction.sender;
  const fee = BigInt(transaction.fee ?? 0);
  if (transaction.type === "transfer") {
    const amount = BigInt(transaction.amount);
    add(model.balances, sender, -amount - fee);
    add(model.balances, transaction.recipient, amount);
    if (transaction.resource === "transfer-credit") {
      spendCredit(model, transaction.creditOwner ?? sender,
        transaction.creditOwner === undefined ? null : sender, block.height);
    } else {
      add(model.balances, block.proposer, fee);
      model.fees += fee;
    }
  } else if (transaction.type === "credit-stake") {
    const amount = BigInt(transaction.amount);
    add(model.balances, sender, -amount - fee);
    add(model.balances, block.proposer, fee);
    add(model.stakes, sender, amount);
    model.fees += fee;
  } else if (transaction.type === "credit-delegation") {
    add(model.balances, sender, -fee);
    add(model.balances, block.proposer, fee);
    model.fees += fee;
    const key = delegationKey(sender, transaction.delegate);
    if (transaction.limit === 0) model.delegations.delete(key);
    else {
      const epoch = Math.floor((block.height - 1) / TRANSFER_CREDIT_EPOCH_BLOCKS);
      const previous = model.delegations.get(key);
      model.delegations.set(key, {
        delegate: transaction.delegate,
        epoch,
        limit: transaction.limit,
        owner: sender,
        spent: previous?.epoch === epoch ? previous.spent : 0,
      });
    }
  } else if (transaction.type === "credit-unstake-request") {
    const amount = BigInt(transaction.amount);
    add(model.stakes, sender, -amount);
    add(model.balances, block.proposer, fee);
    model.fees += fee;
    model.pending.set(sender, { amount: amount - fee, unlockHeight: block.height + 64 });
  } else if (transaction.type === "credit-unstake-claim") {
    const pending = model.pending.get(sender);
    add(model.balances, sender, pending.amount);
    model.pending.delete(sender);
    if (get(model.stakes, sender) === 0n) {
      model.creditUsage.delete(sender);
      for (const [key, delegation] of model.delegations) {
        if (delegation.owner === sender) model.delegations.delete(key);
      }
    }
  } else {
    throw new Error(`unmodeled transaction ${transaction.type}`);
  }
  model.nonces.set(sender, (model.nonces.get(sender) ?? 0) + 1);
}

function modelCredits(model, address, height) {
  const allowance = (get(model.stakes, address) * BigInt(TRANSFER_CREDITS_PER_STAKE_UNIT)) /
    TRANSFER_CREDIT_STAKE_UNIT;
  const epoch = Math.floor((height - 1) / TRANSFER_CREDIT_EPOCH_BLOCKS);
  const usage = model.creditUsage.get(address);
  const spent = usage?.epoch === epoch ? BigInt(usage.spent) : 0n;
  return allowance > spent ? allowance - spent : 0n;
}

function assertEconomicState({ chain, model, treasury, users, validators }) {
  const addresses = [treasury, ...users, ...validators].map(({ address }) => address);
  let balances = 0n;
  for (const address of addresses) {
    const actual = chain.balance(address);
    assert.equal(actual, get(model.balances, address), `balance mismatch for ${address}`);
    assert.ok(actual >= 0n && actual <= MAX_SUPPLY);
    assert.equal(chain.nextNonce(address), model.nonces.get(address) ?? 0);
    balances += actual;
  }
  let stakes = 0n;
  let pending = 0n;
  for (const { address } of users) {
    const actualStake = chain.creditStake(address);
    assert.equal(actualStake, get(model.stakes, address));
    assert.ok(actualStake >= 0n && actualStake <= MAX_SUPPLY);
    stakes += actualStake;
    const actualPending = chain.creditUnstake(address);
    assert.deepEqual(actualPending, model.pending.get(address) ?? null);
    if (actualPending) {
      assert.ok(actualPending.amount >= 0n && actualPending.amount <= MAX_SUPPLY);
      pending += actualPending.amount;
    }
    assert.equal(chain.transferCredits(address), modelCredits(model, address, chain.height + 1));
    const expectedDelegations = [...model.delegations.values()]
      .filter(({ owner }) => owner === address)
      .sort((left, right) => left.delegate.localeCompare(right.delegate));
    assert.deepEqual(chain.creditDelegations(address), expectedDelegations);
  }
  const validatorBalances = validators.reduce((total, { address }) =>
    total + chain.balance(address), 0n);
  assert.equal(validatorBalances, model.fees, "fees must reach proposers exactly once");
  assert.equal(chain.burned, 0n);
  assert.equal(chain.issued, TREASURY_ALLOCATION);
  assert.ok(chain.issued <= MAX_SUPPLY);
  assert.equal(chain.circulatingSupply, chain.issued - chain.burned);
  const evaluatorBonds = chain.consensusSnapshot().state.evaluatorBonds.reduce(
    (sum, [, amount]) => sum + BigInt(amount), 0n,
  );
  assert.equal(balances + stakes + pending + evaluatorBonds + chain.burned, chain.issued,
    "native units must be conserved across liquid, staked, pending, and burned state");
}

test("deterministic native-state model conserves NIR and credits across long mixed histories", () => {
  const coverage = {
    claims: 0, creditTransfers: 0, delegations: 0, invalid: 0,
    replays: 0, revocations: 0, stakes: 0, transfers: 0, unstakes: 0,
  };
  for (const seed of [0x5eed1234, 0xc0ffee]) {
    const random = randomSource(seed);
    const context = fixture(seed);
    let { chain } = context;
    const { genesis, treasury, users, validators } = context;
    const model = initialModel(treasury, genesis.evaluators.length);
    const history = [];
    let timestamp = TREASURY_VESTING_MS;

    const commit = (transactions, apply = true) => {
      const block = chain.buildBlock({ transactions, timestamp: timestamp++ });
      const finalized = finalizeBlock(block, quorum(block, validators));
      chain.appendBlock(finalized);
      history.push(finalized);
      if (apply) for (const transaction of transactions) applyModel(model, transaction, block);
      return block;
    };

    const funding = users.map((wallet, nonce) => createTransfer({
      amount: (400n * ATOMIC_UNITS).toString(), networkId: chain.networkId,
      nonce, recipient: wallet.address, wallet: treasury,
    }));
    commit(funding);
    assertEconomicState({ ...context, chain, model });

    for (let step = 0; step < 140; step += 1) {
      const nextHeight = chain.height + 1;
      const actions = ["empty", "transfer"];
      if (users.some(({ address }) => get(model.balances, address) >
          TRANSFER_CREDIT_STAKE_UNIT + MIN_TRANSFER_FEE)) actions.push("stake");
      if (users.some(({ address }) => get(model.stakes, address) >= TRANSFER_CREDIT_STAKE_UNIT &&
          get(model.balances, address) >= MIN_TRANSFER_FEE)) actions.push("delegate");
      if (model.delegations.size > 0) actions.push("revoke", "delegated-credit");
      if (users.some(({ address }) => get(model.stakes, address) > MIN_TRANSFER_FEE &&
          !model.pending.has(address))) actions.push("unstake");
      if ([...model.pending.values()].some(({ unlockHeight }) => nextHeight >= unlockHeight)) {
        actions.push("claim");
      }
      if (users.some(({ address }) => modelCredits(model, address, nextHeight) > 0n &&
          get(model.balances, address) > 0n)) actions.push("credit-transfer");
      const action = choose(actions, random);
      let transaction = null;

      if (action === "transfer") {
        const sender = choose(users.filter(({ address }) =>
          get(model.balances, address) > MIN_TRANSFER_FEE + 10n), random);
        const recipient = choose(users.filter((wallet) => wallet !== sender), random);
        transaction = createTransfer({
          amount: String(1 + Math.floor(random() * 10)), networkId: chain.networkId,
          nonce: model.nonces.get(sender.address) ?? 0, recipient: recipient.address, wallet: sender,
        });
      } else if (action === "stake") {
        const owner = choose(users.filter(({ address }) => get(model.balances, address) >
          TRANSFER_CREDIT_STAKE_UNIT + MIN_TRANSFER_FEE), random);
        transaction = createCreditStake({
          amount: TRANSFER_CREDIT_STAKE_UNIT.toString(), networkId: chain.networkId,
          nonce: model.nonces.get(owner.address) ?? 0, wallet: owner,
        });
      } else if (action === "delegate") {
        const owner = choose(users.filter(({ address }) =>
          get(model.stakes, address) >= TRANSFER_CREDIT_STAKE_UNIT &&
          get(model.balances, address) >= MIN_TRANSFER_FEE), random);
        const delegate = choose(users.filter((wallet) => wallet !== owner), random);
        transaction = createCreditDelegation({
          delegate: delegate.address, limit: 1 + Math.floor(random() * 4),
          networkId: chain.networkId, nonce: model.nonces.get(owner.address) ?? 0, wallet: owner,
        });
      } else if (action === "revoke") {
        const delegation = choose([...model.delegations.values()], random);
        const owner = users.find(({ address }) => address === delegation.owner);
        transaction = createCreditDelegation({
          delegate: delegation.delegate, limit: 0, networkId: chain.networkId,
          nonce: model.nonces.get(owner.address) ?? 0, wallet: owner,
        });
      } else if (action === "unstake") {
        const owner = choose(users.filter(({ address }) => get(model.stakes, address) >
          MIN_TRANSFER_FEE && !model.pending.has(address)), random);
        const amount = get(model.stakes, owner.address) >= TRANSFER_CREDIT_STAKE_UNIT
          ? TRANSFER_CREDIT_STAKE_UNIT : get(model.stakes, owner.address);
        transaction = createCreditUnstakeRequest({
          amount: amount.toString(), networkId: chain.networkId,
          nonce: model.nonces.get(owner.address) ?? 0, wallet: owner,
        });
      } else if (action === "claim") {
        const owner = choose(users.filter(({ address }) =>
          (model.pending.get(address)?.unlockHeight ?? Infinity) <= nextHeight), random);
        transaction = createCreditUnstakeClaim({
          networkId: chain.networkId, nonce: model.nonces.get(owner.address) ?? 0, wallet: owner,
        });
      } else if (action === "credit-transfer") {
        const sender = choose(users.filter(({ address }) =>
          modelCredits(model, address, nextHeight) > 0n && get(model.balances, address) > 0n), random);
        const recipient = choose(users.filter((wallet) => wallet !== sender), random);
        transaction = createCreditTransfer({
          amount: "1", networkId: chain.networkId, nonce: model.nonces.get(sender.address) ?? 0,
          recipient: recipient.address, wallet: sender,
        });
      } else if (action === "delegated-credit") {
        const usable = [...model.delegations.values()].filter((delegation) => {
          const epoch = Math.floor((nextHeight - 1) / TRANSFER_CREDIT_EPOCH_BLOCKS);
          const spent = delegation.epoch === epoch ? delegation.spent : 0;
          const delegateBalance = get(model.balances, delegation.delegate);
          return spent < delegation.limit && modelCredits(model, delegation.owner, nextHeight) > 0n &&
            delegateBalance > 0n;
        });
        if (usable.length > 0) {
          const delegation = choose(usable, random);
          const delegate = users.find(({ address }) => address === delegation.delegate);
          const recipient = choose(users.filter((wallet) => wallet !== delegate), random);
          transaction = createDelegatedCreditTransfer({
            amount: "1", creditOwner: delegation.owner, networkId: chain.networkId,
            nonce: model.nonces.get(delegate.address) ?? 0, recipient: recipient.address,
            wallet: delegate,
          });
        }
      }

      if (transaction) {
        commit([transaction]);
        if (transaction.type === "transfer" && transaction.resource === "transfer-credit") {
          coverage.creditTransfers += 1;
        } else if (transaction.type === "transfer") coverage.transfers += 1;
        else if (transaction.type === "credit-stake") coverage.stakes += 1;
        else if (transaction.type === "credit-delegation" && transaction.limit === 0) {
          coverage.revocations += 1;
        } else if (transaction.type === "credit-delegation") coverage.delegations += 1;
        else if (transaction.type === "credit-unstake-request") coverage.unstakes += 1;
        else if (transaction.type === "credit-unstake-claim") coverage.claims += 1;
      }
      else commit([]);

      if (step % 9 === 0) {
        const sender = users[0];
        const oversized = step % 18 === 0;
        const invalid = createTransfer({
          amount: oversized ? (MAX_SUPPLY + 1n).toString() : "1", networkId: chain.networkId,
          nonce: (model.nonces.get(sender.address) ?? 0) + (oversized ? 0 : 1),
          recipient: users[1].address, wallet: sender,
        });
        const root = chain.stateRoot;
        const rejected = chain.buildBlock({ transactions: [invalid], timestamp });
        assert.throws(() => chain.appendBlock(finalizeBlock(rejected, quorum(rejected, validators))),
          oversized ? /insufficient balance/ : /unexpected nonce/);
        assert.equal(chain.stateRoot, root, "rejected transaction changed state root");
        coverage.invalid += 1;
      }

      if (step % 31 === 0) {
        const first = createTransfer({
          amount: "1", networkId: chain.networkId, nonce: model.nonces.get(users[0].address) ?? 0,
          recipient: users[1].address, wallet: users[0],
        });
        const second = createTransfer({
          amount: "1", networkId: chain.networkId, nonce: model.nonces.get(users[2].address) ?? 0,
          recipient: users[3].address, wallet: users[2],
        });
        const valid = chain.buildBlock({ transactions: [first, second], timestamp });
        const corrupted = structuredClone(valid);
        corrupted.transactions[1].signature = `${corrupted.transactions[1].signature[0] === "A" ? "B" : "A"}${corrupted.transactions[1].signature.slice(1)}`;
        const finalized = finalizeBlock(corrupted, quorum(corrupted, validators));
        const root = chain.stateRoot;
        assert.throws(() => chain.appendBlock(finalized));
        assert.equal(chain.stateRoot, root, "partially applied rejected block changed state root");
        coverage.invalid += 1;
      }

      assertEconomicState({ ...context, chain, model });
      if (step % 25 === 0) {
        const replay = new NirChain(genesis);
        for (const block of history) replay.appendBlock(block);
        assert.equal(replay.stateRoot, chain.stateRoot);
        assert.equal(replay.issued, chain.issued);
        assert.equal(replay.burned, chain.burned);
        chain = replay;
        coverage.replays += 1;
      }
    }
  }
  for (const [operation, count] of Object.entries(coverage)) {
    assert.ok(count > 0, `model sequence did not cover ${operation}`);
  }
});

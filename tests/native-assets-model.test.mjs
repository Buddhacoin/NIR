import assert from "node:assert/strict";
import test from "node:test";

import {
  createNativeAsset,
  createNativeAssetAuthorityRevoke,
  createNativeAssetBurn,
  createNativeAssetMint,
  createNativeAssetTransfer,
  createTransfer,
  computeChainStateRoot,
  finalizeBlock,
  nativeAssetId,
  NirChain,
  SYSTEM_NIR_ASSET_ID,
} from "../blockchain/chain.mjs";
import {
  ATOMIC_UNITS,
  MAX_SUPPLY,
  MAX_NATIVE_ASSETS,
  MAX_NATIVE_ASSET_BALANCES,
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  MIN_EVALUATOR_BOND,
  MIN_TRANSFER_FEE,
  PROTOCOL_VERSION,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_ALLOCATION,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet, signObject } from "../blockchain/crypto.mjs";
import { createStateSnapshot } from "../blockchain/state-snapshot.mjs";

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
function balanceKey(assetId, address) { return `${assetId}:${address}`; }

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const users = Array.from({ length: 5 }, generateWallet);
  const genesis = {
    beaconAuthorities: beacons.map((wallet, index) => member(wallet, `beacon-${index}`)),
    capabilityReferences: [{
      artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64),
      capabilitiesBps: { "reasoning-v1": 1 },
    }],
    evaluators: evaluators.map((wallet, index) => member(wallet, `evaluator-${index}`)),
    genesisTimestamp: 0,
    networkId: "nir-native-assets-model",
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

function schedule(version, activationHeight) {
  return { activationHeight, format: "nir-protocol-upgrade-v1", version };
}

function unsigned(transaction) {
  const { signature: _signature, ...payload } = transaction;
  return payload;
}

test("native assets are version-gated, deterministic, capped, and permanently revoke minting", () => {
  const { chain, treasury, users, validators } = fixture();
  const creator = users[0];
  const preActivation = createNativeAsset({
    fixedSupply: false, initialSupply: "1", maxSupply: "2",
    metadataHash: "a".repeat(64), networkId: chain.networkId, nonce: 0, wallet: creator,
  });
  const invalid = chain.buildBlock({ transactions: [preActivation], timestamp: TREASURY_VESTING_MS });
  assert.throws(() => chain.appendBlock(finalizeBlock(invalid, quorum(invalid, validators))),
    /protocol version 25/);

  const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  const funding = createTransfer({
    amount: (10n * ATOMIC_UNITS).toString(), networkId: chain.networkId, nonce: 0,
    recipient: creator.address, wallet: treasury,
  });
  let block = chain.buildBlock({
    protocolUpgrade: schedule(PROTOCOL_VERSION + 1, activationHeight),
    timestamp: TREASURY_VESTING_MS, transactions: [funding],
  });
  chain.appendBlock(finalizeBlock(block, quorum(block, validators)));
  while (chain.height < activationHeight) {
    block = chain.buildBlock({ timestamp: TREASURY_VESTING_MS + chain.height + 1 });
    chain.appendBlock(finalizeBlock(block, quorum(block, validators)));
  }
  assert.equal(chain.protocolVersion, 25);

  const create = createNativeAsset({
    fixedSupply: false, initialSupply: "100", maxSupply: "150",
    metadataHash: "b".repeat(64), networkId: chain.networkId, nonce: 0, wallet: creator,
  });
  assert.equal(create.assetId, nativeAssetId({
    creator: creator.address, networkId: chain.networkId, nonce: 0,
  }));
  block = chain.buildBlock({ transactions: [create], timestamp: TREASURY_VESTING_MS + 20 });
  chain.appendBlock(finalizeBlock(block, quorum(block, validators)));
  const mint = createNativeAssetMint({
    amount: "50", assetId: create.assetId, networkId: chain.networkId, nonce: 1, wallet: creator,
  });
  block = chain.buildBlock({ transactions: [mint], timestamp: TREASURY_VESTING_MS + 21 });
  chain.appendBlock(finalizeBlock(block, quorum(block, validators)));
  const burn = createNativeAssetBurn({
    amount: "25", assetId: create.assetId, networkId: chain.networkId, nonce: 2, wallet: creator,
  });
  block = chain.buildBlock({ transactions: [burn], timestamp: TREASURY_VESTING_MS + 22 });
  chain.appendBlock(finalizeBlock(block, quorum(block, validators)));
  const rootAfterBurn = chain.stateRoot;
  block = chain.buildBlock({ transactions: [burn], timestamp: TREASURY_VESTING_MS + 23 });
  assert.throws(() => chain.appendBlock(finalizeBlock(block, quorum(block, validators))),
    /unexpected nonce/);
  assert.equal(chain.stateRoot, rootAfterBurn);
  assert.deepEqual(chain.nativeAsset(create.assetId), {
    assetId: create.assetId, authority: creator.address, creationNonce: 0, creator: creator.address,
    fixedSupply: false, maxSupply: 150n, metadataHash: "b".repeat(64),
    minted: 150n, supply: 125n,
  });
  const overCap = createNativeAssetMint({
    amount: "1", assetId: create.assetId, networkId: chain.networkId, nonce: 3, wallet: creator,
  });
  block = chain.buildBlock({ transactions: [overCap], timestamp: TREASURY_VESTING_MS + 24 });
  assert.throws(() => chain.appendBlock(finalizeBlock(block, quorum(block, validators))), /cap/);
  const revoke = createNativeAssetAuthorityRevoke({
    assetId: create.assetId, networkId: chain.networkId, nonce: 3, wallet: creator,
  });
  block = chain.buildBlock({ transactions: [revoke], timestamp: TREASURY_VESTING_MS + 25 });
  chain.appendBlock(finalizeBlock(block, quorum(block, validators)));
  assert.equal(chain.nativeAsset(create.assetId).authority, null);
  const afterRevoke = createNativeAssetMint({
    amount: "1", assetId: create.assetId, networkId: chain.networkId, nonce: 4, wallet: creator,
  });
  block = chain.buildBlock({ transactions: [afterRevoke], timestamp: TREASURY_VESTING_MS + 26 });
  assert.throws(() => chain.appendBlock(finalizeBlock(block, quorum(block, validators))),
    /unauthorized/);

  const reserved = { ...createNativeAssetMint({
    amount: "1", assetId: create.assetId, networkId: chain.networkId, nonce: 4, wallet: creator,
  }), assetId: SYSTEM_NIR_ASSET_ID };
  reserved.signature = signObject(unsigned(reserved), creator, "NATIVE_ASSET_MINT");
  block = chain.buildBlock({ transactions: [reserved], timestamp: TREASURY_VESTING_MS + 27 });
  assert.throws(() => chain.appendBlock(finalizeBlock(block, quorum(block, validators))), /reserved/);
  const upgraded = { ...afterRevoke, upgradeAuthority: users[1].address };
  block = chain.buildBlock({ transactions: [upgraded], timestamp: TREASURY_VESTING_MS + 28 });
  assert.throws(() => chain.appendBlock(finalizeBlock(block, quorum(block, validators))),
    /schema contains missing or extra fields/);
});

test("deterministic asset model preserves supplies, NIR fees, rollback, and replay", () => {
  const random = randomSource(0xa55e7);
  const context = fixture();
  let { chain } = context;
  const { genesis, treasury, users, validators } = context;
  const history = [];
  const model = {
    assetBalances: new Map(), assets: new Map(),
    nir: new Map([[treasury.address,
      TREASURY_ALLOCATION - BigInt(genesis.evaluators.length) * MIN_EVALUATOR_BOND]]),
    nonces: new Map(),
  };
  const immutableCaps = new Map();
  const lastMinted = new Map();
  const revokedAuthorities = new Set();
  let timestamp = TREASURY_VESTING_MS;
  const append = (transactions, options = {}) => {
    const proposal = chain.buildBlock({ timestamp: timestamp++, transactions, ...options });
    const finalized = finalizeBlock(proposal, quorum(proposal, validators));
    chain.appendBlock(finalized);
    history.push(finalized);
    return proposal;
  };
  const charge = (transaction, block) => {
    const fee = BigInt(transaction.fee);
    add(model.nir, transaction.sender, -fee);
    add(model.nir, block.proposer, fee);
    model.nonces.set(transaction.sender, (model.nonces.get(transaction.sender) ?? 0) + 1);
  };
  const apply = (transaction, block) => {
    charge(transaction, block);
    const key = balanceKey(transaction.assetId, transaction.sender);
    if (transaction.type === "asset-create") {
      const initial = BigInt(transaction.initialSupply);
      model.assets.set(transaction.assetId, {
        assetId: transaction.assetId,
        authority: transaction.fixedSupply ? null : transaction.sender,
        creationNonce: transaction.nonce,
        creator: transaction.sender,
        fixedSupply: transaction.fixedSupply,
        maxSupply: BigInt(transaction.maxSupply),
        metadataHash: transaction.metadataHash,
        minted: initial,
        supply: initial,
      });
      if (initial > 0n) model.assetBalances.set(key, initial);
      immutableCaps.set(transaction.assetId, BigInt(transaction.maxSupply));
    } else if (transaction.type === "asset-mint") {
      const amount = BigInt(transaction.amount);
      const asset = model.assets.get(transaction.assetId);
      asset.minted += amount;
      asset.supply += amount;
      add(model.assetBalances, key, amount);
    } else if (transaction.type === "asset-transfer") {
      const amount = BigInt(transaction.amount);
      add(model.assetBalances, key, -amount);
      if (get(model.assetBalances, key) === 0n) model.assetBalances.delete(key);
      add(model.assetBalances, balanceKey(transaction.assetId, transaction.recipient), amount);
    } else if (transaction.type === "asset-burn") {
      const amount = BigInt(transaction.amount);
      add(model.assetBalances, key, -amount);
      if (get(model.assetBalances, key) === 0n) model.assetBalances.delete(key);
      model.assets.get(transaction.assetId).supply -= amount;
    } else if (transaction.type === "asset-revoke-authority") {
      model.assets.get(transaction.assetId).authority = null;
      revokedAuthorities.add(transaction.assetId);
    }
  };
  const assertState = () => {
    const addresses = [treasury, ...users, ...validators].map(({ address }) => address);
    for (const address of addresses) {
      assert.equal(chain.balance(address), get(model.nir, address));
      assert.ok(chain.balance(address) >= 0n && chain.balance(address) <= MAX_SUPPLY);
      assert.equal(chain.nextNonce(address), model.nonces.get(address) ?? 0);
    }
    assert.equal(chain.issued, TREASURY_ALLOCATION);
    assert.equal(chain.burned, 0n);
    const evaluatorBonds = chain.consensusSnapshot().state.evaluatorBonds.reduce(
      (sum, [, amount]) => sum + BigInt(amount), 0n,
    );
    assert.equal(addresses.reduce((total, address) => total + chain.balance(address), 0n) +
      evaluatorBonds, chain.issued - chain.burned);
    assert.ok(model.assets.size <= MAX_NATIVE_ASSETS);
    assert.ok(model.assetBalances.size <= MAX_NATIVE_ASSET_BALANCES);
    for (const [assetId, asset] of model.assets) {
      assert.deepEqual(chain.nativeAsset(assetId), asset);
      assert.equal(asset.maxSupply, immutableCaps.get(assetId));
      assert.ok(asset.minted >= (lastMinted.get(assetId) ?? 0n));
      lastMinted.set(assetId, asset.minted);
      if (revokedAuthorities.has(assetId)) assert.equal(asset.authority, null);
      let total = 0n;
      for (const { address } of users) {
        const expected = get(model.assetBalances, balanceKey(assetId, address));
        assert.equal(chain.nativeAssetBalance(assetId, address), expected);
        assert.ok(expected >= 0n && expected <= asset.maxSupply);
        total += expected;
      }
      assert.equal(total, asset.supply);
      assert.ok(asset.supply <= asset.minted && asset.minted <= asset.maxSupply);
    }
  };

  const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  const funding = users.map((wallet, nonce) => createTransfer({
    amount: (20n * ATOMIC_UNITS).toString(), networkId: chain.networkId, nonce,
    recipient: wallet.address, wallet: treasury,
  }));
  let block = append(funding, {
    protocolUpgrade: schedule(PROTOCOL_VERSION + 1, activationHeight),
  });
  for (const transfer of funding) {
    const amount = BigInt(transfer.amount);
    add(model.nir, treasury.address, -amount - BigInt(transfer.fee));
    add(model.nir, transfer.recipient, amount);
    add(model.nir, block.proposer, BigInt(transfer.fee));
    model.nonces.set(treasury.address, (model.nonces.get(treasury.address) ?? 0) + 1);
  }
  while (chain.height < activationHeight) append([]);

  const capped = createNativeAsset({
    fixedSupply: false, initialSupply: "1000", maxSupply: "5000",
    metadataHash: "c".repeat(64), networkId: chain.networkId, nonce: 0, wallet: users[0],
  });
  block = append([capped]); apply(capped, block);
  const fixed = createNativeAsset({
    fixedSupply: true, initialSupply: "700", maxSupply: "700",
    metadataHash: "d".repeat(64), networkId: chain.networkId, nonce: 0, wallet: users[1],
  });
  block = append([fixed]); apply(fixed, block);
  const coverage = { burn: 0, create: 2, fork: 0, invalid: 0, mint: 0, revoke: 0, transfer: 0 };
  const initialMint = createNativeAssetMint({
    amount: "100", assetId: capped.assetId, networkId: chain.networkId,
    nonce: model.nonces.get(users[0].address) ?? 0, wallet: users[0],
  });
  block = append([initialMint]); apply(initialMint, block); coverage.mint += 1;
  const initialTransfer = createNativeAssetTransfer({
    amount: "10", assetId: capped.assetId, networkId: chain.networkId,
    nonce: model.nonces.get(users[0].address) ?? 0, recipient: users[2].address, wallet: users[0],
  });
  block = append([initialTransfer]); apply(initialTransfer, block); coverage.transfer += 1;
  const initialBurn = createNativeAssetBurn({
    amount: "1", assetId: capped.assetId, networkId: chain.networkId,
    nonce: model.nonces.get(users[2].address) ?? 0, wallet: users[2],
  });
  block = append([initialBurn]); apply(initialBurn, block); coverage.burn += 1;

  const replayBefore = chain.consensusSnapshot();
  const replayProposal = chain.buildBlock({ transactions: [initialBurn], timestamp: timestamp++ });
  assert.throws(() => chain.appendBlock(finalizeBlock(
    replayProposal, quorum(replayProposal, validators),
  )), /unexpected nonce|replay/);
  assert.deepEqual(chain.consensusSnapshot(), replayBefore);
  coverage.invalid += 1;

  const validPrefix = createNativeAssetBurn({
    amount: "1", assetId: capped.assetId, networkId: chain.networkId,
    nonce: model.nonces.get(users[2].address) ?? 0, wallet: users[2],
  });
  const invalidSuffix = createNativeAssetMint({
    amount: "1", assetId: capped.assetId, networkId: chain.networkId,
    nonce: model.nonces.get(users[4].address) ?? 0, wallet: users[4],
  });
  const atomicBefore = chain.consensusSnapshot();
  const atomicProposal = chain.buildBlock({
    transactions: [validPrefix, invalidSuffix], timestamp: timestamp++,
  });
  assert.throws(() => chain.appendBlock(finalizeBlock(
    atomicProposal, quorum(atomicProposal, validators),
  )), /unauthorized/);
  assert.deepEqual(chain.consensusSnapshot(), atomicBefore);
  coverage.invalid += 1;

  for (let step = 0; step < 100; step += 1) {
    const actions = [];
    for (const asset of model.assets.values()) {
      if (asset.authority && asset.minted < asset.maxSupply) actions.push({ asset, type: "mint" });
      if (asset.authority) actions.push({ asset, type: "revoke" });
      for (const wallet of users) {
        if (get(model.assetBalances, balanceKey(asset.assetId, wallet.address)) > 0n) {
          actions.push({ asset, type: "transfer", wallet }, { asset, type: "burn", wallet });
        }
      }
    }
    const selected = choose(actions, random);
    let transaction;
    if (selected.type === "mint") {
      const authority = users.find(({ address }) => address === selected.asset.authority);
      const amount = selected.asset.maxSupply - selected.asset.minted > 20n ? 20n
        : selected.asset.maxSupply - selected.asset.minted;
      transaction = createNativeAssetMint({
        amount, assetId: selected.asset.assetId, networkId: chain.networkId,
        nonce: model.nonces.get(authority.address) ?? 0, wallet: authority,
      });
    } else if (selected.type === "revoke") {
      const authority = users.find(({ address }) => address === selected.asset.authority);
      transaction = createNativeAssetAuthorityRevoke({
        assetId: selected.asset.assetId, networkId: chain.networkId,
        nonce: model.nonces.get(authority.address) ?? 0, wallet: authority,
      });
    } else if (selected.type === "transfer") {
      const recipient = choose(users.filter((wallet) => wallet !== selected.wallet), random);
      transaction = createNativeAssetTransfer({
        amount: "1", assetId: selected.asset.assetId, networkId: chain.networkId,
        nonce: model.nonces.get(selected.wallet.address) ?? 0,
        recipient: recipient.address, wallet: selected.wallet,
      });
    } else {
      transaction = createNativeAssetBurn({
        amount: "1", assetId: selected.asset.assetId, networkId: chain.networkId,
        nonce: model.nonces.get(selected.wallet.address) ?? 0, wallet: selected.wallet,
      });
    }
    block = append([transaction]);
    apply(transaction, block);
    coverage[selected.type] += 1;

    if (step % 10 === 0) {
      const attacker = users[4];
      const burnIsUnfunded = get(model.assetBalances,
        balanceKey(fixed.assetId, attacker.address)) === 0n;
      const unauthorized = step % 20 === 0 || !burnIsUnfunded
        ? createNativeAssetMint({
          amount: "1", assetId: capped.assetId, networkId: chain.networkId,
          nonce: model.nonces.get(attacker.address) ?? 0, wallet: attacker,
        })
        : createNativeAssetBurn({
          amount: "1", assetId: fixed.assetId, networkId: chain.networkId,
          nonce: model.nonces.get(attacker.address) ?? 0, wallet: attacker,
        });
      const rejected = chain.buildBlock({ transactions: [unauthorized], timestamp });
      const root = chain.stateRoot;
      const height = chain.height;
      const before = chain.consensusSnapshot();
      assert.throws(() => chain.appendBlock(finalizeBlock(rejected, quorum(rejected, validators))),
        /unauthorized|unfunded/);
      assert.equal(chain.stateRoot, root);
      assert.equal(chain.height, height);
      assert.deepEqual(chain.consensusSnapshot(), before);
      coverage.invalid += 1;
    }
    assertState();
    if (step === 30) {
      const fork = chain.fork();
      assert.equal(fork.stateRoot, chain.stateRoot);
      const holderEntry = [...model.assetBalances.entries()]
        .find(([, amount]) => amount > 0n);
      const separator = holderEntry[0].indexOf(":");
      const assetId = holderEntry[0].slice(0, separator);
      const holderAddress = holderEntry[0].slice(separator + 1);
      const holder = users.find(({ address }) => address === holderAddress);
      const forkBurn = createNativeAssetBurn({
        amount: "1", assetId, networkId: fork.networkId,
        nonce: fork.nextNonce(holderAddress), wallet: holder,
      });
      const forkProposal = fork.buildBlock({ transactions: [forkBurn], timestamp });
      fork.appendBlock(finalizeBlock(forkProposal, quorum(forkProposal, validators)));
      assert.notEqual(fork.stateRoot, chain.stateRoot);
      assert.equal(fork.nativeAsset(assetId).supply,
        chain.nativeAsset(assetId).supply - 1n);
      assert.equal(chain.nextNonce(holderAddress), model.nonces.get(holderAddress) ?? 0);
      coverage.fork += 1;
    }
    if (step % 20 === 0) {
      const replay = new NirChain(genesis);
      for (const recorded of history) replay.appendBlock(recorded);
      assert.equal(replay.stateRoot, chain.stateRoot);
      for (const assetId of model.assets.keys()) assert.deepEqual(replay.nativeAsset(assetId), chain.nativeAsset(assetId));
      chain = replay;
    }
  }
  for (const [operation, count] of Object.entries(coverage)) {
    assert.ok(count > 0, `asset model did not cover ${operation}`);
  }
  const snapshot = createStateSnapshot(chain, validators.slice(0, 3));
  const restored = NirChain.fromVerifiedSnapshot(genesis, snapshot);
  assert.equal(restored.stateRoot, chain.stateRoot);
  for (const assetId of model.assets.keys()) {
    assert.deepEqual(restored.nativeAsset(assetId), chain.nativeAsset(assetId));
    for (const { address } of users) {
      assert.equal(restored.nativeAssetBalance(assetId, address),
        chain.nativeAssetBalance(assetId, address));
    }
  }
  const oversized = structuredClone(snapshot);
  const template = structuredClone(oversized.state.assets[0][1]);
  oversized.state.assets = Array.from({ length: MAX_NATIVE_ASSETS + 1 }, (_, index) => [
    index.toString(16).padStart(64, "0"), { ...template },
  ]);
  oversized.stateRoot = computeChainStateRoot(oversized.state);
  oversized.checkpoint.stateRoot = oversized.stateRoot;
  assert.throws(() => NirChain.fromVerifiedSnapshot(genesis, oversized), /capacity/);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  computeChainStateRoot, createNativeAsset, createNativeAssetAuthorityRevoke,
  createNativeAssetBurn, createNativeAssetMint, createNativeAssetTransfer, createTransfer,
  finalizeBlock, nativeAssetId, NirChain,
} from "../blockchain/chain.mjs";
import {
  MAX_NATIVE_ASSET_BALANCES, MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS, MIN_TRANSFER_FEE,
  PROTOCOL_VERSION, SAFETY_POLICY_V1_COMMITMENT, TREASURY_ALLOCATION,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createAssetProof, verifyAssetProof } from "../blockchain/asset-proof.mjs";
import { createOfflineSigningPackage, signOfflinePackage, validateOfflineSigningPackage,
  verifyOfflineSignedPackage } from "../blockchain/offline-signer.mjs";
import { simulateWalletOperation } from "../blockchain/transaction-simulation.mjs";
import { encryptWallet } from "../blockchain/vault.mjs";

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function member(wallet, operatorId) { return { ...publicWallet(wallet), operatorId }; }

function fixture(networkId = "nir-native-asset-adversarial") {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet(); const users = Array.from({ length: 4 }, generateWallet);
  const genesis = {
    beaconAuthorities: beacons.map((wallet, index) => member(wallet, `beacon-${index}`)),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluators: evaluators.map((wallet, index) => member(wallet, `evaluator-${index}`)),
    genesisTimestamp: 0, networkId, safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: validators.map((wallet, index) => member(wallet, `validator-${index}`)),
  };
  return { beacons, chain: new NirChain(genesis), evaluators, genesis, treasury, users, validators };
}

function quorum(block, validators) {
  const proposer = validators.find(({ address }) => address === block.proposer);
  return [proposer, ...validators.filter((wallet) => wallet !== proposer).slice(0, 2)];
}

function append(chain, validators, transactions, timestamp, options = {}) {
  const proposal = chain.buildBlock({ timestamp, transactions, ...options });
  chain.appendBlock(finalizeBlock(proposal, quorum(proposal, validators)));
  return proposal;
}

function activateAndFund(context) {
  const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  const transactions = context.users.map((user, nonce) => createTransfer({
    amount: "100000000", networkId: context.chain.networkId, nonce,
    recipient: user.address, wallet: context.treasury,
  }));
  append(context.chain, context.validators, transactions, TREASURY_VESTING_MS, {
    protocolUpgrade: { activationHeight, format: "nir-protocol-upgrade-v1",
      version: PROTOCOL_VERSION + 1 },
  });
  while (context.chain.height < activationHeight) {
    append(context.chain, context.validators, [], TREASURY_VESTING_MS + context.chain.height + 1);
  }
}

function proofFor(context, assetId, holder) {
  const proof = createAssetProof({ asset: context.chain.nativeAsset(assetId), assetId,
    balance: context.chain.nativeAssetBalance(assetId, holder), height: context.chain.height,
    holder, networkId: context.chain.networkId, protocolVersion: context.chain.protocolVersion,
    stateRoot: context.chain.stateRoot, tipHash: context.chain.tipHash,
    validators: context.validators.map((wallet, index) => member(wallet, `validator-${index}`)),
    validatorWallets: context.validators.slice(0, 3) });
  return { proof, statement: verifyAssetProof(proof, { expectedAssetId: assetId,
    expectedHolder: holder, expectedNetworkId: context.chain.networkId,
    minimumHeight: context.chain.height,
    trustedValidators: context.validators.map((wallet, index) => member(wallet, `validator-${index}`)) }) };
}

function evidence(context, statements, addresses) {
  return { accounts: Object.fromEntries(addresses.map((address) =>
    [address, context.chain.accountState(address)])), assetProofs: statements,
  height: context.chain.height, networkId: context.chain.networkId, proofVerified: true,
  stateRoot: context.chain.stateRoot, tipHash: context.chain.tipHash, verified: true };
}

function totalBalances(chain) {
  const state = chain.consensusSnapshot().state;
  return state.balances.reduce((total, [, amount]) => total + BigInt(amount), 0n) +
    state.evaluatorBonds.reduce((total, [, amount]) => total + BigInt(amount), 0n);
}

test("capacity-neutral full-balance transfer remains possible at the balance-entry limit", () => {
  const context = fixture("nir-native-asset-capacity");
  const creator = context.users[0]; const base = context.chain;
  const exported = base.consensusSnapshot(); exported.state.protocolVersion = 25;
  exported.state.pendingProtocolUpgrade = null;
  const assetId = nativeAssetId({ creator: creator.address, networkId: base.networkId, nonce: 0 });
  const assetBalances = [];
  for (let index = 1; index <= MAX_NATIVE_ASSET_BALANCES; index += 1) {
    assetBalances.push([`${assetId}:nir1${index.toString(16).padStart(64, "0")}`, "1"]);
  }
  assetBalances[0] = [`${assetId}:${creator.address}`, "1"];
  exported.state.assetBalances = assetBalances.sort(([left], [right]) => left.localeCompare(right));
  exported.state.assets = [[assetId, { assetId, authority: creator.address, creationNonce: 0,
    creator: creator.address, fixedSupply: false, maxSupply: String(MAX_NATIVE_ASSET_BALANCES),
    metadataHash: "a".repeat(64), minted: String(MAX_NATIVE_ASSET_BALANCES),
    supply: String(MAX_NATIVE_ASSET_BALANCES) }]];
  const balances = new Map(exported.state.balances); const funding = MIN_TRANSFER_FEE * 10n;
  balances.set(context.treasury.address,
    (BigInt(balances.get(context.treasury.address)) - funding).toString());
  balances.set(creator.address, funding.toString());
  exported.state.balances = [...balances].sort(([left], [right]) => left.localeCompare(right));
  exported.state.recoveryStateCommitment = base.recoveryStateCommitment;
  const stateRoot = computeChainStateRoot(exported.state);
  const checkpoint = { ...base.blocks().at(-1), protocolVersion: 25,
    recoveryStateCommitment: base.recoveryStateCommitment, stateRoot };
  const chain = NirChain.fromVerifiedSnapshot(context.genesis, { capabilityMemory: exported.capabilityMemory,
    checkpoint, height: 0, networkId: base.networkId, state: exported.state,
    recoveryStateCommitment: base.recoveryStateCommitment,
    stateRoot, tipHash: checkpoint.hash });
  const recipient = generateWallet();
  const transaction = createNativeAssetTransfer({ amount: "1", assetId,
    networkId: chain.networkId, nonce: 0, recipient: recipient.address, wallet: creator });
  append(chain, context.validators, [transaction], 1);
  assert.equal(chain.nativeAssetBalance(assetId, creator.address), 0n);
  assert.equal(chain.nativeAssetBalance(assetId, recipient.address), 1n);
  assert.equal(chain.consensusSnapshot().state.assetBalances.length, MAX_NATIVE_ASSET_BALANCES);
});

test("asset proof and simulation reject impossible identity, authority, cap, and balance states", () => {
  const context = fixture("nir-native-asset-proof-audit"); const creator = context.users[0];
  const mismatchedId = "f".repeat(64);
  assert.throws(() => createAssetProof({ asset: { assetId: mismatchedId,
    authority: creator.address, creationNonce: 0, creator: creator.address, fixedSupply: false,
    maxSupply: "10", metadataHash: "a".repeat(64), minted: "5", supply: "5" },
  assetId: mismatchedId, balance: "5", height: 0, holder: creator.address,
  networkId: context.chain.networkId, stateRoot: context.chain.stateRoot,
  tipHash: context.chain.tipHash,
  validators: context.validators.map((wallet, index) => member(wallet, `validator-${index}`)),
  validatorWallets: context.validators.slice(0, 3) }), /asset state is invalid/);

  const assetId = nativeAssetId({ creator: creator.address, networkId: context.chain.networkId, nonce: 0 });
  const impossible = { asset: { assetId, authority: context.users[1].address, creationNonce: 0,
    creator: creator.address, fixedSupply: false, maxSupply: "10", metadataHash: "a".repeat(64),
    minted: "11", supply: "12" }, assetId, balance: "12", format: "nir-native-asset-proof-v1",
  height: 0, holder: creator.address, networkId: context.chain.networkId,
  pendingProtocolUpgrade: null, protocolVersion: 25, stateRoot: "1".repeat(64),
  tipHash: "2".repeat(64), validatorSetId: "3".repeat(64) };
  assert.throws(() => simulateWalletOperation({ intent: { type: "asset-mint", amount: "1",
    assetId, fee: MIN_TRANSFER_FEE.toString(), networkId: context.chain.networkId,
    nonce: 0, sender: creator.address }, stateEvidence: { accounts: {
      [creator.address]: context.chain.accountState(creator.address),
    }, assetProofs: [impossible], height: 0, networkId: context.chain.networkId,
    proofVerified: true, stateRoot: "1".repeat(64), tipHash: "2".repeat(64), verified: true } }),
  /definition|supply|authority/);

  for (const metadataLabel of ["\u00e9", "e\u0301"]) {
    assert.throws(() => simulateWalletOperation({ intent: { type: "asset-create",
      fee: MIN_TRANSFER_FEE.toString(), fixedSupply: false, initialSupply: "1",
      maxSupply: "2", metadataHash: "a".repeat(64), metadataLabel,
      networkId: context.chain.networkId, nonce: 0, sender: creator.address },
    stateEvidence: { accounts: { [creator.address]: context.chain.accountState(creator.address) },
      assetProofs: [], height: 0, networkId: context.chain.networkId, proofVerified: true,
      stateRoot: context.chain.stateRoot, tipHash: context.chain.tipHash, verified: true } }),
    /unknown|missing fields/);
  }
});

test("96 seeded adversarial transitions preserve authority, lifetime cap, fees, and rollback", () => {
  const context = fixture(); activateAndFund(context);
  const [creator, ...holders] = context.users; let timestamp = TREASURY_VESTING_MS + 100;
  const create = createNativeAsset({ fixedSupply: false, initialSupply: "120", maxSupply: "500",
    metadataHash: "b".repeat(64), networkId: context.chain.networkId,
    nonce: context.chain.nextNonce(creator.address), wallet: creator });
  append(context.chain, context.validators, [create], timestamp++);
  let priorMinted = 120n; let revoked = false; const random = randomSource(0xa5517);
  for (let step = 0; step < 96; step += 1) {
    const asset = context.chain.nativeAsset(create.assetId);
    const holderPool = [creator, ...holders].filter((wallet) =>
      context.chain.nativeAssetBalance(create.assetId, wallet.address) > 0n);
    const kind = Math.floor(random() * 7); let transaction; let shouldAccept = false;
    if (kind === 0 && !revoked && asset.minted < asset.maxSupply) {
      const amount = asset.maxSupply - asset.minted > 7n ? 7n : asset.maxSupply - asset.minted;
      transaction = createNativeAssetMint({ amount: amount.toString(), assetId: create.assetId,
        networkId: context.chain.networkId, nonce: context.chain.nextNonce(creator.address), wallet: creator });
      shouldAccept = true;
    } else if (kind === 1 && holderPool.length > 0) {
      const sender = holderPool[Math.floor(random() * holderPool.length)];
      const recipient = context.users.find((wallet) => wallet !== sender &&
        wallet.address !== sender.address);
      transaction = createNativeAssetTransfer({ amount: "1", assetId: create.assetId,
        networkId: context.chain.networkId, nonce: context.chain.nextNonce(sender.address),
        recipient: recipient.address, wallet: sender }); shouldAccept = true;
    } else if (kind === 2 && holderPool.length > 0 && asset.supply > 1n) {
      const sender = holderPool[Math.floor(random() * holderPool.length)];
      transaction = createNativeAssetBurn({ amount: "1", assetId: create.assetId,
        networkId: context.chain.networkId, nonce: context.chain.nextNonce(sender.address), wallet: sender });
      shouldAccept = true;
    } else if (kind === 3 && !revoked) {
      transaction = createNativeAssetAuthorityRevoke({ assetId: create.assetId,
        networkId: context.chain.networkId, nonce: context.chain.nextNonce(creator.address), wallet: creator });
      shouldAccept = true; revoked = true;
    } else if (kind === 4) {
      transaction = createNativeAssetMint({ amount: "1", assetId: create.assetId,
        networkId: context.chain.networkId, nonce: context.chain.nextNonce(holders[0].address), wallet: holders[0] });
    } else if (kind === 5) {
      transaction = createNativeAssetMint({ amount: "501", assetId: create.assetId,
        networkId: context.chain.networkId, nonce: context.chain.nextNonce(creator.address), wallet: creator });
    } else {
      transaction = createNativeAssetBurn({ amount: "1", assetId: create.assetId,
        networkId: "nir-other-network", nonce: context.chain.nextNonce(creator.address), wallet: creator });
    }
    const beforeRoot = context.chain.stateRoot; const beforeNonce = context.chain.nextNonce(transaction.sender);
    const beforeSender = context.chain.balance(transaction.sender); const issued = context.chain.issued;
    const burned = context.chain.burned;
    if (shouldAccept) {
      const proposal = context.chain.buildBlock({ timestamp: timestamp++, transactions: [transaction] });
      const proposerBefore = context.chain.balance(proposal.proposer);
      context.chain.appendBlock(finalizeBlock(proposal, quorum(proposal, context.validators)));
      assert.equal(context.chain.balance(transaction.sender), beforeSender - BigInt(transaction.fee));
      assert.equal(context.chain.balance(proposal.proposer), proposerBefore + BigInt(transaction.fee));
      assert.equal(context.chain.nextNonce(transaction.sender), beforeNonce + 1);
    } else {
      const rejected = context.chain.buildBlock({ timestamp: timestamp++, transactions: [transaction] });
      assert.throws(() => context.chain.appendBlock(
        finalizeBlock(rejected, quorum(rejected, context.validators))),
      /unauthorized|cap|network|signature|unfunded/);
      assert.equal(context.chain.stateRoot, beforeRoot);
      assert.equal(context.chain.nextNonce(transaction.sender), beforeNonce);
      assert.equal(context.chain.balance(transaction.sender), beforeSender);
    }
    const current = context.chain.nativeAsset(create.assetId);
    assert.ok(current.minted >= priorMinted); priorMinted = current.minted;
    assert.ok(current.supply <= current.minted && current.minted <= current.maxSupply);
    if (revoked) assert.equal(current.authority, null);
    const sum = context.users.reduce((total, wallet) =>
      total + context.chain.nativeAssetBalance(create.assetId, wallet.address), 0n);
    assert.equal(sum, current.supply);
    assert.equal(context.chain.issued, issued); assert.equal(context.chain.burned, burned);
    assert.equal(totalBalances(context.chain), context.chain.issued - context.chain.burned);
  }
});

test("fresh proofs bind offline signing; stale, cross-network, replayed, and revoked mint paths reject", () => {
  const context = fixture("nir-native-asset-offline-audit"); activateAndFund(context);
  const [creator, recipient] = context.users; let timestamp = TREASURY_VESTING_MS + 200;
  const create = createNativeAsset({ fixedSupply: false, initialSupply: "10", maxSupply: "20",
    metadataHash: "c".repeat(64), networkId: context.chain.networkId,
    nonce: context.chain.nextNonce(creator.address), wallet: creator });
  append(context.chain, context.validators, [create], timestamp++);
  const senderProof = proofFor(context, create.assetId, creator.address);
  const recipientProof = proofFor(context, create.assetId, recipient.address);
  const intent = { type: "asset-transfer", amount: "3", assetId: create.assetId,
    fee: MIN_TRANSFER_FEE.toString(), networkId: context.chain.networkId,
    nonce: context.chain.nextNonce(creator.address), recipient: recipient.address,
    sender: creator.address };
  const stateEvidence = evidence(context,
    [senderProof.statement, recipientProof.statement], [creator.address]);
  const checkpoint = { height: context.chain.height, networkId: context.chain.networkId,
    stateRoot: context.chain.stateRoot, tipHash: context.chain.tipHash,
    validatorSetId: senderProof.statement.validatorSetId };
  const wrongValidatorContext = structuredClone(stateEvidence);
  wrongValidatorContext.assetProofs[0].validatorSetId = "f".repeat(64);
  assert.throws(() => createOfflineSigningPackage({ checkpoint,
    expiresAt: 10_000, intent, now: 1_000, stateEvidence: wrongValidatorContext }),
  /checkpoint|trust context/);
  const signingPackage = createOfflineSigningPackage({ checkpoint,
    expiresAt: 10_000, intent, now: 1_000, stateEvidence });
  const importedWithSubstitutedValidatorSet = structuredClone(signingPackage);
  importedWithSubstitutedValidatorSet.simulation.stateEvidence.assetProofs[0].validatorSetId =
    "f".repeat(64);
  assert.throws(() => validateOfflineSigningPackage(importedWithSubstitutedValidatorSet,
    { now: 2_000 }), /validator set.*checkpoint/);
  const importedWithMixedProtocolContext = structuredClone(signingPackage);
  importedWithMixedProtocolContext.simulation.stateEvidence.assetProofs[0].protocolVersion = 24;
  assert.throws(() => validateOfflineSigningPackage(importedWithMixedProtocolContext,
    { now: 2_000 }), /protocol trust context/);
  const importedForAnotherAsset = structuredClone(signingPackage);
  importedForAnotherAsset.intent.assetId = "e".repeat(64);
  assert.throws(() => validateOfflineSigningPackage(importedForAnotherAsset,
    { now: 2_000 }), /proof|consequences|match/);
  const signed = signOfflinePackage({ now: 2_000, password: "asset-offline-password",
    signingPackage, vault: encryptWallet(creator, "asset-offline-password") });
  assert.equal(verifyOfflineSignedPackage(signed, { now: 3_000 }).transaction.assetId, create.assetId);
  append(context.chain, context.validators, [signed.transaction], timestamp++);
  const rootAfter = context.chain.stateRoot;
  const replay = context.chain.buildBlock({ timestamp: timestamp++, transactions: [signed.transaction] });
  assert.throws(() => context.chain.appendBlock(finalizeBlock(replay,
    quorum(replay, context.validators))), /nonce/);
  assert.equal(context.chain.stateRoot, rootAfter);
  assert.throws(() => verifyAssetProof(senderProof.proof, { expectedAssetId: create.assetId,
    expectedHolder: creator.address, expectedNetworkId: context.chain.networkId,
    minimumHeight: context.chain.height,
    trustedValidators: context.validators.map((wallet, index) => member(wallet, `validator-${index}`)) }),
  /trust anchor/);
  assert.throws(() => verifyAssetProof(senderProof.proof, { expectedAssetId: create.assetId,
    expectedHolder: creator.address, expectedNetworkId: "nir-other-network", minimumHeight: 0,
    trustedValidators: context.validators.map((wallet, index) => member(wallet, `validator-${index}`)) }),
  /trust anchor/);

  const revoke = createNativeAssetAuthorityRevoke({ assetId: create.assetId,
    networkId: context.chain.networkId, nonce: context.chain.nextNonce(creator.address), wallet: creator });
  append(context.chain, context.validators, [revoke], timestamp++);
  const mint = createNativeAssetMint({ amount: "1", assetId: create.assetId,
    networkId: context.chain.networkId, nonce: context.chain.nextNonce(creator.address), wallet: creator });
  const rejectedMint = context.chain.buildBlock({ timestamp: timestamp++, transactions: [mint] });
  assert.throws(() => context.chain.appendBlock(finalizeBlock(rejectedMint,
    quorum(rejectedMint, context.validators))), /unauthorized/);
});

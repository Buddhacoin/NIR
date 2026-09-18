import assert from "node:assert/strict";
import test from "node:test";

import { createAssetProof, verifyAssetProof } from "../blockchain/asset-proof.mjs";
import { nativeAssetId } from "../blockchain/chain.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { encryptWallet } from "../blockchain/vault.mjs";
import { createOfflineSigningPackage, signOfflinePackage, verifyOfflineSignedPackage } from "../blockchain/offline-signer.mjs";
import { simulateWalletOperation } from "../blockchain/transaction-simulation.mjs";

const networkId = "nir-asset-tools-test";
const height = 19;
const stateRoot = "b".repeat(64);
const tipHash = "a".repeat(64);
const sender = generateWallet();
const recipient = generateWallet();
const validators = Array.from({ length: 4 }, generateWallet);
const members = validators.map((wallet, index) => ({ ...publicWallet(wallet), operatorId: `validator-${index}` }));
const assetId = nativeAssetId({ creator: sender.address, networkId, nonce: 4 });

function asset(overrides = {}) {
  return { assetId, authority: sender.address, creationNonce: 4, creator: sender.address,
    fixedSupply: false, maxSupply: "1000", metadataHash: "c".repeat(64), minted: "400",
    supply: "350", ...overrides };
}

function statement(holder, balance, assetValue = asset()) {
  const proof = createAssetProof({ asset: assetValue, assetId, balance, height, holder, networkId,
    stateRoot, tipHash, validators: members, validatorWallets: validators.slice(0, 3) });
  return verifyAssetProof(proof, { expectedAssetId: assetId, expectedHolder: holder,
    expectedNetworkId: networkId, minimumHeight: height, trustedValidators: members });
}

function account() {
  return { address: sender.address, atomicBalance: "1000000", history: { count: 0, root: "0".repeat(64) },
    nextNonce: 4, resources: { atomicStake: "0", availableTransferCredits: "0", delegations: [], pendingUnstake: null } };
}

function evidence(assetProofs) {
  return { accounts: { [sender.address]: account() }, assetProofs, height, networkId,
    proofVerified: true, stateRoot, tipHash, verified: true };
}

test("quorum asset proof binds existence or absence to holder and finalized state", () => {
  const proof = createAssetProof({ asset: asset(), assetId, balance: "100", height, holder: sender.address,
    networkId, stateRoot, tipHash, validators: members, validatorWallets: validators.slice(0, 3) });
  assert.equal(verifyAssetProof(proof, { expectedAssetId: assetId, expectedHolder: sender.address,
    expectedNetworkId: networkId, minimumHeight: height, trustedValidators: members }).balance, "100");
  const tampered = structuredClone(proof); tampered.balance = "101";
  assert.throws(() => verifyAssetProof(tampered, { expectedAssetId: assetId, expectedHolder: sender.address,
    expectedNetworkId: networkId, minimumHeight: height, trustedValidators: members }), /hash/);
  assert.throws(() => verifyAssetProof(proof, { expectedAssetId: assetId, expectedHolder: sender.address,
    expectedNetworkId: networkId, minimumHeight: height + 1, trustedValidators: members }), /trust anchor/);
  const unknown = structuredClone(proof); unknown.asset.attacker = true;
  assert.throws(() => verifyAssetProof(unknown, { expectedAssetId: assetId, expectedHolder: sender.address,
    expectedNetworkId: networkId, minimumHeight: height, trustedValidators: members }), /unknown or missing/);
});

test("asset simulations show exact NIR fee, asset deltas, authority and irreversible risks", () => {
  const senderProof = statement(sender.address, "100");
  const recipientProof = statement(recipient.address, "7");
  const transferred = simulateWalletOperation({ intent: { type: "asset-transfer", assetId,
    amount: "25", recipient: recipient.address, fee: "1000", networkId, nonce: 4, sender: sender.address },
    stateEvidence: evidence([senderProof, recipientProof]) });
  assert.equal(transferred.deltas.fee.atomic, "1000");
  assert.deepEqual(transferred.deltas.asset.map(({ balanceAfter }) => balanceAfter), ["75", "32"]);

  const mint = simulateWalletOperation({ intent: { type: "asset-mint", assetId, amount: "50",
    fee: "1000", networkId, nonce: 4, sender: sender.address }, stateEvidence: evidence([senderProof]) });
  assert.equal(mint.deltas.asset[0].mintedAfter, "450");
  assert.match(mint.risks.join(" "), /immutable lifetime cap/);

  const revoke = simulateWalletOperation({ intent: { type: "asset-revoke-authority", assetId,
    fee: "1000", networkId, nonce: 4, sender: sender.address }, stateEvidence: evidence([senderProof]) });
  assert.equal(revoke.deltas.asset[0].authorityAfter, null);
  assert.match(revoke.risks.join(" "), /irreversible/);
  assert.throws(() => simulateWalletOperation({ intent: { type: "asset-mint", assetId, amount: "601",
    fee: "1000", networkId, nonce: 4, sender: sender.address }, stateEvidence: evidence([senderProof]) }), /cap/);
  assert.throws(() => simulateWalletOperation({ intent: { type: "asset-mint", assetId, amount: "1",
    fee: "1000", networkId, nonce: 4, sender: recipient.address }, stateEvidence: evidence([recipientProof]) }), /account|authority/);
});

test("offline asset intent re-simulates proof-bound consequences and signs locally", () => {
  const senderProof = statement(sender.address, "100");
  const intent = { type: "asset-burn", assetId, amount: "10", fee: "1000", networkId,
    nonce: 4, sender: sender.address };
  const signingPackage = createOfflineSigningPackage({ intent, stateEvidence: evidence([senderProof]),
    checkpoint: { height, networkId, stateRoot, tipHash, validatorSetId: senderProof.validatorSetId },
    expiresAt: 61_000, now: 1_000 });
  const signed = signOfflinePackage({ vault: encryptWallet(sender, "offline-asset-password"),
    password: "offline-asset-password", signingPackage, now: 1_000 });
  assert.equal(signed.transaction.type, "asset-burn");
  assert.equal(verifyOfflineSignedPackage(signed, { now: 1_000 }).simulation.deltas.asset[0].balanceAfter, "90");
  const changed = structuredClone(signingPackage);
  changed.simulation.stateEvidence.assetProofs[0].balance = "101";
  assert.throws(() => signOfflinePackage({ vault: encryptWallet(sender, "offline-asset-password"),
    password: "offline-asset-password", signingPackage: changed, now: 1_000 }), /consequences/);
});

test("create preview requires a quorum proof of non-existence and deterministic id", () => {
  const absent = statement(sender.address, "0", null);
  const result = simulateWalletOperation({ intent: { type: "asset-create", assetId,
    fee: "1000", fixedSupply: false, initialSupply: "10", maxSupply: "100",
    metadataHash: "d".repeat(64), networkId, nonce: 4, sender: sender.address },
    stateEvidence: evidence([absent]) });
  assert.equal(result.deltas.asset[0].supplyAfter, "10");
  assert.throws(() => simulateWalletOperation({ intent: { ...result.intent, assetId: "e".repeat(64) },
    stateEvidence: evidence([absent]) }), /proof|definition/);
});

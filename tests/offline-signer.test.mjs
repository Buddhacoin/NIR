import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { canonicalJson, generateWallet } from "../blockchain/crypto.mjs";
import { encryptWallet } from "../blockchain/vault.mjs";
import {
  createOfflineSigningPackage, exportWatchOnly, parseCanonicalOfflineSigningPackage,
  parseOfflineSigningQrFragments, readPrivateOfflineVault, signOfflinePackage, validateOfflineSigningPackage,
  verifyOfflineSignedPackage, writePrivateCanonicalFile,
} from "../blockchain/offline-signer.mjs";
import { createWalletFile } from "../blockchain/wallet-files.mjs";

const now = 1_000_000;
const networkId = "nir-offline-test";
const sender = generateWallet();
const recipient = generateWallet();

function account(address, options = {}) {
  return { address, atomicBalance: options.atomicBalance ?? "1000000", history: { count: 0, root: "0".repeat(64) },
    nextNonce: options.nextNonce ?? 4, resources: { atomicStake: "100000", availableTransferCredits: "2",
      delegations: [], pendingUnstake: null } };
}

function evidence(accounts = { [sender.address]: account(sender.address) }) {
  return { accounts, height: 12, networkId, proofVerified: true, stateRoot: "b".repeat(64),
    tipHash: "a".repeat(64), verified: true };
}
function checkpoint() { return { height: 12, networkId, stateRoot: "b".repeat(64), tipHash: "a".repeat(64), validatorSetId: "c".repeat(64) }; }
function transfer() { return { amount: "50", fee: "1000", networkId, nonce: 4, recipient: recipient.address, sender: sender.address, type: "transfer" }; }

test("offline package commits to exact independently verified consequences and signs without broadcast", () => {
  const signingPackage = createOfflineSigningPackage({ intent: transfer(), stateEvidence: evidence(), checkpoint: checkpoint(), expiresAt: now + 60_000, now });
  const canonical = JSON.stringify(signingPackage); // deliberately not canonical field order
  assert.throws(() => parseCanonicalOfflineSigningPackage(canonical, { now }), /not canonical/);
  const text = canonicalJson(signingPackage);
  const parsed = parseCanonicalOfflineSigningPackage(text, { now });
  assert.equal(parsed.simulation.title, "Transfer");
  const signed = signOfflinePackage({ vault: encryptWallet(sender, "offline-password-long"), password: "offline-password-long", signingPackage, now });
  assert.equal(signed.format, "nir-offline-signed-package-v1");
  assert.equal(signed.transaction.recipient, recipient.address);
  assert.equal(signed.broadcast, undefined);
  assert.equal(verifyOfflineSignedPackage(signed, { now }).verified, true);
});

test("offline signer fails closed for changed state, commitment, expiry, unknown fields, and wrong authority", () => {
  const signingPackage = createOfflineSigningPackage({ intent: transfer(), stateEvidence: evidence(), checkpoint: checkpoint(), expiresAt: now + 60_000, now });
  assert.throws(() => validateOfflineSigningPackage({ ...signingPackage, expiresAt: now }, { now }), /expired/);
  assert.throws(() => validateOfflineSigningPackage({ ...signingPackage, simulationCommitment: "0".repeat(64) }, { now }), /consequences/);
  assert.throws(() => validateOfflineSigningPackage({ ...signingPackage, unexpected: true }, { now }), /unknown/);
  const changed = structuredClone(signingPackage);
  changed.simulation.stateEvidence.accounts[sender.address].nextNonce = 5;
  assert.throws(() => validateOfflineSigningPackage(changed, { now }), /nonce|consequences/);
  assert.throws(() => signOfflinePackage({ vault: encryptWallet(recipient, "offline-password-long"), password: "offline-password-long", signingPackage, now }), /required signing authority/);
});

test("offline package supports resource operations and rejects unsafe vault file modes", () => {
  const intent = { amount: "1000", fee: "1000", networkId, nonce: 4, sender: sender.address, type: "credit-stake" };
  const signingPackage = createOfflineSigningPackage({ intent, stateEvidence: evidence(), checkpoint: checkpoint(), expiresAt: now + 60_000, now });
  const signed = signOfflinePackage({ vault: encryptWallet(sender, "offline-password-long"), password: "offline-password-long", signingPackage, now });
  assert.equal(signed.transaction.type, "credit-stake");
  const directory = mkdtempSync(join(tmpdir(), "nir-offline-vault-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "offline-password-long" });
  chmodSync(vaultPath, 0o644);
  assert.throws(() => readPrivateOfflineVault(vaultPath), /private bounded/);
});

test("watch-only export and all signer output are restricted and secret-free", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-watch-only-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const created = createWalletFile({ path: vaultPath, password: "offline-password-long" });
  const exported = exportWatchOnly({ vaultPath, checkpoint: checkpoint() });
  assert.equal(exported.address, created.address);
  assert.equal(JSON.stringify(exported).includes("privateKey"), false);
  const target = join(directory, "watch.json");
  writePrivateCanonicalFile(target, exported);
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.equal(readFileSync(target, "utf8").includes("privateKey"), false);
});

test("fuzzed package mutations never silently validate", () => {
  const base = createOfflineSigningPackage({ intent: transfer(), stateEvidence: evidence(), checkpoint: checkpoint(), expiresAt: now + 60_000, now });
  for (const mutation of [
    (value) => { value.networkId = "other-network"; },
    (value) => { value.checkpoint.height += 1; },
    (value) => { value.intent.recipient = sender.address; },
    (value) => { value.simulation.result.deltas.balance[0].atomicDelta = "0"; },
    (value) => { value.version = 2; },
  ]) {
    const value = structuredClone(base); mutation(value);
    assert.throws(() => validateOfflineSigningPackage(value, { now }));
  }
});

test("QR fragments are complete, ordered by index, and reject duplicated or missing pieces", () => {
  const signingPackage = createOfflineSigningPackage({ intent: transfer(), stateEvidence: evidence(), checkpoint: checkpoint(), expiresAt: now + 60_000, now });
  const encoded = Buffer.from(canonicalJson(signingPackage), "utf8").toString("base64url");
  const cut = 1_000;
  const total = Math.ceil(encoded.length / cut);
  const frames = Array.from({ length: total }, (_, index) => `NIRQR1/${index + 1}/${total}/${encoded.slice(index * cut, (index + 1) * cut)}`);
  assert.equal(parseOfflineSigningQrFragments([...frames].reverse(), { now }).package.networkId, networkId);
  assert.throws(() => parseOfflineSigningQrFragments([frames[0], frames[0], ...frames.slice(2)], { now }), /inconsistent/);
});

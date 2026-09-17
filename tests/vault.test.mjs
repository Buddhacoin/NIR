import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet } from "../blockchain/crypto.mjs";
import { createMultisigRecoveryManifest, decryptWallet, encryptWallet } from "../blockchain/vault.mjs";
import { createVaultSet, verifyVaultSet } from "../blockchain/vault-files.mjs";
import {
  copyVerifiedWalletFile,
  createWalletFile,
  signWalletTransfer,
  verifyWalletFile,
  walletPublicInfo,
} from "../blockchain/wallet-files.mjs";
import { verifyObject } from "../blockchain/crypto.mjs";

test("an encrypted vault restores the exact post-quantum wallet", () => {
  const wallet = generateWallet();
  const vault = encryptWallet(wallet, "a-long-unique-test-password", { label: "Founder key A" });
  assert.equal(JSON.stringify(vault).includes(wallet.privateKey), false);
  assert.deepEqual(decryptWallet(vault, "a-long-unique-test-password"), wallet);
});

test("wrong passwords and modified vaults fail with the same closed error", () => {
  const vault = encryptWallet(generateWallet(), "another-long-test-password");
  assert.throws(() => decryptWallet(vault, "wrong-password-long-enough"), /integrity check is invalid/);
  const modified = structuredClone(vault);
  modified.address = generateWallet().address;
  assert.throws(() => decryptWallet(modified, "another-long-test-password"), /integrity check is invalid/);
});

test("vault parsing rejects malformed and oversized cryptographic fields", () => {
  const password = "bounded-vault-parser-password";
  const vault = encryptWallet(generateWallet(), password);
  for (const mutate of [
    (copy) => { copy.cipher.tag = Buffer.alloc(15).toString("base64"); },
    (copy) => { copy.cipher.iv += "="; },
    (copy) => { copy.kdf.salt = "not base64"; },
    (copy) => { copy.cipher.ciphertext = Buffer.alloc(16_385).toString("base64"); },
  ]) {
    const malformed = structuredClone(vault);
    mutate(malformed);
    assert.throws(() => decryptWallet(malformed, password), /integrity check is invalid/);
  }
});

test("vault creation validates password bounds and the complete wallet key pair", () => {
  assert.throws(() => encryptWallet(generateWallet(), "too-short"), /12 to 1024/);
  assert.throws(() => encryptWallet(generateWallet(), "x".repeat(1_025)), /12 to 1024/);
  const wallet = generateWallet();
  const unrelated = generateWallet();
  assert.throws(() => encryptWallet({ ...wallet, privateKey: unrelated.privateKey },
    "mismatched-key-pair-password"), /key pair does not match/);
  assert.throws(() => encryptWallet({ ...wallet, address: unrelated.address },
    "mismatched-address-password"), /address does not match/);
});

test("a recovery manifest identifies three separate backups without private keys", () => {
  const vaults = Array.from({ length: 3 }, (_, index) =>
    encryptWallet(generateWallet(), `separate-password-${index}-long`, { label: `Guardian ${index + 1}` }),
  );
  const manifest = createMultisigRecoveryManifest({ vaults, threshold: 2 });
  assert.match(manifest.address, /^nir1[0-9a-f]{64}$/);
  assert.equal(manifest.members.length, 3);
  assert.equal(manifest.threshold, 2);
  assert.equal(JSON.stringify(manifest).includes("ciphertext"), false);
  assert.equal(JSON.stringify(manifest).includes("privateKey"), false);
});

test("offline vault set creation writes restricted files and verifies recovery", () => {
  const parent = mkdtempSync(join(tmpdir(), "nir-vault-test-"));
  const directory = join(parent, "founder-vault");
  const passwords = [
    "guardian-one-password-long",
    "guardian-two-password-long",
    "guardian-three-password-long",
  ];
  try {
    const manifest = createVaultSet({ directory, passwords });
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    for (const { file } of manifest.files) {
      assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);
    }
    assert.equal(statSync(join(directory, "recovery-manifest.json")).mode & 0o777, 0o600);
    assert.deepEqual(verifyVaultSet({ directory, passwords }), {
      address: manifest.address,
      threshold: 2,
      verified: true,
    });
    const publicManifest = readFileSync(join(directory, "recovery-manifest.json"), "utf8");
    assert.equal(publicManifest.includes("ciphertext"), false);
    assert.throws(() => createVaultSet({ directory, passwords }));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("native wallet file is private and signs a network-bound transfer", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-test-"));
  const path = join(directory, "personal.nirvault.json");
  const recipient = generateWallet();
  try {
    const created = createWalletFile({ path, password: "personal-wallet-password-long" });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(walletPublicInfo(path).address, created.address);
    const transaction = signWalletTransfer({
      path, password: "personal-wallet-password-long", networkId: "nir-testnet",
      recipient: recipient.address, amount: "250000000", nonce: 0,
    });
    const { signature, ...payload } = transaction;
    assert.equal(verifyObject(payload, signature, JSON.parse(readFileSync(path, "utf8")).publicKey, "TRANSFER"), true);
    assert.equal(transaction.sender, created.address);
    assert.equal(JSON.stringify(transaction).includes("privateKey"), false);
    assert.throws(() => createWalletFile({ path, password: "different-password-long" }));
    const corrupted = JSON.parse(readFileSync(path, "utf8"));
    corrupted.address = recipient.address;
    writeFileSync(path, JSON.stringify(corrupted));
    assert.throws(() => walletPublicInfo(path), /not a NIR wallet vault/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet backups are password-verified, private, and restore only to a new file", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-backup-test-"));
  const source = join(directory, "wallet.nirvault.json");
  const backup = join(directory, "wallet-backup.nirvault.json");
  const restored = join(directory, "wallet-restored.nirvault.json");
  const password = "wallet-backup-password-long";
  try {
    const created = createWalletFile({ path: source, password });
    assert.deepEqual(verifyWalletFile({ path: source, password }), {
      ...walletPublicInfo(source), verified: true,
    });
    assert.throws(() => verifyWalletFile({ path: source, password: "wrong-password-long" }),
      /integrity check is invalid/);
    const copied = copyVerifiedWalletFile({ sourcePath: source, targetPath: backup, password });
    assert.equal(copied.address, created.address);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.equal(readFileSync(backup, "utf8"), readFileSync(source, "utf8"));
    assert.equal(copyVerifiedWalletFile({
      sourcePath: backup, targetPath: restored, password,
    }).address, created.address);
    assert.throws(() => copyVerifiedWalletFile({
      sourcePath: backup, targetPath: restored, password,
    }), /EEXIST/);
    assert.throws(() => copyVerifiedWalletFile({
      sourcePath: source, targetPath: join(directory, "bad-backup.json"),
      password: "wrong-password-long",
    }), /integrity check is invalid/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

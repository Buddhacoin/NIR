import assert from "node:assert/strict";
import {
  chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  readlinkSync, renameSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet } from "../blockchain/crypto.mjs";
import { createMultisigRecoveryManifest, decryptWallet, encryptWallet } from "../blockchain/vault.mjs";
import { createVaultSet, verifyVaultSet } from "../blockchain/vault-files.mjs";
import {
  createVerifiedWalletBackup,
  createWalletFile,
  restoreVerifiedWalletBackup,
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
  assert.throws(() => encryptWallet(generateWallet(), "too-short"), /at least 16/);
  assert.throws(() => encryptWallet(generateWallet(), "x".repeat(1_025)), /canonical/);
  assert.throws(() => encryptWallet(generateWallet(), "x".repeat(32)), /canonical/);
  assert.throws(() => encryptWallet(generateWallet(), "cafe\u0301-password-long"), /canonical/);
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

test("offline vault set creation writes a network-bound generation and verifies recovery", () => {
  const parent = mkdtempSync(join(tmpdir(), "nir-vault-test-"));
  const directory = join(parent, "founder-vault");
  const passwords = [
    "guardian-one-password-long",
    "guardian-two-password-long",
    "guardian-three-password-long",
  ];
  try {
    const manifest = createVaultSet({
      directory, passwords, networkId: "nir-recovery-test", generation: 7,
    });
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    for (const { file } of manifest.files) {
      assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);
    }
    assert.equal(statSync(join(directory, "recovery-manifest.json")).mode & 0o777, 0o600);
    assert.deepEqual(verifyVaultSet({
      directory, passwords, networkId: "nir-recovery-test", minimumGeneration: 7,
    }), {
      address: manifest.address,
      generation: 7,
      networkId: "nir-recovery-test",
      threshold: 2,
      verified: true,
    });
    assert.throws(() => verifyVaultSet({
      directory, passwords, networkId: "nir-other-network", minimumGeneration: 7,
    }), /invalid/);
    assert.throws(() => verifyVaultSet({
      directory, passwords, networkId: "nir-recovery-test", minimumGeneration: 8,
    }), /invalid/);
    const publicManifest = readFileSync(join(directory, "recovery-manifest.json"), "utf8");
    assert.equal(publicManifest.includes("ciphertext"), false);
    assert.throws(() => createVaultSet({
      directory, passwords, networkId: "nir-recovery-test", generation: 8,
    }));
    assert.equal(readdirSync(parent).some((name) => name.endsWith(".tmp")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("recovery activation never replaces a target won by a concurrent creator", () => {
  const parent = mkdtempSync(join(tmpdir(), "nir-vault-race-test-"));
  const directory = join(parent, "recovery");
  const foreign = Buffer.from("foreign target must remain byte-for-byte intact\n");
  const passwords = ["race-guardian-one-password", "race-guardian-two-password",
    "race-guardian-three-password"];
  try {
    assert.throws(() => createVaultSet({
      directory, passwords, networkId: "nir-race-test", generation: 1,
      onBeforeActivate() {
        mkdirSync(directory, { mode: 0o700 });
        writeFileSync(join(directory, "foreign-owner"), foreign, { mode: 0o600 });
      },
    }), /EEXIST/);
    assert.deepEqual(readFileSync(join(directory, "foreign-owner")), foreign);
    assert.deepEqual(readdirSync(directory), ["foreign-owner"]);
    assert.equal(readdirSync(parent).some((name) => name.endsWith(".tmp")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("recovery activation cannot be redirected through a raced target symlink", () => {
  const parent = mkdtempSync(join(tmpdir(), "nir-vault-symlink-race-test-"));
  const directory = join(parent, "recovery");
  const foreign = join(parent, "foreign");
  const marker = Buffer.from("foreign contents stay unchanged\n");
  const passwords = ["link-guardian-one-password", "link-guardian-two-password",
    "link-guardian-three-password"];
  try {
    mkdirSync(foreign, { mode: 0o700 });
    writeFileSync(join(foreign, "marker"), marker, { mode: 0o600 });
    assert.throws(() => createVaultSet({
      directory, passwords, networkId: "nir-link-race", generation: 1,
      onBeforeActivate() { symlinkSync("foreign", directory, "dir"); },
    }), /EEXIST/);
    assert.equal(readlinkSync(directory), "foreign");
    assert.deepEqual(readFileSync(join(foreign, "marker")), marker);
    assert.deepEqual(readdirSync(foreign), ["marker"]);
    assert.equal(readdirSync(parent).some((name) => name.includes(".nir-recovery-")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("recovery verification rejects an activation link swapped after creation", () => {
  const parent = mkdtempSync(join(tmpdir(), "nir-vault-verify-swap-test-"));
  const directory = join(parent, "recovery");
  const saved = join(parent, "saved-activation");
  const foreign = join(parent, "foreign");
  const passwords = ["verify-guardian-one-password", "verify-guardian-two-password",
    "verify-guardian-three-password"];
  try {
    createVaultSet({ directory, passwords, networkId: "nir-verify-swap", generation: 4 });
    mkdirSync(foreign, { mode: 0o700 });
    renameSync(directory, saved);
    symlinkSync("foreign", directory, "dir");
    assert.throws(() => verifyVaultSet({
      directory, passwords, networkId: "nir-verify-swap", minimumGeneration: 4,
    }), /activation target is invalid/);
    assert.match(readlinkSync(saved), /\.nir-recovery-[0-9a-f]{32}$/);
    assert.deepEqual(readdirSync(foreign), []);
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

test("wallet backups bind network, address and monotonic generation", async () => {
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
    const copied = createVerifiedWalletBackup({
      sourcePath: source, targetPath: backup, password,
      networkId: "nir-backup-test", generation: 9,
    });
    assert.equal(copied.address, created.address);
    assert.equal(copied.generation, 9);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(backup, "utf8")).networkId, "nir-backup-test");
    assert.equal(restoreVerifiedWalletBackup({
      sourcePath: backup, targetPath: restored, password, networkId: "nir-backup-test",
      expectedAddress: created.address, minimumGeneration: 9,
    }).address, created.address);
    assert.throws(() => restoreVerifiedWalletBackup({
      sourcePath: backup, targetPath: join(directory, "foreign-network.json"), password,
      networkId: "nir-foreign", expectedAddress: created.address, minimumGeneration: 9,
    }), /context, generation/);
    assert.throws(() => restoreVerifiedWalletBackup({
      sourcePath: backup, targetPath: join(directory, "old.json"), password,
      networkId: "nir-backup-test", expectedAddress: created.address, minimumGeneration: 10,
    }), /context, generation/);
    assert.throws(() => restoreVerifiedWalletBackup({
      sourcePath: backup, targetPath: join(directory, "wrong-address.json"), password,
      networkId: "nir-backup-test", expectedAddress: generateWallet().address, minimumGeneration: 9,
    }), /context, generation/);
    assert.throws(() => createVerifiedWalletBackup({
      sourcePath: source, targetPath: join(directory, "bad-backup.json"),
      password: "wrong-password-long", networkId: "nir-backup-test", generation: 10,
    }), /integrity check is invalid/);

    const raced = join(directory, "concurrent-restore.json");
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => Promise.resolve().then(() =>
      restoreVerifiedWalletBackup({
        sourcePath: backup, targetPath: raced, password, networkId: "nir-backup-test",
        expectedAddress: created.address, minimumGeneration: 9,
      }))));
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(verifyWalletFile({ path: raced, password }).verified, true);
    assert.equal(readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("vault file reads reject symlink, hardlink, partial-write and unsafe modes", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-vault-filesystem-test-"));
  const vaultPath = join(directory, "wallet.json");
  const password = "filesystem-wallet-password-long";
  try {
    createWalletFile({ path: vaultPath, password });
    const symlink = join(directory, "wallet-link.json");
    symlinkSync(vaultPath, symlink);
    assert.throws(() => walletPublicInfo(symlink), /invalid|unsafe/);
    const hardlink = join(directory, "wallet-hardlink.json");
    linkSync(vaultPath, hardlink);
    assert.throws(() => walletPublicInfo(vaultPath), /invalid or unsafe/);
    rmSync(hardlink);
    const partial = join(directory, "partial.json");
    writeFileSync(partial, "{\"format\":", { mode: 0o600 });
    assert.throws(() => walletPublicInfo(partial), /invalid or unsafe/);
    chmodSync(vaultPath, 0o644);
    assert.throws(() => walletPublicInfo(vaultPath), /invalid or unsafe/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("single-file wallet activation cannot follow a raced target symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-activation-race-"));
  const target = join(directory, "wallet.json");
  const foreign = join(directory, "foreign");
  const marker = Buffer.from("foreign file remains unchanged\n");
  try {
    mkdirSync(foreign, { mode: 0o700 });
    writeFileSync(join(foreign, "marker"), marker, { mode: 0o600 });
    assert.throws(() => createWalletFile({
      path: target, password: "activation-race-password-long",
      _beforeActivate() { symlinkSync("foreign", target, "dir"); },
    }), /EEXIST/);
    assert.equal(readlinkSync(target), "foreign");
    assert.deepEqual(readFileSync(join(foreign, "marker")), marker);
    assert.equal(readdirSync(directory).some((name) => name.includes(".nir-private-")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restore cleanup never deletes a target replaced after activation", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-restore-swap-"));
  const source = join(directory, "source.json");
  const backup = join(directory, "backup.json");
  const restored = join(directory, "restored.json");
  const moved = join(directory, "moved-activation");
  const password = "restore-swap-password-long";
  const foreign = Buffer.from("foreign replacement remains intact\n");
  try {
    const wallet = createWalletFile({ path: source, password });
    createVerifiedWalletBackup({
      sourcePath: source, targetPath: backup, password, networkId: "nir-restore-swap", generation: 2,
    });
    assert.throws(() => restoreVerifiedWalletBackup({
      sourcePath: backup, targetPath: restored, password, networkId: "nir-restore-swap",
      expectedAddress: wallet.address, minimumGeneration: 2,
      _afterActivate({ target }) {
        renameSync(target, moved);
        writeFileSync(target, foreign, { mode: 0o600 });
      },
    }), /invalid or unsafe/);
    assert.deepEqual(readFileSync(restored), foreign);
    assert.match(readlinkSync(moved), /\.nir-private-[0-9a-f]{32}$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("vault parser fuzz rejects parameter bombs, unknown fields and hides secrets", () => {
  const password = "fuzz-vault-password-long";
  const vault = encryptWallet(generateWallet(), password);
  const mutations = [
    (copy) => { copy.kdf.N = 2 ** 30; },
    (copy) => { copy.kdf.p = 2 ** 20; },
    (copy) => { copy.kdf.extra = "downgrade"; },
    (copy) => { copy.cipher.extra = "ignored"; },
    (copy) => { copy.extra = "unknown"; },
    (copy) => { copy.cipher.ciphertext = "A".repeat(40_000); },
  ];
  for (let index = 0; index < 24; index += 1) {
    mutations.push((copy) => {
      const field = ["salt", "iv", "tag", "ciphertext"][index % 4];
      const parent = field === "salt" ? copy.kdf : copy.cipher;
      parent[field] = `${parent[field].slice(0, index % Math.max(1, parent[field].length))}!`;
    });
  }
  for (const mutate of mutations) {
    const malformed = structuredClone(vault);
    mutate(malformed);
    let message = "";
    assert.throws(() => decryptWallet(malformed, password), (error) => {
      message = error.message;
      return /integrity check is invalid/.test(message);
    });
    assert.equal(message.includes(password), false);
    assert.equal(message.includes(vault.cipher.ciphertext), false);
  }
});

test("fresh vaults do not reuse scrypt salt or AES-GCM nonce", () => {
  const pairs = new Set();
  for (let index = 0; index < 12; index += 1) {
    const vault = encryptWallet(generateWallet(), `unique-randomness-password-${index}`);
    const pair = `${vault.kdf.salt}:${vault.cipher.iv}`;
    assert.equal(pairs.has(pair), false);
    pairs.add(pair);
  }
});

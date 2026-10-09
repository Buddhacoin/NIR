import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWalletFile, restoreRecoveryCodeWalletBackup, verifyWalletFile } from "../blockchain/wallet-files.mjs";
import {
  createLocalTestWallet, createWalletWithRecoveryDrill, listLocalTestWallets, openLocalTestWallet,
  renewLocalTestRecoveryCode, restoreLocalTestWalletWithRecoveryCode,
} from "../blockchain/wallet-onboarding.mjs";
import { validPassword, validPersonalWalletPassword } from "../blockchain/vault.mjs";

test("personal wallet password policy does not weaken high-value vault creation", () => {
  const password = "test-only-12";
  assert.equal(validPersonalWalletPassword(password), true);
  assert.equal(validPassword(password, { creation: true }), false);
  const root = mkdtempSync(join(tmpdir(), "nir-local-password-policy-"));
  try {
    assert.throws(() => createWalletFile({ path: join(root, "high-value.nirvault.json"),
      password }), /at least 16 characters/);
    const local = createLocalTestWallet({ storageRoot: join(root, "personal"), password });
    assert.equal(verifyWalletFile({ path: local.walletPath, password }).address, local.address);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local recovery keeps the address, requires the matching code, and never revokes old copies", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-local-recovery-core-"));
  const password = "test-only-12";
  try {
    const storageRoot = join(root, "wallet");
    const created = createLocalTestWallet({ storageRoot, password });
    const wallets = listLocalTestWallets(storageRoot);
    assert.equal(wallets.length, 1);
    assert.equal(openLocalTestWallet({ wallets, path: created.walletPath, password }).address,
      created.address);
    const renewed = renewLocalTestRecoveryCode({ storageRoot,
      walletPath: created.walletPath, password });
    assert.notEqual(renewed.recoveryCode, created.recoveryCode);
    assert.notEqual(renewed.backupPath, created.backupPath);
    assert.throws(() => restoreLocalTestWalletWithRecoveryCode({
      storageRoot: join(root, "wrong-code"), backupPath: created.backupPath,
      expectedAddress: created.address, recoveryCode: renewed.recoveryCode,
      newPassword: "another-test-12",
    }), /invalid/);
    const restoredOld = restoreLocalTestWalletWithRecoveryCode({
      storageRoot, backupPath: created.backupPath,
      expectedAddress: created.address, recoveryCode: created.recoveryCode,
      newPassword: "another-test-12",
    });
    const restoredNew = restoreLocalTestWalletWithRecoveryCode({
      storageRoot: join(root, "new-copy"), backupPath: renewed.backupPath,
      expectedAddress: created.address, recoveryCode: renewed.recoveryCode,
      newPassword: "another-test-12",
    });
    assert.equal(restoredOld.address, created.address);
    assert.equal(restoredNew.address, created.address);
    const copies = listLocalTestWallets(storageRoot);
    assert.equal(copies.length, 2);
    assert.deepEqual(new Set(copies.map(({ path }) => path)),
      new Set([created.walletPath, restoredOld.walletPath]));
    assert.equal(openLocalTestWallet({ wallets: copies, path: created.walletPath,
      password }).address, created.address);
    assert.equal(openLocalTestWallet({ wallets: copies, path: restoredOld.walletPath,
      password: "another-test-12" }).address, created.address);
    assert.throws(() => openLocalTestWallet({ wallets: copies, path: created.walletPath,
      password: "another-test-12" }), /invalid/);
    assert.throws(() => openLocalTestWallet({ wallets: copies, path: restoredOld.walletPath,
      password }), /invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup failure surfaces the created wallet instead of hiding or deleting its only key", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-partial-wallet-"));
  const password = "test-only-12";
  try {
    const storageRoot = join(root, "profile");
    const walletDirectory = join(storageRoot, "Wallets");
    const backupDirectory = join(storageRoot, "Backups");
    mkdirSync(walletDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(backupDirectory, { mode: 0o700 });
    const walletPath = join(walletDirectory, "partial.nirvault.json");
    const backupPath = join(backupDirectory, "partial.nirvault.json");
    let partial;
    try {
      createWalletWithRecoveryDrill({ walletPath, backupPath, networkId: "nir-local-rehearsal",
        password, recoveryCode: "invalid-code", personalWallet: true });
    } catch (error) { partial = error; }
    assert.equal(partial?.code, "NIR_WALLET_RECOVERY_INCOMPLETE");
    assert.match(partial.message, /Не удаляйте файл.*создайте новую резервную копию и код/);
    assert.match(partial.address, /^nir1[0-9a-f]{64}$/);
    assert.equal(partial.walletPath, walletPath);
    assert.equal(partial.backupPath, backupPath);
    assert.equal(existsSync(walletPath), true);
    assert.equal(existsSync(backupPath), false);
    assert.equal(verifyWalletFile({ path: walletPath, password }).address, partial.address);
    assert.equal(listLocalTestWallets(storageRoot)[0].path, walletPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery-code backup rejects wrong context, tampering, and unsafe aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-v2-backup-negative-"));
  try {
    const created = createLocalTestWallet({ storageRoot: join(root, "profile"),
      password: "test-only-12" });
    const restore = (sourcePath, overrides = {}) => restoreRecoveryCodeWalletBackup({
      sourcePath, targetPath: join(root, `restored-${randomUUID()}.nirvault.json`),
      recoveryCode: created.recoveryCode, newPassword: "another-test-12",
      networkId: "nir-local-rehearsal", expectedAddress: created.address,
      minimumGeneration: 1, ...overrides,
    });
    assert.throws(() => restore(created.backupPath, { networkId: "another-network" }),
      /context/);
    assert.throws(() => restore(created.backupPath, { expectedAddress: `nir1${"0".repeat(64)}` }),
      /context/);
    assert.throws(() => restore(created.backupPath, { minimumGeneration: 2 }), /generation/);

    const tamperedPath = join(root, "tampered.nirvault.json");
    const tampered = JSON.parse(readFileSync(created.backupPath, "utf8"));
    tampered.vault.cipher.ciphertext = `${tampered.vault.cipher.ciphertext[0] === "A" ? "B" : "A"}${tampered.vault.cipher.ciphertext.slice(1)}`;
    writeFileSync(tamperedPath, JSON.stringify(tampered), { flag: "wx", mode: 0o600 });
    assert.throws(() => restore(tamperedPath), /integrity/);

    const aliasPath = join(root, "alias.nirvault.json");
    symlinkSync(created.backupPath, aliasPath);
    assert.throws(() => restore(aliasPath), /activation target is invalid|unsafe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

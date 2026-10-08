import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWalletFile, verifyWalletFile } from "../blockchain/wallet-files.mjs";
import {
  createLocalTestWallet, listLocalTestWallets, openLocalTestWallet,
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
      storageRoot: join(root, "old-copy"), backupPath: created.backupPath,
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

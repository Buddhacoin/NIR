import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { recoveryBackupFingerprint, verifyRecoveryExportReceipt } from
  "../blockchain/wallet-backup-export-check.mjs";
import { createLocalTestWallet, renewLocalTestRecoveryCode } from "../blockchain/wallet-onboarding.mjs";

test("export receipt accepts only a matching v2 backup for the created address", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-backup-export-"));
  try {
    const created = createLocalTestWallet({ storageRoot: join(root, "profile"),
      password: "test-only-12" });
    const exported = join(root, "exported.nirvault.json");
    const digest = recoveryBackupFingerprint(created.backupPath, created.address);
    copyFileSync(created.backupPath, exported);
    const receipt = { backupExported: true, backupPath: exported };
    assert.deepEqual(verifyRecoveryExportReceipt(receipt, created.backupPath,
      digest, created.address), { verified: true, unsafePermissions: false });
    chmodSync(exported, 0o644);
    assert.deepEqual(verifyRecoveryExportReceipt(receipt, created.backupPath,
      digest, created.address), { verified: true, unsafePermissions: true });
    chmodSync(exported, 0o600);
    chmodSync(created.backupPath, 0o644);
    assert.throws(() => recoveryBackupFingerprint(created.backupPath, created.address),
      /private file/);
    chmodSync(created.backupPath, 0o600);
    assert.throws(() => verifyRecoveryExportReceipt(null, created.backupPath,
      digest, created.address), /not verified/);
    assert.throws(() => verifyRecoveryExportReceipt({ backupExported: false,
      backupPath: exported }, created.backupPath, digest, created.address), /not verified/);
    assert.throws(() => verifyRecoveryExportReceipt({ backupExported: true,
      backupPath: created.backupPath }, created.backupPath, digest, created.address), /not verified/);
    assert.throws(() => recoveryBackupFingerprint(join(root, "missing.nirvault.json"),
      created.address));
    assert.throws(() => recoveryBackupFingerprint(created.backupPath,
      `nir1${"0".repeat(64)}`), /mismatch/);
    writeFileSync(exported, "", { mode: 0o600 });
    assert.throws(() => verifyRecoveryExportReceipt(receipt, created.backupPath,
      digest, created.address));
    copyFileSync(created.backupPath, exported);
    const bytes = readFileSync(exported);
    bytes[bytes.length - 3] ^= 1;
    writeFileSync(exported, bytes);
    assert.throws(() => verifyRecoveryExportReceipt(receipt, created.backupPath,
      digest, created.address));
    const other = createLocalTestWallet({ storageRoot: join(root, "other"),
      password: "test-only-12" });
    copyFileSync(other.backupPath, exported);
    assert.throws(() => verifyRecoveryExportReceipt(receipt, created.backupPath,
      digest, created.address), /mismatch/);
    const renewed = renewLocalTestRecoveryCode({ storageRoot: join(root, "profile"),
      walletPath: created.walletPath, password: "test-only-12" });
    assert.equal(renewed.address, created.address);
    copyFileSync(renewed.backupPath, exported);
    assert.throws(() => verifyRecoveryExportReceipt(receipt, created.backupPath,
      digest, created.address), /changed during export/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

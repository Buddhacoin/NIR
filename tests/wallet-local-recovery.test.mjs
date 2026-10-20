import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet } from "../blockchain/crypto.mjs";
import { changeWalletFilePassword, createWalletFile, restoreRecoveryCodeWalletBackup, verifyWalletFile } from "../blockchain/wallet-files.mjs";
import {
  changeLocalTestWalletPassword, createLocalTestWallet, createWalletWithRecoveryDrill,
  listLocalTestWallets, openLocalTestWallet,
  renewLocalTestRecoveryCode, restoreLocalTestWalletWithRecoveryCode,
} from "../blockchain/wallet-onboarding.mjs";
import { encryptWallet, validPassword, validPersonalWalletPassword } from "../blockchain/vault.mjs";

test("password change accepts a readable legacy regular-file vault", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-local-legacy-password-"));
  const storageRoot = join(root, "wallet");
  const walletDirectory = join(storageRoot, "Wallets");
  const walletPath = join(walletDirectory, "legacy.nirvault.json");
  const oldPassword = "old-legacy-password-2026";
  const newPassword = "aB7!xK2#q";
  try {
    mkdirSync(walletDirectory, { recursive: true, mode: 0o700 });
    const wallet = generateWallet();
    const address = wallet.address;
    const vault = encryptWallet(wallet, oldPassword, { label: "Legacy test wallet", personalWallet: true });
    wallet.privateKey = "";
    writeFileSync(walletPath, `${JSON.stringify(vault)}\n`, { mode: 0o600, flag: "wx" });
    assert.equal(verifyWalletFile({ path: walletPath, password: oldPassword }).address, address);
    assert.throws(() => changeLocalTestWalletPassword({ storageRoot, walletPath,
      oldPassword: "incorrect-old-password-2026", newPassword }), /invalid/);
    assert.throws(() => changeLocalTestWalletPassword({ storageRoot, walletPath,
      oldPassword, newPassword: "short" }), /password/i);
    assert.equal(lstatSync(walletPath).isFile(), true);
    assert.equal(verifyWalletFile({ path: walletPath, password: oldPassword }).address, address);
    assert.equal(readdirSync(walletDirectory).filter((name) => name.includes(".nir-legacy-")).length, 0);
    assert.equal(changeLocalTestWalletPassword({ storageRoot, walletPath,
      oldPassword, newPassword }).address, address);
    assert.equal(verifyWalletFile({ path: walletPath, password: newPassword }).address, address);
    assert.throws(() => verifyWalletFile({ path: walletPath, password: oldPassword }), /invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("crash before legacy activation leaves the old regular vault readable", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-legacy-before-activation-"));
  const path = join(root, "legacy.nirvault.json");
  const oldPassword = "legacy-old-password-2026";
  const newPassword = "aB7!xK2#q";
  try {
    const wallet = generateWallet();
    const address = wallet.address;
    const vault = encryptWallet(wallet, oldPassword, { personalWallet: true });
    wallet.privateKey = "";
    writeFileSync(path, `${JSON.stringify(vault)}\n`, { mode: 0o600, flag: "wx" });
    const source = new URL("../blockchain/wallet-files.mjs", import.meta.url).href;
    const code = `import { changeWalletFilePassword } from ${JSON.stringify(source)};
      changeWalletFilePassword({ path: process.argv[1], oldPassword: ${JSON.stringify(oldPassword)},
        newPassword: ${JSON.stringify(newPassword)}, personalWallet: true,
        _afterLegacyBackup: () => process.exit(73) });`;
    const crash = spawnSync(process.execPath, ["--input-type=module", "-e", code, path],
      { encoding: "utf8", timeout: 20_000 });
    assert.equal(crash.status, 73, crash.stderr);
    assert.equal(lstatSync(path).nlink, 1);
    assert.equal(verifyWalletFile({ path, password: oldPassword }).address, address);
    assert.throws(() => verifyWalletFile({ path, password: newPassword }), /invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failure after legacy activation preserves the old encrypted recovery copy", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-legacy-after-activation-"));
  const path = join(root, "legacy.nirvault.json");
  const oldPassword = "legacy-old-password-2026";
  const newPassword = "aB7!xK2#q";
  try {
    const wallet = generateWallet();
    const address = wallet.address;
    const vault = encryptWallet(wallet, oldPassword, { personalWallet: true });
    wallet.privateKey = "";
    writeFileSync(path, `${JSON.stringify(vault)}\n`, { mode: 0o600, flag: "wx" });
    assert.throws(() => changeWalletFilePassword({ path, oldPassword, newPassword,
      personalWallet: true, _afterActivate: () => { throw new Error("simulated failure"); } }),
    (error) => error.code === "NIR_WALLET_PASSWORD_CHANGE_UNCERTAIN");
    assert.equal(verifyWalletFile({ path, password: newPassword }).address, address);
    const copies = readdirSync(root).filter((name) => name.includes(".nir-legacy-"));
    assert.equal(copies.length, 1);
    assert.equal(verifyWalletFile({ path: join(root, copies[0]), password: oldPassword }).address, address);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

test("local password change keeps the same address and old recovery backup usable", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-local-password-rotation-"));
  const storageRoot = join(root, "wallet");
  const oldPassword = "old-password-2026";
  const newPassword = "aB7!xK2#q";
  try {
    const created = createLocalTestWallet({ storageRoot, password: oldPassword });
    assert.throws(() => changeLocalTestWalletPassword({ storageRoot,
      walletPath: created.walletPath, oldPassword: "wrong-password-2026", newPassword }),
      { code: "NIR_WALLET_CURRENT_OPEN_FAILED" });
    assert.equal(verifyWalletFile({ path: created.walletPath, password: oldPassword }).address,
      created.address);
    assert.throws(() => changeLocalTestWalletPassword({ storageRoot,
      walletPath: created.walletPath, oldPassword, newPassword: "Abcdef123４" }),
      { code: "NIR_WALLET_NEW_PASSWORD_POLICY" });
    assert.equal(verifyWalletFile({ path: created.walletPath, password: oldPassword }).address,
      created.address);
    const changed = changeLocalTestWalletPassword({ storageRoot,
      walletPath: created.walletPath, oldPassword, newPassword });
    assert.equal(changed.address, created.address);
    assert.equal(verifyWalletFile({ path: created.walletPath, password: newPassword }).address,
      created.address);
    assert.throws(() => verifyWalletFile({ path: created.walletPath,
      password: oldPassword }), /invalid/);
    assert.throws(() => changeLocalTestWalletPassword({ storageRoot,
      walletPath: join(root, "other.nirvault.json"), oldPassword, newPassword }), /not in/);
    const restored = restoreLocalTestWalletWithRecoveryCode({ storageRoot: join(root, "restored"),
      backupPath: created.backupPath, expectedAddress: created.address,
      recoveryCode: created.recoveryCode, newPassword: "restore-password-2026" });
    assert.equal(restored.address, created.address);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("nine-character personal passwords are usable while trivial PINs and high-value creation stay rejected", () => {
  const password = "aB7!xK2#q";
  assert.equal([...password].length, 9);
  assert.equal(validPersonalWalletPassword(password), true);
  assert.equal(validPassword(password, { creation: true }), false);
  for (const weak of ["123456789", "987654321", "password1", "qwerty123", "aaaaa1111", "abcdefghi",
    "aB7!xK2#", "aB7!xK2#q\n"]) {
    assert.equal(validPersonalWalletPassword(weak), false, weak);
  }
  const root = mkdtempSync(join(tmpdir(), "nir-local-nine-policy-"));
  try {
    const local = createLocalTestWallet({ storageRoot: join(root, "personal"), password });
    assert.equal(verifyWalletFile({ path: local.walletPath, password }).address, local.address);
    assert.throws(() => createWalletFile({ path: join(root, "high-value.nirvault.json"),
      password }), /at least 16 characters/);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

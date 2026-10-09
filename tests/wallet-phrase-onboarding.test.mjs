import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listLocalTestWallets, createLocalPhraseWallet,
  restoreLocalPhraseWallet } from "../blockchain/wallet-onboarding.mjs";
import { verifyWalletFile } from "../blockchain/wallet-files.mjs";

test("words restore a local test wallet on a clean device with a new password and no backup file", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-phrase-onboarding-"));
  try {
    const firstRoot = join(root, "first-device");
    const secondRoot = join(root, "second-device");
    const first = createLocalPhraseWallet({ storageRoot: firstRoot,
      password: "test-password-one" });
    assert.equal(first.phrase.split(" ").length, 24);
    assert.equal(first.address, verifyWalletFile({ path: first.walletPath,
      password: "test-password-one" }).address);
    assert.equal(existsSync(join(firstRoot, "Backups")), false);
    const restored = restoreLocalPhraseWallet({ storageRoot: secondRoot,
      phrase: first.phrase, newPassword: "test-password-two" });
    assert.equal(restored.address, first.address);
    assert.equal(verifyWalletFile({ path: restored.walletPath,
      password: "test-password-two" }).address, first.address);
    assert.deepEqual(listLocalTestWallets(secondRoot).map((wallet) => wallet.address),
      [first.address]);
    const secondAccount = restoreLocalPhraseWallet({ storageRoot: secondRoot,
      phrase: first.phrase, newPassword: "test-password-two", accountIndex: 1 });
    assert.notEqual(secondAccount.address, first.address);
    assert.equal(listLocalTestWallets(secondRoot).length, 2);
    assert.equal(existsSync(join(secondRoot, "Backups")), false);
    assert.throws(() => restoreLocalPhraseWallet({ storageRoot: secondRoot,
      phrase: first.phrase, newPassword: "test-password-two" }),
    /already exists/);
    assert.equal(listLocalTestWallets(secondRoot).length, 2);
    assert.throws(() => verifyWalletFile({ path: restored.walletPath,
      password: "test-password-one" }), /password|decrypt|authentication|invalid/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("wrong words are rejected before creating any restored wallet storage", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-phrase-invalid-"));
  try {
    const target = join(root, "new-device");
    assert.throws(() => restoreLocalPhraseWallet({ storageRoot: target,
      phrase: "abandon ".repeat(23) + "zoo", newPassword: "test-password-two" }),
    /checksum/);
    assert.equal(existsSync(target), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

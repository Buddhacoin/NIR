import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addLocalSeedAccount, createLocalSeedWallet, hasLocalSeed, restoreLocalSeedWallet,
  revealLocalSeedPhrase } from "../blockchain/wallet-seed-accounts.mjs";
import { listLocalTestWallets } from "../blockchain/wallet-onboarding.mjs";
import { walletFromMnemonic } from "../blockchain/wallet-seed.mjs";

const PASSWORD = "seed-accounts-password-2026";

test("one recovery phrase makes many accounts, can be viewed again, and restores them in order", () => {
  const mac = mkdtempSync(join(tmpdir(), "nir-seed-mac-"));
  const otherMac = mkdtempSync(join(tmpdir(), "nir-seed-other-"));
  try {
    assert.equal(hasLocalSeed(mac), false);
    const first = createLocalSeedWallet({ storageRoot: mac, password: PASSWORD });
    assert.equal(first.phrase.split(" ").length, 24);
    assert.equal(first.accountIndex, 0);
    assert.equal(first.address, walletFromMnemonic(first.phrase, 0).address);
    assert.throws(() => createLocalSeedWallet({ storageRoot: mac, password: PASSWORD }), /already has a recovery phrase/);
    // The words are stored only encrypted.
    const file = readFileSync(join(mac, "Seed", "seed.nirseed.json"), "utf8");
    for (const word of first.phrase.split(" ")) assert.equal(file.includes(` ${word} `), false);

    const second = addLocalSeedAccount({ storageRoot: mac, password: PASSWORD });
    const third = addLocalSeedAccount({ storageRoot: mac, password: PASSWORD });
    assert.deepEqual([second.accountIndex, third.accountIndex], [1, 2]);
    assert.equal(third.address, walletFromMnemonic(first.phrase, 2).address);
    assert.throws(() => addLocalSeedAccount({ storageRoot: mac, password: "wrong-password-2026" }), /password is incorrect/);
    assert.equal(revealLocalSeedPhrase({ storageRoot: mac, password: PASSWORD }), first.phrase);
    assert.throws(() => revealLocalSeedPhrase({ storageRoot: mac, password: "wrong-password-2026" }), /incorrect/);

    // Another Mac: the same words bring back the same accounts in order.
    const restored = restoreLocalSeedWallet({ storageRoot: otherMac, phrase: `  ${first.phrase.toUpperCase()} `,
      password: "another-mac-password-2026" });
    assert.equal(restored.address, first.address);
    assert.equal(addLocalSeedAccount({ storageRoot: otherMac, password: "another-mac-password-2026" }).address,
      second.address);
    assert.deepEqual(listLocalTestWallets(otherMac).map(({ address }) => address).sort(),
      [first.address, second.address].sort());
    assert.throws(() => restoreLocalSeedWallet({ storageRoot: otherMac, password: PASSWORD,
      phrase: "abandon ".repeat(23) + "zoo" }), /checksum|different recovery phrase/);
  } finally {
    rmSync(mac, { recursive: true, force: true });
    rmSync(otherMac, { recursive: true, force: true });
  }
});

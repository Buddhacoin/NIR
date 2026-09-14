import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet } from "../blockchain/crypto.mjs";
import { createMultisigRecoveryManifest, decryptWallet, encryptWallet } from "../blockchain/vault.mjs";
import { createVaultSet, verifyVaultSet } from "../blockchain/vault-files.mjs";

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

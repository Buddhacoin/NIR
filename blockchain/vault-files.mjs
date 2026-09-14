import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { generateWallet } from "./crypto.mjs";
import {
  createMultisigRecoveryManifest,
  decryptWallet,
  encryptWallet,
} from "./vault.mjs";

const VAULT_FILENAMES = ["guardian-1.nirvault.json", "guardian-2.nirvault.json", "guardian-3.nirvault.json"];

function writeExclusiveJson(path, value, mode) {
  const descriptor = openSync(path, "wx", mode);
  try {
    fchmodSync(descriptor, mode);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
  } finally {
    closeSync(descriptor);
  }
}

function assertPasswords(passwords) {
  if (
    !Array.isArray(passwords) || passwords.length !== 3 ||
    passwords.some((password) => typeof password !== "string" || password.length < 16) ||
    new Set(passwords).size !== passwords.length
  ) throw new Error("three distinct passwords of at least 16 characters are required");
}

export function createVaultSet({ directory, passwords, threshold = 2, label = "NIR founder vault" }) {
  assertPasswords(passwords);
  const target = resolve(directory);
  mkdirSync(target, { mode: 0o700 });
  chmodSync(target, 0o700);
  const vaults = passwords.map((password, index) => {
    const wallet = generateWallet();
    return encryptWallet(wallet, password, { label: `${label} / guardian ${index + 1}` });
  });
  const manifest = {
    ...createMultisigRecoveryManifest({ vaults, threshold, label }),
    files: VAULT_FILENAMES.map((file, index) => ({ address: vaults[index].address, file })),
  };
  vaults.forEach((vault, index) => writeExclusiveJson(join(target, VAULT_FILENAMES[index]), vault, 0o600));
  writeExclusiveJson(join(target, "recovery-manifest.json"), manifest, 0o600);

  // Fail before reporting success if any freshly written backup cannot decrypt.
  vaults.forEach((vault, index) => {
    const restored = decryptWallet(
      JSON.parse(readFileSync(join(target, VAULT_FILENAMES[index]), "utf8")),
      passwords[index],
    );
    if (restored.address !== vault.address) throw new Error("fresh vault verification failed");
  });
  return manifest;
}

export function verifyVaultSet({ directory, passwords }) {
  assertPasswords(passwords);
  const target = resolve(directory);
  const manifest = JSON.parse(readFileSync(join(target, "recovery-manifest.json"), "utf8"));
  const listedFiles = manifest.files?.map(({ file }) => file);
  if (
    !Array.isArray(listedFiles) || listedFiles.length !== VAULT_FILENAMES.length ||
    !VAULT_FILENAMES.every((file) => listedFiles.includes(file)) ||
    new Set(listedFiles).size !== listedFiles.length
  ) throw new Error("recovery manifest contains an invalid vault file set");
  const vaults = manifest.files.map(({ file }) =>
    JSON.parse(readFileSync(join(target, file), "utf8")),
  );
  vaults.forEach((vault, index) => decryptWallet(vault, passwords[index]));
  const expected = createMultisigRecoveryManifest({
    vaults,
    threshold: manifest.threshold,
    label: manifest.label,
  });
  if (
    expected.address !== manifest.address ||
    JSON.stringify(expected.members) !== JSON.stringify(manifest.members)
  ) throw new Error("vault set does not match its recovery manifest");
  return { address: manifest.address, threshold: manifest.threshold, verified: true };
}

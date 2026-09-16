import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { createTransfer } from "./chain.mjs";
import { addressFromPublicKey, generateWallet } from "./crypto.mjs";
import { decryptWallet, encryptWallet } from "./vault.mjs";

function readVault(path) {
  const target = resolve(path);
  const metadata = lstatSync(target);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024 ||
      (metadata.mode & 0o077) !== 0) {
    throw new Error("wallet vault must be a private bounded regular file");
  }
  return JSON.parse(readFileSync(target, "utf8"));
}

export function createWalletFile({ path, password, label = "NIR wallet" }) {
  const target = resolve(path);
  const vault = encryptWallet(generateWallet(), password, { label });
  const descriptor = openSync(target, "wx", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(vault, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  chmodSync(target, 0o600);
  return { address: vault.address, algorithm: vault.algorithm, path: target };
}

export function walletPublicInfo(path) {
  const vault = readVault(path);
  if (vault?.format !== "nir-encrypted-vault" || typeof vault.address !== "string" ||
      addressFromPublicKey(vault.publicKey) !== vault.address) {
    throw new Error("file is not a NIR wallet vault");
  }
  return { address: vault.address, algorithm: vault.algorithm, label: vault.label };
}

export function signWalletTransfer({ path, password, networkId, recipient, amount, nonce, fee }) {
  const wallet = decryptWallet(readVault(path), password);
  try {
    return createTransfer({
      wallet, networkId, recipient, amount, nonce,
      ...(fee === undefined ? {} : { fee }),
    });
  } finally {
    wallet.privateKey = "";
  }
}

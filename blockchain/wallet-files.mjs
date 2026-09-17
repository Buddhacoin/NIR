import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  createCreditDelegation,
  createCreditStake,
  createCreditUnstakeClaim,
  createCreditUnstakeRequest,
  createTransfer,
} from "./chain.mjs";
import { addressFromPublicKey, generateWallet } from "./crypto.mjs";
import { createPaymentRequest } from "./payment-request.mjs";
import { createSignedHistoryArchive } from "./archive-sync.mjs";
import { createSignedBackupReceipt } from "./backup-recovery.mjs";
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
  return {
    address: vault.address,
    algorithm: vault.algorithm,
    label: vault.label,
    publicKey: vault.publicKey,
  };
}

export function verifyWalletFile({ path, password }) {
  const wallet = decryptWallet(readVault(path), password);
  try {
    return { ...walletPublicInfo(path), verified: true };
  } finally {
    wallet.privateKey = "";
  }
}

export function copyVerifiedWalletFile({ sourcePath, targetPath, password }) {
  const source = resolve(sourcePath);
  const target = resolve(targetPath);
  if (source === target) throw new Error("wallet backup target must be a new file");
  const vault = readVault(source);
  const wallet = decryptWallet(vault, password);
  let created = false;
  try {
    const parent = lstatSync(dirname(target));
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new Error("wallet backup parent must be a regular directory");
    }
    const descriptor = openSync(target, "wx", 0o600);
    created = true;
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, `${JSON.stringify(vault, null, 2)}\n`, "utf8");
    } finally {
      closeSync(descriptor);
    }
    chmodSync(target, 0o600);
    const copied = verifyWalletFile({ path: target, password });
    if (copied.address !== wallet.address) throw new Error("wallet backup verification failed");
    return { ...copied, path: target };
  } catch (error) {
    if (created) rmSync(target, { force: true });
    throw error;
  } finally {
    wallet.privateKey = "";
  }
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

export function signWalletResourceOperation({ path, password, operation }) {
  const wallet = decryptWallet(readVault(path), password);
  try {
    const common = { wallet, networkId: operation.networkId, nonce: operation.nonce };
    if (operation.type === "credit-stake") {
      return createCreditStake({ ...common, amount: operation.amount, fee: operation.fee });
    }
    if (operation.type === "credit-delegation") {
      return createCreditDelegation({
        ...common, delegate: operation.delegate, limit: operation.limit, fee: operation.fee,
      });
    }
    if (operation.type === "credit-unstake-request") {
      return createCreditUnstakeRequest({ ...common, amount: operation.amount });
    }
    if (operation.type === "credit-unstake-claim") {
      return createCreditUnstakeClaim(common);
    }
    throw new Error("wallet resource operation is not supported");
  } finally {
    wallet.privateKey = "";
  }
}

export function signWalletPaymentRequest({ path, password, intent }) {
  const wallet = decryptWallet(readVault(path), password);
  try {
    return createPaymentRequest({ wallet, ...intent });
  } finally {
    wallet.privateKey = "";
  }
}

export function signWalletHistoryArchive({ path, password, directory, chain, options }) {
  const wallet = decryptWallet(readVault(path), password);
  try {
    return createSignedHistoryArchive(directory, chain, wallet, options);
  } finally {
    wallet.privateKey = "";
  }
}

export function signWalletBackupReceipt({ path, password, directory, genesis, options }) {
  const wallet = decryptWallet(readVault(path), password);
  try {
    return createSignedBackupReceipt(directory, genesis, wallet, options);
  } finally {
    wallet.privateKey = "";
  }
}

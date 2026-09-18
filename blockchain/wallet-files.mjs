import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import {
  createCreditDelegation,
  createCreditStake,
  createCreditUnstakeClaim,
  createCreditUnstakeRequest,
  createTransfer,
} from "./chain.mjs";
import { addressFromPublicKey, generateWallet, hashObject } from "./crypto.mjs";
import { createPaymentRequest } from "./payment-request.mjs";
import { createSignedHistoryArchive } from "./archive-sync.mjs";
import { createSignedBackupReceipt } from "./backup-recovery.mjs";
import { decryptWallet, encryptWallet } from "./vault.mjs";

const MAX_PRIVATE_JSON_BYTES = 64 * 1024;
const NETWORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function privateGenerationPattern(target) {
  return new RegExp(`^\\.${escapeRegex(basename(target))}\\.nir-private-[0-9a-f]{32}$`);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function secureOpenFlags(directory = false) {
  if (!constants.O_NOFOLLOW || (directory && !constants.O_DIRECTORY)) {
    throw new Error("secure no-follow file operations are unavailable");
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0);
}

function readPrivateJson(path, description) {
  const target = resolve(path);
  const activation = lstatSync(target);
  if (activation.isSymbolicLink() && activation.nlink !== 1) {
    throw new Error(`${description} activation is unsafe`);
  }
  let source = target;
  let link = null;
  if (activation.isSymbolicLink()) {
    link = realpathSafeLink(target);
    source = join(dirname(target), link);
  }
  let descriptor;
  try {
    descriptor = openSync(source, secureOpenFlags());
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 ||
        before.size > MAX_PRIVATE_JSON_BYTES || (before.mode & 0o077) !== 0 ||
        before.uid !== lstatSync(dirname(source)).uid) {
      throw new Error(`${description} must be a private bounded unlinked regular file`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        bytes.length !== before.size) throw new Error(`${description} changed while it was read`);
    const linked = lstatSync(source);
    if (!linked.isFile() || linked.isSymbolicLink() || !sameIdentity(linked, before)) {
      throw new Error(`${description} changed while it was read`);
    }
    if (link !== null) {
      const current = lstatSync(target);
      if (!current.isSymbolicLink() || !sameIdentity(current, activation) ||
          readlinkSync(target) !== link) throw new Error(`${description} activation changed`);
    }
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${description} is invalid or unsafe`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function realpathSafeLink(target) {
  const link = readlinkSync(target);
  if (!privateGenerationPattern(target).test(link)) {
    throw new Error("wallet private-file activation target is invalid");
  }
  return link;
}

function capturePrivateActivation(path) {
  const target = resolve(path);
  const activation = lstatSync(target);
  const link = realpathSafeLink(target);
  const generation = join(dirname(target), link);
  const generationIdentity = lstatSync(generation);
  if (!activation.isSymbolicLink() || activation.nlink !== 1 ||
      !generationIdentity.isFile() || generationIdentity.isSymbolicLink()) {
    throw new Error("wallet private-file activation is unsafe");
  }
  return { activation, generation, generationIdentity, link, target };
}

function removePrivateActivation(created) {
  const current = lstatSync(created.target);
  if (!current.isSymbolicLink() || !sameIdentity(current, created.activation) ||
      readlinkSync(created.target) !== created.link) return;
  unlinkSync(created.target);
  const generation = lstatSync(created.generation);
  if (generation.isFile() && !generation.isSymbolicLink() &&
      sameIdentity(generation, created.generationIdentity)) unlinkSync(created.generation);
}

function writePrivateJsonExclusive(path, value, { _beforeActivate } = {}) {
  const requestedTarget = resolve(path);
  const parentPath = realpathSync(dirname(requestedTarget));
  const target = join(parentPath, basename(requestedTarget));
  const parentBefore = lstatSync(parentPath);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error("wallet destination parent must be a direct regular directory");
  }
  const parentDescriptor = openSync(parentPath, secureOpenFlags(true));
  const parentIdentity = fstatSync(parentDescriptor);
  const generation = join(parentPath,
    `.${basename(target)}.nir-private-${randomBytes(16).toString("hex")}`);
  let generationCreated = false;
  let generationIdentity = null;
  let activationIdentity = null;
  try {
    const descriptor = openSync(generation, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    generationCreated = true;
    generationIdentity = fstatSync(descriptor);
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const parentAfterWrite = lstatSync(parentPath);
    if (parentAfterWrite.dev !== parentIdentity.dev || parentAfterWrite.ino !== parentIdentity.ino) {
      throw new Error("wallet destination parent changed during write");
    }
    const linkedGeneration = lstatSync(generation);
    if (!generationIdentity.isFile() || !sameIdentity(generationIdentity, linkedGeneration) ||
        linkedGeneration.isSymbolicLink() || generationIdentity.nlink !== 1 ||
        (generationIdentity.mode & 0o777) !== 0o600) {
      throw new Error("wallet private-file generation is unsafe");
    }
    if (_beforeActivate !== undefined) {
      if (typeof _beforeActivate !== "function") throw new Error("wallet activation hook is invalid");
      _beforeActivate({ generation, target });
    }
    const parentBeforeActivate = lstatSync(parentPath);
    const parentDescriptorBeforeActivate = fstatSync(parentDescriptor);
    const generationBeforeActivate = lstatSync(generation);
    if (!sameIdentity(parentBeforeActivate, parentIdentity) ||
        !sameIdentity(parentDescriptorBeforeActivate, parentIdentity) ||
        !sameIdentity(generationBeforeActivate, generationIdentity) ||
        !generationBeforeActivate.isFile() || generationBeforeActivate.isSymbolicLink()) {
      throw new Error("wallet private-file paths changed before activation");
    }
    symlinkSync(basename(generation), target, "file");
    activationIdentity = lstatSync(target);
    if (!activationIdentity.isSymbolicLink() || readlinkSync(target) !== basename(generation)) {
      throw new Error("wallet private-file activation is inconsistent");
    }
    fsyncSync(parentDescriptor);
    const activated = lstatSync(target);
    if (!activated.isSymbolicLink() || !sameIdentity(activated, activationIdentity) ||
        readlinkSync(target) !== basename(generation)) {
      throw new Error("wallet private-file activation changed");
    }
  } catch (error) {
    if (activationIdentity !== null) {
      try {
        const current = lstatSync(target);
        if (current.isSymbolicLink() && sameIdentity(current, activationIdentity) &&
            readlinkSync(target) === basename(generation)) unlinkSync(target);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") error.activationCleanupError = cleanupError.message;
      }
    }
    if (generationCreated && generationIdentity !== null) {
      try {
        const current = lstatSync(generation);
        if (current.isFile() && !current.isSymbolicLink() && sameIdentity(current, generationIdentity)) {
          rmSync(generation, { force: true });
        }
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") error.generationCleanupError = cleanupError.message;
      }
    }
    throw error;
  } finally {
    closeSync(parentDescriptor);
  }
  return target;
}

function readVault(path) {
  return readPrivateJson(path, "wallet vault");
}

export function createWalletFile({ path, password, label = "NIR wallet", _beforeActivate }) {
  const target = resolve(path);
  const wallet = generateWallet();
  let vault;
  try {
    vault = encryptWallet(wallet, password, { label });
  } finally {
    wallet.privateKey = "";
  }
  writePrivateJsonExclusive(target, vault, { _beforeActivate });
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
  const vault = readVault(path);
  const wallet = decryptWallet(vault, password);
  try {
    return {
      address: vault.address, algorithm: vault.algorithm, label: vault.label,
      publicKey: vault.publicKey, verified: true,
    };
  } finally {
    wallet.privateKey = "";
  }
}

export function createVerifiedWalletBackup({
  sourcePath, targetPath, password, networkId, generation,
}) {
  if (!NETWORK_ID.test(networkId ?? "") || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("wallet backup requires an exact network and positive generation");
  }
  const source = resolve(sourcePath);
  const target = resolve(targetPath);
  if (source === target) throw new Error("wallet backup target must be a new file");
  const vault = readVault(source);
  const wallet = decryptWallet(vault, password);
  let created = null;
  try {
    const backup = {
      address: wallet.address,
      format: "nir-wallet-backup-v1",
      generation,
      networkId,
      vault,
      vaultHash: hashObject(vault, "WALLET_BACKUP_VAULT"),
      version: 1,
    };
    writePrivateJsonExclusive(target, backup);
    created = capturePrivateActivation(target);
    const copied = readPrivateJson(target, "wallet backup");
    if (hashObject(copied.vault, "WALLET_BACKUP_VAULT") !== copied.vaultHash) {
      throw new Error("wallet backup verification failed");
    }
    return { address: wallet.address, generation, networkId, path: target, verified: true };
  } catch (error) {
    if (created !== null) {
      try { removePrivateActivation(created); }
      catch (cleanupError) { error.activationCleanupError = cleanupError.message; }
    }
    throw error;
  } finally {
    wallet.privateKey = "";
  }
}

export function restoreVerifiedWalletBackup({
  sourcePath, targetPath, password, networkId, expectedAddress, minimumGeneration, _afterActivate,
}) {
  if (!NETWORK_ID.test(networkId ?? "") || !/^nir1[0-9a-f]{64}$/.test(expectedAddress ?? "") ||
      !Number.isSafeInteger(minimumGeneration) || minimumGeneration < 1) {
    throw new Error("wallet restore requires network, address, and minimum generation anchors");
  }
  const backup = readPrivateJson(sourcePath, "wallet backup");
  if (!exactKeys(backup, ["address", "format", "generation", "networkId", "vault", "vaultHash", "version"]) ||
      backup.format !== "nir-wallet-backup-v1" || backup.version !== 1 ||
      backup.networkId !== networkId || backup.address !== expectedAddress ||
      !Number.isSafeInteger(backup.generation) || backup.generation < minimumGeneration ||
      hashObject(backup.vault, "WALLET_BACKUP_VAULT") !== backup.vaultHash) {
    throw new Error("wallet backup context, generation, or integrity is invalid");
  }
  const wallet = decryptWallet(backup.vault, password);
  let created = null;
  try {
    if (wallet.address !== expectedAddress) throw new Error("wallet backup address is invalid");
    writePrivateJsonExclusive(targetPath, backup.vault);
    created = capturePrivateActivation(targetPath);
    if (_afterActivate !== undefined) {
      if (typeof _afterActivate !== "function") throw new Error("wallet restore hook is invalid");
      _afterActivate({ target: resolve(targetPath) });
    }
    const restored = verifyWalletFile({ path: targetPath, password });
    if (restored.address !== expectedAddress) throw new Error("wallet restore verification failed");
    return {
      ...restored, generation: backup.generation, networkId, path: resolve(targetPath),
    };
  } catch (error) {
    if (created !== null) {
      try { removePrivateActivation(created); }
      catch (cleanupError) { error.activationCleanupError = cleanupError.message; }
    }
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
      return createCreditUnstakeRequest({ ...common, amount: operation.amount, fee: operation.fee });
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

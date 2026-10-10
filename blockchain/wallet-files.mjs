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
  renameSync,
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
import { createValidatorAdmission } from "./validator-admission.mjs";
import { decryptWallet, encryptWallet } from "./vault.mjs";
import { walletFromMnemonic } from "./wallet-seed.mjs";

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
  return BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino);
}

function sameActivationVersion(left, right) {
  return sameIdentity(left, right) && left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs;
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
    throw new Error(`${description} is invalid or unsafe`);
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
  const activation = lstatSync(target, { bigint: true });
  const link = realpathSafeLink(target);
  const generation = join(dirname(target), link);
  const generationIdentity = lstatSync(generation);
  if (!activation.isSymbolicLink() || activation.nlink !== 1n ||
      !generationIdentity.isFile() || generationIdentity.isSymbolicLink()) {
    throw new Error("wallet private-file activation is unsafe");
  }
  return { activation, generation, generationIdentity, link, target };
}

function removePrivateActivation(created) {
  const current = lstatSync(created.target, { bigint: true });
  if (!current.isSymbolicLink() || !sameActivationVersion(current, created.activation) ||
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

export function createWalletFile({ path, password, label = "NIR wallet", personalWallet = false,
  _beforeActivate }) {
  const target = resolve(path);
  const wallet = generateWallet();
  let vault;
  try {
    vault = encryptWallet(wallet, password, { label, personalWallet });
  } finally {
    wallet.privateKey = "";
  }
  writePrivateJsonExclusive(target, vault, { _beforeActivate });
  return { address: vault.address, algorithm: vault.algorithm, path: target };
}

export function createPhraseWalletFile({ path, password, phrase, accountIndex = 0,
  label = "NIR phrase wallet", _beforeActivate }) {
  const target = resolve(path);
  const wallet = walletFromMnemonic(phrase, accountIndex);
  let vault;
  try {
    vault = encryptWallet(wallet, password, { label, personalWallet: true });
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

// Rotate only the active local vault. Exported backups are independent copies and
// remain usable with their original recovery factors; this is not key rotation.
export function changeWalletFilePassword({ path, oldPassword, newPassword,
  personalWallet = false, _beforeActivate }) {
  const target = resolve(path);
  const directory = dirname(target);
  const lock = join(directory, `.${basename(target)}.nir-password-rotation.lock`);
  const parentDescriptor = openSync(directory, secureOpenFlags(true));
  let lockDescriptor;
  let lockIdentity;
  try {
    lockDescriptor = openSync(lock, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    lockIdentity = fstatSync(lockDescriptor);
    fchmodSync(lockDescriptor, 0o600);
    fsyncSync(parentDescriptor);
  } catch (error) {
    if (lockDescriptor !== undefined) {
      closeSync(lockDescriptor);
      try {
        const current = lstatSync(lock);
        if (sameIdentity(current, lockIdentity) && current.isFile() &&
            !current.isSymbolicLink()) unlinkSync(lock);
      } catch { /* Preserve the original error; a stale lock fails closed. */ }
    }
    closeSync(parentDescriptor);
    if (error?.code === "EEXIST") {
      const locked = new Error("wallet password rotation lock exists (EEXIST); close other wallet processes and inspect before recovery", { cause: error });
      locked.code = "NIR_WALLET_PASSWORD_CHANGE_LOCKED";
      throw locked;
    }
    throw error;
  }
  try {
    return changeWalletFilePasswordLocked({ path: target, oldPassword, newPassword,
      personalWallet, _beforeActivate });
  } finally {
    let cleanupError;
    try {
      closeSync(lockDescriptor);
      const current = lstatSync(lock);
      if (sameIdentity(current, lockIdentity) && current.isFile() &&
          !current.isSymbolicLink()) {
        unlinkSync(lock);
        fsyncSync(parentDescriptor);
      } else {
        throw new Error("wallet password rotation lock changed");
      }
    } catch (error) { cleanupError = error; }
    try { closeSync(parentDescriptor); }
    catch (error) { cleanupError ??= error; }
    if (cleanupError) {
      const uncertain = new Error("wallet password change may have activated; reopen and verify the address",
        { cause: cleanupError });
      uncertain.code = "NIR_WALLET_PASSWORD_CHANGE_UNCERTAIN";
      throw uncertain;
    }
  }
}

function changeWalletFilePasswordLocked({ path, oldPassword, newPassword,
  personalWallet, _beforeActivate }) {
  if (oldPassword === newPassword) throw new Error("new wallet password must differ");
  const original = capturePrivateActivation(path);
  const oldVault = readVault(path);
  const oldWallet = decryptWallet(oldVault, oldPassword);
  let replacement;
  try {
    replacement = encryptWallet(oldWallet, newPassword,
      { label: oldVault.label, personalWallet });
  } finally { oldWallet.privateKey = ""; }
  if (replacement.address !== oldVault.address ||
      replacement.publicKey !== oldVault.publicKey) {
    throw new Error("wallet identity changed during password rotation");
  }

  const directory = dirname(original.target);
  const parentDescriptor = openSync(directory, secureOpenFlags(true));
  const parentIdentity = fstatSync(parentDescriptor);
  const generation = join(directory,
    `.${basename(original.target)}.nir-private-${randomBytes(16).toString("hex")}`);
  const activation = join(directory,
    `.${basename(original.target)}.nir-activation-${randomBytes(16).toString("hex")}`);
  let generationIdentity = null;
  let activated = false;
  try {
    const descriptor = openSync(generation, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    generationIdentity = fstatSync(descriptor);
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, `${JSON.stringify(replacement, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    const staged = readPrivateJson(generation, "replacement wallet vault");
    const verified = decryptWallet(staged, newPassword);
    try {
      if (verified.address !== oldVault.address || verified.publicKey !== oldVault.publicKey) {
        throw new Error("replacement wallet identity changed");
      }
    } finally { verified.privateKey = ""; }
    if (_beforeActivate !== undefined) {
      if (typeof _beforeActivate !== "function") throw new Error("wallet activation hook is invalid");
      _beforeActivate({ generation, target: original.target });
    }
    const current = capturePrivateActivation(original.target);
    if (!sameActivationVersion(current.activation, original.activation) ||
        !sameIdentity(current.generationIdentity, original.generationIdentity) ||
        current.link !== original.link ||
        !sameIdentity(fstatSync(parentDescriptor), parentIdentity) ||
        !sameIdentity(lstatSync(directory), parentIdentity)) {
      throw new Error("wallet activation changed during password rotation");
    }
    symlinkSync(basename(generation), activation, "file");
    renameSync(activation, original.target);
    activated = true;
    fsyncSync(parentDescriptor);
    const currentVault = verifyWalletFile({ path: original.target, password: newPassword });
    if (currentVault.address !== oldVault.address) {
      throw new Error("activated wallet identity changed");
    }
    const oldGeneration = lstatSync(original.generation);
    if (!sameIdentity(oldGeneration, original.generationIdentity) ||
        !oldGeneration.isFile() || oldGeneration.isSymbolicLink()) {
      throw new Error("old wallet generation changed after activation");
    }
    unlinkSync(original.generation);
    fsyncSync(parentDescriptor);
    return { address: currentVault.address, path: original.target };
  } catch (error) {
    if (activated) {
      const uncertain = new Error("wallet password change may have activated; reopen and verify the address", { cause: error });
      uncertain.code = "NIR_WALLET_PASSWORD_CHANGE_UNCERTAIN";
      throw uncertain;
    }
    try { unlinkSync(activation); } catch (cleanup) {
      if (cleanup?.code !== "ENOENT") error.activationCleanupError = cleanup.message;
    }
    if (generationIdentity) {
      try {
        const current = lstatSync(generation);
        if (sameIdentity(current, generationIdentity) && current.isFile() &&
            !current.isSymbolicLink()) unlinkSync(generation);
      } catch (cleanup) {
        if (cleanup?.code !== "ENOENT") error.generationCleanupError = cleanup.message;
      }
    }
    throw error;
  } finally { closeSync(parentDescriptor); }
}

export function signValidatorAdmissionWithWalletFiles({
  consensusPath, consensusPassword, intent, transportPath, transportPassword,
}) {
  let consensusWallet;
  let transportWallet;
  try {
    consensusWallet = decryptWallet(readVault(consensusPath), consensusPassword);
    transportWallet = decryptWallet(readVault(transportPath), transportPassword);
    if (consensusWallet.address === transportWallet.address) {
      throw new Error("validator admission identities must be distinct");
    }
    return createValidatorAdmission({
      amount: intent.amount,
      chainIdentityGenesisHash: intent.chainIdentityGenesisHash,
      endpoint: intent.endpoint,
      fee: intent.fee,
      networkId: intent.networkId,
      nonce: intent.nonce,
      operatorId: intent.operatorId,
      referenceHeight: intent.referenceHeight,
      tlsCertificateSha256: intent.tlsCertificateSha256,
      transportWallet,
      validUntilHeight: intent.validUntilHeight,
      wallet: consensusWallet,
    });
  } finally {
    if (consensusWallet) consensusWallet.privateKey = "";
    if (transportWallet) transportWallet.privateKey = "";
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

function canonicalRecoveryCode(value) {
  if (typeof value !== "string" || !/^[0-9A-Fa-f -]{40,64}$/.test(value)) {
    throw new Error("recovery code is invalid");
  }
  const compact = value.replace(/[ -]/g, "").toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(compact)) throw new Error("recovery code is invalid");
  return compact;
}

export function createRecoveryCodeWalletBackup({
  sourcePath, targetPath, password, recoveryCode, networkId, generation,
}) {
  if (!NETWORK_ID.test(networkId ?? "") || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("wallet recovery backup requires an exact network and positive generation");
  }
  const code = canonicalRecoveryCode(recoveryCode);
  if (resolve(sourcePath) === resolve(targetPath)) throw new Error("backup must use a new file");
  const wallet = decryptWallet(readVault(sourcePath), password);
  let created = null;
  try {
    const recoveryVault = encryptWallet(wallet, code, { label: "NIR recovery-only vault" });
    const backup = {
      address: wallet.address,
      format: "nir-wallet-recovery-backup-v2",
      generation,
      networkId,
      protection: "independent-recovery-code",
      vault: recoveryVault,
      vaultHash: hashObject(recoveryVault, "WALLET_RECOVERY_VAULT"),
      version: 2,
    };
    writePrivateJsonExclusive(targetPath, backup);
    created = capturePrivateActivation(targetPath);
    const copied = readPrivateJson(targetPath, "wallet recovery backup");
    if (hashObject(copied.vault, "WALLET_RECOVERY_VAULT") !== copied.vaultHash) {
      throw new Error("wallet recovery backup verification failed");
    }
    return { address: wallet.address, generation, networkId, path: resolve(targetPath), verified: true };
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

export function walletRecoveryBackupPublicInfo(path) {
  const backup = readPrivateJson(path, "wallet recovery backup");
  if (!exactKeys(backup, ["address", "format", "generation", "networkId", "protection",
    "vault", "vaultHash", "version"]) ||
      backup.format !== "nir-wallet-recovery-backup-v2" || backup.version !== 2 ||
      backup.protection !== "independent-recovery-code" ||
      !Number.isSafeInteger(backup.generation) || backup.generation < 1 ||
      !NETWORK_ID.test(backup.networkId ?? "") ||
      hashObject(backup.vault, "WALLET_RECOVERY_VAULT") !== backup.vaultHash ||
      addressFromPublicKey(backup.vault?.publicKey) !== backup.address) {
    throw new Error("wallet recovery backup is invalid");
  }
  return { address: backup.address, generation: backup.generation,
    networkId: backup.networkId };
}

export function restoreRecoveryCodeWalletBackup({
  sourcePath, targetPath, recoveryCode, newPassword, networkId,
  expectedAddress, minimumGeneration = 1,
}) {
  if (!NETWORK_ID.test(networkId ?? "") || !/^nir1[0-9a-f]{64}$/.test(expectedAddress ?? "") ||
      !Number.isSafeInteger(minimumGeneration) || minimumGeneration < 1) {
    throw new Error("wallet recovery requires network, address, and generation anchors");
  }
  const code = canonicalRecoveryCode(recoveryCode);
  const backup = readPrivateJson(sourcePath, "wallet recovery backup");
  if (!exactKeys(backup, ["address", "format", "generation", "networkId", "protection",
    "vault", "vaultHash", "version"]) ||
      backup.format !== "nir-wallet-recovery-backup-v2" || backup.version !== 2 ||
      backup.protection !== "independent-recovery-code" ||
      backup.networkId !== networkId || backup.address !== expectedAddress ||
      !Number.isSafeInteger(backup.generation) || backup.generation < minimumGeneration ||
      hashObject(backup.vault, "WALLET_RECOVERY_VAULT") !== backup.vaultHash) {
    throw new Error("wallet recovery backup context, generation, or integrity is invalid");
  }
  const wallet = decryptWallet(backup.vault, code);
  let created = null;
  try {
    if (wallet.address !== expectedAddress) throw new Error("wallet recovery address is invalid");
    const newVault = encryptWallet(wallet, newPassword, {
      label: "NIR test wallet", personalWallet: true,
    });
    writePrivateJsonExclusive(targetPath, newVault);
    created = capturePrivateActivation(targetPath);
    const verified = verifyWalletFile({ path: targetPath, password: newPassword });
    if (verified.address !== expectedAddress) throw new Error("wallet recovery verification failed");
    return { ...verified, generation: backup.generation, networkId, path: resolve(targetPath) };
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

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  createVerifiedWalletBackup,
  createRecoveryCodeWalletBackup,
  createWalletFile,
  restoreRecoveryCodeWalletBackup,
  restoreVerifiedWalletBackup,
  verifyWalletFile,
  walletPublicInfo,
  walletRecoveryBackupPublicInfo,
} from "./wallet-files.mjs";
import { validPersonalWalletPassword } from "./vault.mjs";

const NETWORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function target(path, label) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) {
    throw new Error(`${label} must be an absolute path`);
  }
  const resolved = resolve(path);
  if (!resolved.endsWith(".nirvault.json")) {
    throw new Error(`${label} must end in .nirvault.json`);
  }
  if (existsSync(resolved)) throw new Error(`${label} already exists`);
  return resolved;
}

function validateNetwork(networkId) {
  if (!NETWORK_ID.test(networkId ?? "")) throw new Error("network ID is invalid");
}

export function createWalletWithRecoveryDrill({ walletPath, backupPath, networkId, password,
  recoveryCode, personalWallet = false }) {
  validateNetwork(networkId);
  const wallet = target(walletPath, "wallet destination");
  const backup = target(backupPath, "backup destination");
  if (wallet === backup || realpathSync(dirname(wallet)) === realpathSync(dirname(backup))) {
    throw new Error("wallet and backup must be in different directories");
  }
  // Check both destinations before creating the wallet. The file layer still
  // performs exclusive, no-follow writes to defend against races.
  const created = createWalletFile({ path: wallet, password, label: "NIR test wallet", personalWallet });
  try {
    const verified = verifyWalletFile({ path: wallet, password });
    if (created.address !== verified.address) throw new Error("created wallet identity changed");
    const copy = recoveryCode === undefined ? createVerifiedWalletBackup({
      sourcePath: wallet, targetPath: backup, password, networkId, generation: 1,
    }) : createRecoveryCodeWalletBackup({
      sourcePath: wallet, targetPath: backup, password, recoveryCode, networkId, generation: 1,
    });
    const drillDirectory = mkdtempSync(join(tmpdir(), "nir-wallet-recovery-drill-"));
    try {
      const recovered = recoveryCode === undefined ? restoreVerifiedWalletBackup({
        sourcePath: backup, targetPath: join(drillDirectory, "recovered.nirvault.json"),
        password, networkId, expectedAddress: created.address, minimumGeneration: 1,
      }) : restoreRecoveryCodeWalletBackup({
        sourcePath: backup, targetPath: join(drillDirectory, "recovered.nirvault.json"),
        recoveryCode, newPassword: randomBytes(20).toString("hex"), networkId,
        expectedAddress: created.address, minimumGeneration: 1,
      });
      if (recovered.address !== created.address || copy.address !== created.address) {
        throw new Error("recovery drill address differs from the created wallet");
      }
    } finally {
      rmSync(drillDirectory, { recursive: true, force: true });
    }
    return { address: created.address, backupPath: backup, networkId, walletPath: wallet,
      backupGeneration: 1, recoveryDrillPassed: true,
      ...(recoveryCode === undefined ? {} : { recoveryCode }),
    };
  } catch (cause) {
    // The primary file exists. Never delete the only copy of the new private key
    // merely because backup or drill failed; expose a precise recovery path.
    const error = new Error(`Кошелёк создан, но резервная копия не проверена. Адрес: ${created.address}. Файл: ${wallet}. Не удаляйте файл. Откройте этот адрес с тем же паролем и создайте новую резервную копию и код. Не используйте адрес для средств до проверки копии.`, { cause });
    error.code = "NIR_WALLET_RECOVERY_INCOMPLETE";
    error.address = created.address;
    error.walletPath = wallet;
    error.backupPath = backup;
    throw error;
  }
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error("wallet storage directory is not private");
  }
}

export function listLocalTestWallets(storageRoot) {
  if (typeof storageRoot !== "string" || !storageRoot.startsWith("/")) {
    throw new Error("wallet storage root must be absolute");
  }
  const directory = join(resolve(storageRoot), "Wallets");
  if (!existsSync(directory)) return [];
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("wallet storage directory is not private");
  }
  const candidates = readdirSync(directory).filter((name) => name.endsWith(".nirvault.json"))
    .flatMap((name) => {
      const path = join(directory, name);
      try { return [{ address: walletPublicInfo(path).address, path,
        modifiedAt: lstatSync(path).mtimeMs }]; }
      catch { return []; } // A damaged entry must never become a selectable account.
    });
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt ||
    left.path.localeCompare(right.path));
  // A restored copy can use a different password for the same address. Keep
  // each private file selectable; address de-duplication could hide the only
  // copy whose password its owner still knows.
  return candidates.map(({ address, path }) => ({ address, path }));
}

export function openLocalTestWallet({ wallets, path, password }) {
  if (!Array.isArray(wallets) || typeof path !== "string" ||
      typeof password !== "string" || password.length === 0) {
    throw new Error("wallet selection and password are required");
  }
  const selected = wallets.find((wallet) => wallet?.path === path);
  if (!selected) throw new Error("selected wallet is not in the local account list");
  const verified = verifyWalletFile({ path, password });
  if (verified.address !== selected.address) {
    throw new Error("selected wallet identity changed");
  }
  return { address: verified.address, walletPath: path };
}

export function listLocalTestBackups(storageRoot) {
  if (typeof storageRoot !== "string" || !storageRoot.startsWith("/")) {
    throw new Error("wallet storage root must be absolute");
  }
  const directory = join(resolve(storageRoot), "Backups");
  if (!existsSync(directory)) return [];
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("wallet backup directory is not private");
  }
  return readdirSync(directory).filter((name) => name.endsWith(".nirvault.json"))
    .sort().flatMap((name) => {
      const path = join(directory, name);
      try {
        const backup = walletRecoveryBackupPublicInfo(path);
        return backup.networkId === "nir-local-rehearsal"
          ? [{ address: backup.address, path }] : [];
      } catch { return []; }
    });
}

export function createLocalTestWallet({ storageRoot, password }) {
  if (!validPersonalWalletPassword(password)) {
    throw new Error("wallet password does not meet creation requirements");
  }
  if (typeof storageRoot !== "string" || !storageRoot.startsWith("/")) {
    throw new Error("wallet storage root must be absolute");
  }
  const root = resolve(storageRoot);
  const walletDirectory = join(root, "Wallets");
  const backupDirectory = join(root, "Backups");
  for (const directory of [root, walletDirectory, backupDirectory]) privateDirectory(directory);
  const id = randomUUID();
  const recoveryCode = randomBytes(20).toString("hex").toUpperCase().match(/.{5}/g).join("-");
  return createWalletWithRecoveryDrill({
    walletPath: join(walletDirectory, `${id}.nirvault.json`),
    backupPath: join(backupDirectory, `${id}.nirvault.json`),
    networkId: "nir-local-rehearsal", password, recoveryCode, personalWallet: true,
  });
}

export function restoreLocalTestWalletWithRecoveryCode({ storageRoot, backupPath,
  expectedAddress, recoveryCode, newPassword }) {
  if (typeof storageRoot !== "string" || !storageRoot.startsWith("/")) {
    throw new Error("wallet storage root must be absolute");
  }
  const root = resolve(storageRoot);
  const walletDirectory = join(root, "Wallets");
  privateDirectory(root);
  privateDirectory(walletDirectory);
  const restored = restoreRecoveryCodeWalletBackup({
    sourcePath: backupPath,
    targetPath: join(walletDirectory, `${randomUUID()}.nirvault.json`),
    recoveryCode, newPassword,
    networkId: "nir-local-rehearsal", expectedAddress, minimumGeneration: 1,
  });
  return { address: restored.address, networkId: restored.networkId,
    walletPath: restored.path, backupGeneration: restored.generation,
    recoveryDrillPassed: true };
}

export function renewLocalTestRecoveryCode({ storageRoot, walletPath, password }) {
  if (typeof storageRoot !== "string" || !storageRoot.startsWith("/")) {
    throw new Error("wallet storage root must be absolute");
  }
  const root = resolve(storageRoot);
  const backupDirectory = join(root, "Backups");
  privateDirectory(root);
  privateDirectory(backupDirectory);
  const verified = verifyWalletFile({ path: walletPath, password });
  const recoveryCode = randomBytes(20).toString("hex").toUpperCase().match(/.{5}/g).join("-");
  const backupPath = join(backupDirectory, `${randomUUID()}.nirvault.json`);
  const created = createRecoveryCodeWalletBackup({
    sourcePath: walletPath, targetPath: backupPath, password, recoveryCode,
    networkId: "nir-local-rehearsal", generation: 1,
  });
  if (created.address !== verified.address) throw new Error("wallet address changed during backup");
  return { address: created.address, backupPath, recoveryCode };
}

export function restoreLocalTestWallet({ storageRoot, backupPath, expectedAddress, password }) {
  if (typeof storageRoot !== "string" || !storageRoot.startsWith("/")) {
    throw new Error("wallet storage root must be absolute");
  }
  const walletDirectory = join(resolve(storageRoot), "Wallets");
  privateDirectory(resolve(storageRoot));
  privateDirectory(walletDirectory);
  return restoreWalletFromBackup({
    backupPath,
    walletPath: join(walletDirectory, `${randomUUID()}.nirvault.json`),
    networkId: "nir-local-rehearsal",
    expectedAddress,
    password,
  });
}

export function restoreWalletFromBackup({ backupPath, walletPath, networkId,
  expectedAddress, password, minimumGeneration = 1 }) {
  validateNetwork(networkId);
  const destination = target(walletPath, "restored wallet destination");
  const restored = restoreVerifiedWalletBackup({
    sourcePath: backupPath, targetPath: destination, password, networkId,
    expectedAddress, minimumGeneration,
  });
  const verified = verifyWalletFile({ path: destination, password });
  if (verified.address !== expectedAddress || restored.address !== expectedAddress) {
    throw new Error("restored wallet identity differs from the recorded address");
  }
  return { address: expectedAddress, networkId, walletPath: destination,
    backupGeneration: restored.generation, recoveryDrillPassed: true };
}

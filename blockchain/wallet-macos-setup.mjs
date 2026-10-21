#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { inspectLocalTestWallets, listLocalTestBackups, openLocalTestWallet, renewLocalTestRecoveryCode, restoreLocalTestWalletWithRecoveryCode } from "./wallet-onboarding.mjs";
import { recoveryBackupFingerprint, verifyRecoveryExportReceipt } from "./wallet-backup-export-check.mjs";
import { walletSetupNotice } from "./wallet-macos-notices.mjs";
import { addLocalSeedAccount, createLocalSeedWallet, hasLocalSeed, restoreLocalSeedWallet }
  from "./wallet-seed-accounts.mjs";

const ONBOARDING = fileURLToPath(new URL("../../../MacOS/onboarding", import.meta.url));
const STORAGE_ROOT = join(homedir(), "Library", "Application Support", "NIR Wallet");

if (process.platform !== "darwin") {
  process.stderr.write("NIR wallet setup requires macOS.\n");
  process.exitCode = 1;
} else {
  function dialog(script, args = []) {
    // No password is placed in command arguments or echoed to stdout. The
    // hidden-answer dialog returns it only through this local child pipe.
    const output = execFileSync("/usr/bin/osascript", ["-e", script, ...args], {
      encoding: "utf8", maxBuffer: 8 * 1024, timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.replace(/\r?\n$/, "");
  }

  function notice(title, message) {
    dialog(`on run argv\n display alert (item 1 of argv) message (item 2 of argv) buttons {"OK"}\nend run`,
      [title, message]);
  }

  let unseenRecoveryAddress = null;
  let currentLanguage = "ru";
  try {
    const createOnly = process.argv[2] === "--create-only";
    if (process.argv.length > (createOnly ? 3 : 2)) throw new Error("unsupported wallet setup arguments");
    const inventory = inspectLocalTestWallets(STORAGE_ROOT);
    const availableWallets = inventory.wallets;
    const availableBackups = listLocalTestBackups(STORAGE_ROOT);
    let result;
    let preferredPath;
    // A Mac with no wallet yet can come back from the 24 words written down
    // on another one.
    if (!createOnly && availableWallets.length === 0 && !hasLocalSeed(STORAGE_ROOT)) {
      const english = currentLanguage === "en";
      const start = dialog(`on run argv\n set answer to display dialog (item 1 of argv) buttons {(item 2 of argv), (item 3 of argv)} default button (item 3 of argv)\n return button returned of answer\nend run`,
        [english ? "Welcome to NIR Wallet. Do you already have 24 secret words from another NIR Wallet?"
          : "Добро пожаловать в NIR Wallet. У вас уже есть 24 секретных слова от другого NIR Wallet?",
        english ? "Restore from 24 words" : "Восстановить по 24 словам",
        english ? "New wallet" : "Новый кошелёк"]);
      if (start === (english ? "Restore from 24 words" : "Восстановить по 24 словам")) {
        const phrase = dialog(`on run argv\n set answer to display dialog (item 1 of argv) default answer "" buttons {"OK"} default button "OK"\n return text returned of answer\nend run`,
          [english ? "Type the 24 words separated by spaces, in order." : "Введите 24 слова через пробел, по порядку."]);
        const password = dialog(`on run argv\n set answer to display dialog (item 1 of argv) default answer "" with hidden answer buttons {"OK"} default button "OK"\n return text returned of answer\nend run`,
          [english ? "Choose a password for this Mac (at least 9 characters)." : "Придумайте пароль для этого Mac (не короче 9 символов)."]);
        result = restoreLocalSeedWallet({ storageRoot: STORAGE_ROOT, phrase, password });
      }
    }
    while (!result) {
      const output = execFileSync(ONBOARDING, [], {
        input: JSON.stringify({ wallets: availableWallets, backups: availableBackups,
          hasUnrecognizedWalletFiles: inventory.unrecognizedWalletFiles > 0,
          createOnly, ...(preferredPath ? { preferredPath } : {}) }),
        encoding: "utf8", maxBuffer: 8 * 1024, timeout: 600_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const choice = JSON.parse(output);
      if (!choice || !["create", "restore", "open", "renew"].includes(choice.mode)) {
        throw new Error("invalid onboarding selection");
      }
      if (choice.language !== "ru" && choice.language !== "en") {
        throw new Error("invalid onboarding language");
      }
      currentLanguage = choice.language;
      if (createOnly && choice.mode !== "create") {
        throw new Error("new-account wizard did not create an account");
      }
      if (choice.mode === "create" && hasLocalSeed(STORAGE_ROOT)) {
        // The next account from the same 24 words: nothing new to write down.
        try {
          result = addLocalSeedAccount({ storageRoot: STORAGE_ROOT, password: choice.password });
        } catch (error) {
          if (error?.message !== "wallet password is incorrect") throw error;
          notice(currentLanguage === "en" ? "Wrong password" : "Неверный пароль", currentLanguage === "en"
            ? "A new account uses the same password as your wallet. Enter that password."
            : "Новый счёт создаётся с тем же паролем, что и кошелёк. Введите пароль кошелька.");
        }
      } else if (choice.mode === "create") {
        // A new wallet starts from 24 words that restore all its accounts.
        result = createLocalSeedWallet({ storageRoot: STORAGE_ROOT, password: choice.password });
        unseenRecoveryAddress = result.address;
        execFileSync(ONBOARDING, ["--show-secret"], {
          input: JSON.stringify({ kind: "phrase", secret: result.phrase }),
          encoding: "utf8", maxBuffer: 8 * 1024, timeout: 600_000, stdio: ["pipe", "pipe", "pipe"],
        });
        unseenRecoveryAddress = null;
        result.phrase = "";
      } else if (choice.mode === "renew") {
        const opened = openLocalTestWallet({ wallets: availableWallets,
          path: choice.path, password: choice.password });
        const renewed = renewLocalTestRecoveryCode({ storageRoot: STORAGE_ROOT,
          walletPath: opened.walletPath, password: choice.password });
        unseenRecoveryAddress = opened.address;
        const fingerprint = recoveryBackupFingerprint(renewed.backupPath, renewed.address);
        const exportReceipt = execFileSync(ONBOARDING, ["--show-secret"], {
          input: JSON.stringify({ kind: "recovery", secret: renewed.recoveryCode,
            backupPath: renewed.backupPath }),
          encoding: "utf8", maxBuffer: 8 * 1024, timeout: 600_000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const verification = verifyRecoveryExportReceipt(JSON.parse(exportReceipt), renewed.backupPath,
          fingerprint, renewed.address);
        unseenRecoveryAddress = null;
        try { const copy = walletSetupNotice("recovery-renewal", currentLanguage, verification);
          notice(copy.title, copy.message); }
        catch { /* The verified export is complete even if this notice is closed. */ }
        result = opened;
      } else if (choice.mode === "restore") {
        const listed = availableBackups.find((backup) => backup.path === choice.path);
        if (listed && listed.address !== choice.address) {
          throw new Error("selected backup address changed");
        }
        result = restoreLocalTestWalletWithRecoveryCode({
          storageRoot: STORAGE_ROOT, backupPath: choice.path,
          expectedAddress: choice.address, recoveryCode: choice.recoveryCode,
          newPassword: choice.newPassword,
        });
      } else {
        try {
          result = openLocalTestWallet({ wallets: availableWallets,
            path: choice.path, password: choice.password });
        } catch (error) {
          if (error?.message !== "vault password, contents, or integrity check is invalid") throw error;
          preferredPath = choice.path;
          const copy = walletSetupNotice("open-failed", currentLanguage);
          notice(copy.title, copy.message);
        }
      }
    }
    process.stdout.write(`${JSON.stringify({ address: result.address, walletPath: result.walletPath })}\n`);
  } catch (error) {
    const cancelled = error?.status === 2 || String(error?.stderr ?? "").includes("User canceled") ||
      String(error?.stderr ?? "").includes("-128") ||
      String(error?.message ?? "").includes("User canceled");
    if (!cancelled || unseenRecoveryAddress) {
      const message = unseenRecoveryAddress
        ? walletSetupNotice("incomplete-recovery", currentLanguage,
          { address: unseenRecoveryAddress }).message
        : String(error?.message ?? "unknown error").slice(0, 500);
      try { notice(currentLanguage === "en" ? "Setup did not finish" : "Настройка не завершена", message); }
      catch { /* The user may have closed all dialogs. */ }
      process.stderr.write("NIR test wallet setup did not complete.\n");
      process.exitCode = 1;
    } else {
      process.exitCode = 2;
    }
  }
}

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { addLocalPhraseAccount, findLocalPhraseProfile, listLocalTestWallets, openLocalTestWallet,
  renewLocalTestRecoveryCode, restoreLocalPhraseWallet } from "./wallet-onboarding.mjs";
import { recoveryBackupFingerprint, verifyRecoveryExportReceipt } from "./wallet-backup-export-check.mjs";
import { mnemonicFromEntropy } from "./wallet-seed.mjs";
import { validPersonalWalletPassword } from "./vault.mjs";

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
  try {
    const createOnly = process.argv[2] === "--create-only";
    if (process.argv.length > (createOnly ? 4 : 2)) throw new Error("unsupported wallet setup arguments");
    const createOnlyAddress = createOnly ? process.argv[3] : null;
    if (createOnly && !/^nir1[0-9a-f]{64}$/.test(createOnlyAddress ?? "")) {
      throw new Error("existing NIR address is required to add an account");
    }
    const availableWallets = listLocalTestWallets(STORAGE_ROOT);
    let result;
    let preferredPath;
    while (!result) {
      const output = execFileSync(ONBOARDING, [], {
        input: JSON.stringify({ wallets: availableWallets, backups: [],
          createOnly, ...(preferredPath ? { preferredPath } : {}) }),
        encoding: "utf8", maxBuffer: 8 * 1024, timeout: 600_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const choice = JSON.parse(output);
      if (!choice || !["create", "restore", "open", "renew"].includes(choice.mode)) {
        throw new Error("invalid onboarding selection");
      }
      if (createOnly && choice.mode !== "create") {
        throw new Error("new-account wizard did not create an account");
      }
      if (choice.mode === "create") {
        if (!validPersonalWalletPassword(choice.password)) {
          throw new Error("Пароль кошелька не соответствует требованиям безопасности.");
        }
        if (createOnly) {
          const profile = findLocalPhraseProfile({ storageRoot: STORAGE_ROOT,
            address: createOnlyAddress, password: choice.password });
          if (!profile) throw new Error("Этот адрес не связан с фразой NIR на данном Mac.");
          result = addLocalPhraseAccount({ storageRoot: STORAGE_ROOT,
            profilePath: profile.path, password: choice.password });
        } else {
          const phrase = mnemonicFromEntropy();
          // No local wallet is written until the user has seen and confirmed
          // the phrase. It travels only in this private child-process pipe.
          const confirmation = execFileSync(ONBOARDING, ["--show-phrase"], {
            input: JSON.stringify({ phrase }),
            encoding: "utf8", maxBuffer: 8 * 1024, timeout: 600_000,
            stdio: ["pipe", "pipe", "pipe"],
          });
          if (JSON.parse(confirmation)?.phraseConfirmed !== true) {
            throw new Error("recovery phrase was not confirmed");
          }
          result = restoreLocalPhraseWallet({ storageRoot: STORAGE_ROOT,
            phrase, newPassword: choice.password });
        }
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
        try { notice("Резервная копия проверена",
          `Для восстановления этого адреса нужны зашифрованная копия и отдельный код. Старые копия и код продолжают действовать. Приложение не подтверждает физическую независимость хранилища.${verification.unsafePermissions ? " Внимание: выбранный носитель допускает чтение файла другими пользователями; храните копию в безопасном месте." : ""}`); }
        catch { /* The verified export is complete even if this notice is closed. */ }
        result = opened;
      } else if (choice.mode === "restore") {
        result = restoreLocalPhraseWallet({
          storageRoot: STORAGE_ROOT, phrase: choice.phrase,
          newPassword: choice.newPassword,
        });
      } else {
        try {
          result = openLocalTestWallet({ wallets: availableWallets,
            path: choice.path, password: choice.password });
        } catch (error) {
          if (error?.message !== "vault password, contents, or integrity check is invalid") throw error;
          preferredPath = choice.path;
          notice("Не удалось открыть кошелёк",
            "Проверьте пароль выбранного адреса. Если пароль верен, восстановите кошелёк из резервной копии.");
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
        ? `Кошелёк ${unseenRecoveryAddress} сохранён, но настройка резервной копии не завершена или не прошла проверку. Откройте этот адрес с паролем и нажмите «Новый код восстановления». Не используйте адрес для средств до сохранения зашифрованной копии и отдельного кода.`
        : String(error?.message ?? "unknown error").slice(0, 500);
      try { notice("Настройка не завершена", message); }
      catch { /* The user may have closed all dialogs. */ }
      process.stderr.write("NIR test wallet setup did not complete.\n");
      process.exitCode = 1;
    } else {
      process.exitCode = 2;
    }
  }
}

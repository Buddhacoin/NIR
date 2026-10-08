#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createLocalTestWallet, listLocalTestBackups, listLocalTestWallets, openLocalTestWallet, restoreLocalTestWalletWithRecoveryCode } from "./wallet-onboarding.mjs";

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

  try {
    const createOnly = process.argv[2] === "--create-only";
    if (process.argv.length > (createOnly ? 3 : 2)) throw new Error("unsupported wallet setup arguments");
    const availableWallets = listLocalTestWallets(STORAGE_ROOT);
    const availableBackups = listLocalTestBackups(STORAGE_ROOT);
    let result;
    let preferredPath;
    while (!result) {
      const output = execFileSync(ONBOARDING, [], {
        input: JSON.stringify({ wallets: availableWallets, backups: availableBackups,
          createOnly, ...(preferredPath ? { preferredPath } : {}) }),
        encoding: "utf8", maxBuffer: 8 * 1024, timeout: 600_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const choice = JSON.parse(output);
      if (!choice || !["create", "restore", "open"].includes(choice.mode)) {
        throw new Error("invalid onboarding selection");
      }
      if (createOnly && choice.mode !== "create") {
        throw new Error("new-account wizard did not create an account");
      }
      if (choice.mode === "create") {
        result = createLocalTestWallet({
          storageRoot: STORAGE_ROOT, password: choice.password,
        });
        execFileSync(ONBOARDING, ["--show-secret"], {
          input: JSON.stringify({ kind: "recovery", secret: result.recoveryCode,
            backupPath: result.backupPath }),
          encoding: "utf8", maxBuffer: 8 * 1024, timeout: 600_000,
          stdio: ["pipe", "pipe", "pipe"],
        });
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
    if (!cancelled) {
      try { notice("Настройка не завершена", String(error?.message ?? "unknown error").slice(0, 500)); }
      catch { /* The user may have closed all dialogs. */ }
      process.stderr.write("NIR test wallet setup did not complete.\n");
      process.exitCode = 1;
    } else {
      process.exitCode = 2;
    }
  }
}

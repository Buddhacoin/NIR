#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createWalletBridgeServer } from "./wallet-bridge.mjs";
import { walletPublicInfo } from "./wallet-files.mjs";
import { changeLocalTestWalletPassword, listLocalTestWallets,
  renewLocalTestRecoveryCode } from "./wallet-onboarding.mjs";
import { recoveryBackupFingerprint, verifyRecoveryExportReceipt } from "./wallet-backup-export-check.mjs";
import { createWalletPreviewServer } from "./wallet-preview-cli.mjs";
import { macLauncherPid, readUpdateRecord, removePreviousVersions, runBuilder, SourceUpdater, startSwap, UPDATE_RECORD,
  updateBuildEnvironment } from "./source-updater.mjs";
import { pinnedUpdateSignerAddress } from "./update-trust-anchor.mjs";
import { findOldCopies, revealOldCopies, trashOldCopies } from "./old-app-copies.mjs";
import { hasLocalSeed, revealLocalSeedPhrase } from "./wallet-seed-accounts.mjs";

const execFileAsync = promisify(execFile);
const BRIDGE_PORT = 8788;

function noTrailingNewline(value) { return value.replace(/\r?\n$/, ""); }

async function nativeDialog(script, args = [], signal) {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script, ...args], {
    encoding: "utf8", maxBuffer: 8 * 1024, timeout: 120_000, signal,
  });
  return noTrailingNewline(stdout);
}

async function notify(title, message) {
  return nativeDialog(`on run argv\n display alert (item 1 of argv) message (item 2 of argv) buttons {"OK"}\nend run`,
    [title, message]);
}

async function nativeLanguage() {
  try {
    const { stdout } = await execFileAsync("/usr/bin/defaults",
      ["read", "org.nir.wallet-setup-test", "language"], { encoding: "utf8", timeout: 2_000 });
    return stdout.trim() === "en" ? "en" : "ru";
  } catch { return "ru"; }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const failed = (error) => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", failed); resolve(); };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen(port, "127.0.0.1");
  });
}

async function authorizeSigning(intent, { signal } = {}) {
  const summary = intent.type === "local-iris-run-receipt" ? [
    "Подтвердить адресом хэш локального свидетельства Iris?",
    `Адрес: ${intent.address}`,
    `Nonce запуска: ${intent.nonce}`,
    `SHA-256 свидетельства: ${intent.evidenceDigest}`,
    `Hash пакета: ${intent.bundleHash}`,
    "Подпись привяжет адрес к байтам файла, но не докажет выполнение модели. Не заявка в сеть и не награда.",
    "Подписывайте, только если запускали Iris в Model Lab и сверили адрес и hash.",
  ].join("\n") : intent.type === "local-operator-wallet-link" ? [
    "NIR Model Lab просит подключить этот кошелёк.",
    `Адрес: ${intent.address}`,
    "Награды за майнинг будут приходить на этот адрес. Model Lab узнает только адрес: ни ключ, ни пароль не передаются, монеты не списываются.",
    "Отклоните, если вы не нажимали «Подключить NIR Wallet» в Model Lab.",
  ].join("\n") : [
    "Подписать операцию NIR?",
    `Тип: ${intent.type ?? "transfer"}`,
    `Сеть: ${intent.networkId}`,
    ...(intent.recipient ? [`Получатель: ${intent.recipient}`] : []),
    ...(intent.amount ? [`Сумма: ${intent.amount} atomic units`] : []),
    `Комиссия: ${intent.fee ?? "по правилам сети"}`,
    `Nonce: ${intent.nonce}`,
    `Запрос: ${intent.requestId}`,
    "Отклоните запрос, если вы его не начинали.",
  ].join("\n");
  try {
    const choice = await nativeDialog(`on run argv\n set answer to display dialog (item 1 of argv) buttons {"Отклонить", "Подписать"} default button "Отклонить" with icon caution\n return button returned of answer\nend run`,
      [summary], signal);
    if (choice !== "Подписать") return null;
    const password = await nativeDialog(`on run argv\n set answer to display dialog "Введите пароль кошелька для этой подписи." default answer "" with hidden answer buttons {"Отмена", "Продолжить"} default button "Продолжить"\n return text returned of answer\nend run`,
      [], signal);
    return signal?.aborted ? null : password;
  } catch {
    return null;
  }
}

function showNativeRecoveryCode(secret, backupPath, signal) {
  const executable = fileURLToPath(new URL("../../../MacOS/onboarding", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--show-secret"], { stdio: ["pipe", "pipe", "ignore"], signal });
    let receipt = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      receipt += chunk;
      if (receipt.length > 8192) child.kill("SIGTERM");
    });
    child.once("error", reject);
    child.once("close", (status) => {
      if (status !== 0 || receipt.length > 8192) return reject(new Error("recovery export was not completed"));
      try { resolve(JSON.parse(receipt)); }
      catch { reject(new Error("recovery export receipt is invalid")); }
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify({ kind: "recovery", secret, backupPath }));
  });
}

// Settings → "Show secret phrase": the 24 words, after the wallet password,
// in the Mac window only. Wallets made before phrases have none.
async function nativeRevealPhrase({ signal }) {
  const english = await nativeLanguage() === "en";
  const storageRoot = join(homedir(), "Library", "Application Support", "NIR Wallet");
  if (!hasLocalSeed(storageRoot)) return "no-phrase";
  const cancelLabel = english ? "Cancel" : "Отмена";
  const continueLabel = english ? "Show" : "Показать";
  try {
    const password = await nativeDialog(`on run argv\n set answer to display dialog (item 1 of argv) default answer "" with hidden answer buttons {(item 2 of argv), (item 3 of argv)} default button (item 3 of argv)\n return text returned of answer\nend run`,
      [english ? "Enter the wallet password to show the 24 secret words. Make sure nobody sees the screen."
        : "Введите пароль кошелька, чтобы показать 24 секретных слова. Убедитесь, что экран никто не видит.",
      cancelLabel, continueLabel], signal);
    if (signal?.aborted) return "cancelled";
    let phrase = revealLocalSeedPhrase({ storageRoot, password });
    const executable = fileURLToPath(new URL("../../../MacOS/onboarding", import.meta.url));
    await new Promise((resolve, reject) => {
      const child = spawn(executable, ["--show-secret"], { stdio: ["pipe", "ignore", "ignore"], signal });
      child.once("error", reject);
      child.once("close", resolve);
      child.stdin.on("error", reject);
      child.stdin.end(JSON.stringify({ kind: "phrase", secret: phrase }));
    });
    phrase = "";
    return "shown";
  } catch (error) {
    if (signal?.aborted || String(error?.message ?? "").includes("User canceled") ||
        String(error?.message ?? "").includes("-128")) return "cancelled";
    if (error?.message === "wallet password is incorrect") return "wrong-password";
    throw new Error("the secret phrase could not be shown");
  }
}

async function nativeSecurity({ vaultPath, signal }) {
  const english = await nativeLanguage() === "en";
  try {
    const continueLabel = english ? "Continue" : "Продолжить";
    const cancelLabel = english ? "Cancel" : "Отмена";
    const decision = await nativeDialog(`on run argv\n set answer to display alert (item 1 of argv) message (item 2 of argv) buttons {(item 3 of argv), (item 4 of argv)} default button (item 3 of argv) as warning\n return button returned of answer\nend run`,
      [english ? "Create a new recovery code?" : "Создать новый код восстановления?",
        english ? "Save the new code with its new encrypted backup. Old backups and codes still work. If they may have been exposed, create a new address and move funds." :
          "Новый код нужно сохранить с новой зашифрованной копией. Прежние копии и коды продолжат работать. Если они могли попасть к посторонним, создайте новый адрес и переведите на него средства.",
        cancelLabel, continueLabel], signal);
    if (decision !== continueLabel) return false;
    const password = await nativeDialog(`on run argv\n set answer to display dialog (item 1 of argv) default answer "" with hidden answer buttons {(item 2 of argv), (item 3 of argv)} default button (item 3 of argv)\n return text returned of answer\nend run`,
      [english ? "Enter this wallet's password." : "Введите пароль этого кошелька.",
        cancelLabel, continueLabel], signal);
    if (signal?.aborted) return false;
    const storageRoot = join(homedir(), "Library", "Application Support", "NIR Wallet");
    const renewed = renewLocalTestRecoveryCode({ storageRoot, walletPath: vaultPath, password });
    const fingerprint = recoveryBackupFingerprint(renewed.backupPath, renewed.address);
    if (signal?.aborted) return false;
    const receipt = await showNativeRecoveryCode(renewed.recoveryCode, renewed.backupPath, signal);
    if (signal?.aborted) return false;
    verifyRecoveryExportReceipt(receipt, renewed.backupPath, fingerprint, renewed.address);
    try { await notify(english ? "New backup verified" : "Новая копия проверена",
      english ? "Keep the new code separate from its encrypted backup. Old backups and codes remain valid." :
        "Храните новый код отдельно от зашифрованной копии. Старые копии и коды остаются действительными."); }
    catch { /* Verification is complete even if the user closes this notice. */ }
    return true;
  } catch (error) {
    if (signal?.aborted || String(error?.message ?? "").includes("User canceled") ||
        String(error?.message ?? "").includes("-128")) return false;
    try { await notify(english ? "Backup not completed" : "Не удалось завершить резервирование",
      english ? "Check the password and save the new code with its encrypted backup in the Mac window. Existing backups were not deleted." :
        "Проверьте пароль и сохраните код с новой зашифрованной копией в окне Mac. Существующие копии не удалены."); }
    catch { /* Keep the HTTP failure generic if the user closes this notice. */ }
    throw new Error("native recovery did not complete");
  }
}

async function nativePasswordChange({ vaultPath, signal }) {
  const english = await nativeLanguage() === "en";
  const cancel = english ? "Cancel" : "Отмена";
  const proceed = english ? "Continue" : "Продолжить";
  let committed = false;
  try {
    const decision = await nativeDialog(`on run argv\n set answer to display alert (item 1 of argv) message (item 2 of argv) buttons {(item 3 of argv), (item 4 of argv)} default button (item 3 of argv) as warning\n return button returned of answer\nend run`,
      [english ? "Change this wallet's password?" : "Сменить пароль этого кошелька?",
        english ? "This changes only the active encrypted file on this Mac. Earlier exported backups and recovery codes still grant access; a compromised key needs a new address." :
          "Изменится только активный зашифрованный файл на этом Mac. Ранее экспортированные копии и коды остаются действительными; если ключ раскрыт, нужен новый адрес.",
        cancel, proceed], signal);
    if (decision !== proceed || signal?.aborted) return false;
    const ask = (message) => nativeDialog(`on run argv\n set answer to display dialog (item 1 of argv) default answer "" with hidden answer buttons {(item 2 of argv), (item 3 of argv)} default button (item 3 of argv)\n return text returned of answer\nend run`,
      [message, cancel, proceed], signal);
    const oldPassword = await ask(english ? "Current wallet password" : "Текущий пароль кошелька");
    if (signal?.aborted) return false;
    const newPassword = await ask(english ? "New password: 9+ characters, 5 distinct, letter and digit or symbol" :
      "Новый пароль: от 9 символов, 5 разных, буква и цифра или знак");
    if (signal?.aborted) return false;
    const confirmation = await ask(english ? "Repeat the new password" : "Повторите новый пароль");
    if (signal?.aborted) return false;
    if (newPassword !== confirmation) {
      const error = new Error("new wallet passwords do not match");
      error.code = "NIR_WALLET_NEW_PASSWORD_MISMATCH";
      throw error;
    }
    const storageRoot = join(homedir(), "Library", "Application Support", "NIR Wallet");
    const before = walletPublicInfo(vaultPath).address;
    const changed = changeLocalTestWalletPassword({ storageRoot, walletPath: vaultPath,
      oldPassword, newPassword });
    committed = true;
    if (changed.address !== before || walletPublicInfo(vaultPath).address !== before) {
      throw new Error("wallet identity changed during password change");
    }
    return true;
  } catch (error) {
    if (!committed && (signal?.aborted || String(error?.message ?? "").includes("User canceled") ||
        String(error?.message ?? "").includes("-128"))) return false;
    const uncertain = committed || error?.code === "NIR_WALLET_PASSWORD_CHANGE_UNCERTAIN";
    const locked = error?.code === "NIR_WALLET_PASSWORD_CHANGE_LOCKED";
    const policy = error?.code === "NIR_WALLET_NEW_PASSWORD_POLICY";
    const currentOpenFailed = error?.code === "NIR_WALLET_CURRENT_OPEN_FAILED";
    const mismatch = error?.code === "NIR_WALLET_NEW_PASSWORD_MISMATCH";
    try { await notify(english ? "Password change needs checking" : "Проверьте смену пароля",
      uncertain ? (english ? "Reopen the wallet and verify the address and which password works. Do not delete any backup." :
        "Откройте кошелёк снова, проверьте адрес и какой пароль подходит. Не удаляйте резервные копии.") :
        locked ? (english ? "Another wallet process may be changing this file, or a previous change stopped unexpectedly. Close every NIR Wallet instance, confirm a verified backup, and seek diagnostics. Do not delete the lock manually." :
          "Возможно, другой процесс меняет файл или прежняя смена прервалась. Закройте все окна NIR Wallet, проверьте резервную копию и обратитесь за диагностикой. Не удаляйте блокировку вручную.") :
        policy ? (english ? "New password rejected: use 9 or more characters, at least 5 distinct characters, a letter and a digit or symbol. Avoid common prefixes, control characters and compatibility Unicode. This attempt did not replace the vault." :
          "Новый пароль отклонён: нужно от 9 символов, минимум 5 разных, буква и цифра или знак. Не используйте распространённое начало, управляющие символы и совместимые варианты Unicode. Эта попытка не заменила файл.") :
        currentOpenFailed ? (english ? "The selected vault could not be opened or verified. Check the current password, file access and integrity. This attempt did not replace the vault." :
          "Выбранный файл не удалось открыть или проверить. Проверьте текущий пароль, доступ к файлу и его целостность. Эта попытка не заменила файл.") :
        mismatch ? (english ? "The new password and confirmation differ. This attempt did not replace the vault." :
          "Новый пароль и повторный ввод не совпали. Эта попытка не заменила файл.") :
        (english ? "Password change could not be confirmed (PW-ROTATE). Reopen the wallet and check which password works; keep every backup and report this code." :
          "Не удалось подтвердить смену пароля (PW-ROTATE). Откройте кошелёк заново и проверьте, какой пароль подходит; сохраните все копии и сообщите этот код.")); }
    catch { /* Keep bridge response generic. */ }
    throw new Error("native password change did not complete");
  }
}

// The Update button: rebuild from the newest published version with the
// Node.js this app was first built with, then swap and reopen
// (docs/app-updates.md).
function createWalletUpdater() {
  const appPath = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
  let record = null;
  try { record = readUpdateRecord(fileURLToPath(new URL(`../../${UPDATE_RECORD}`, import.meta.url))); } catch {}
  removePreviousVersions(appPath);
  return new SourceUpdater({
    appPath, record, trustedAddress: pinnedUpdateSignerAddress,
    sourceDirectory: join(homedir(), "Library", "Application Support", "NIR Updates", "wallet.git"),
    build: (source, target, release) => runBuilder({ node: record.builderNode,
      script: join(source, "blockchain", "wallet-macos-build.mjs"), target,
      env: updateBuildEnvironment(release, record) }),
    restart: ({ stagedAppPath, backupPath }) => startSwap({ appPath, backupPath, stagedAppPath,
      launcherPid: macLauncherPid(appPath) }),
  });
}

async function main() {
  if (process.platform !== "darwin") throw new Error("this visual wallet runs on macOS only");
  const setup = fileURLToPath(new URL("./wallet-macos-setup.mjs", import.meta.url));
  const runner = fileURLToPath(new URL("../../../MacOS/wallet-runner", import.meta.url));
  const verifier = fileURLToPath(new URL("../../../MacOS/wallet-runtime-verifier", import.meta.url));
  const configuration = fileURLToPath(new URL("../../NIR-RUNTIME.json", import.meta.url));
  const runtime = JSON.parse(readFileSync(configuration, "utf8"));
  if (!(["nir-local-wallet-runtime-v2", "nir-local-wallet-runtime-v3"].includes(runtime?.format)) ||
      (runtime.format === "nir-local-wallet-runtime-v3"
        ? runtime.nodeExecutable !== "MacOS/node" ||
          process.execPath !== fileURLToPath(new URL("../../../MacOS/node", import.meta.url))
        : runtime.nodeExecutable !== process.execPath) ||
      !/^[0-9a-f]{64}$/.test(runtime.nodeSha256 ?? "")) {
    throw new Error("wallet runtime binding changed");
  }
  const runSetup = (...args) => execFileAsync(runner, [process.execPath, setup,
    runtime.nodeSha256, verifier, configuration, "--child-setup", ...args], {
    encoding: "utf8", maxBuffer: 8 * 1024, timeout: 600_000,
  });
  let setupOutput;
  try {
    ({ stdout: setupOutput } = await runSetup());
  } catch (error) {
    if (error.code === 2) return; // The user cancelled the native wizard.
    if (error.code === 1) { process.exitCode = 1; return; } // The wizard showed its own error.
    throw error;
  }
  const selected = JSON.parse(noTrailingNewline(setupOutput));
  const wallet = walletPublicInfo(selected.walletPath);
  if (selected.address !== wallet.address) throw new Error("wallet selection address changed");

  const storageRoot = join(homedir(), "Library", "Application Support", "NIR Wallet");
  const createAccount = async () => {
    const { stdout } = await runSetup("--create-only");
    const created = JSON.parse(noTrailingNewline(stdout));
    if (walletPublicInfo(created.walletPath).address !== created.address) {
      throw new Error("new wallet identity changed");
    }
    return { address: created.address, path: created.walletPath };
  };

  // Hand the one-time secret only to the native launcher through its private
  // stdout pipe. It is never served over HTTP or placed in a URL.
  const pairingCode = randomBytes(32).toString("hex");
  const ui = createWalletPreviewServer();
  // A fresh loopback origin per launch cannot be controlled by an older
  // cache-first service worker left behind by a prior preview installation.
  await listen(ui, 0);
  const origin = `http://127.0.0.1:${ui.address().port}`;
  let bridge;
  try {
    bridge = createWalletBridgeServer({
      accounts: listLocalTestWallets(storageRoot),
      authorize: authorizeSigning,
      createAccount,
      nativePasswordChange,
      nativeSecurity,
      appUpdater: createWalletUpdater(),
      appConnect: true,
      nativeRevealPhrase,
      // The user's own names for their accounts, kept next to the wallets.
      accountNames: {
        read() {
          try {
            const value = JSON.parse(readFileSync(join(storageRoot, "account-names.json"), "utf8"));
            return value && typeof value === "object" && !Array.isArray(value) ? value : {};
          } catch {
            return {};
          }
        },
        write(address, name) {
          const names = { ...this.read(), [address]: name };
          const path = join(storageRoot, "account-names.json");
          writeFileSync(`${path}.tmp`, `${JSON.stringify(names, null, 2)}\n`, { mode: 0o600 });
          renameSync(`${path}.tmp`, path);
        },
      },
      oldCopies: (() => {
        const appPath = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
        return { find: () => findOldCopies(appPath), trash: () => trashOldCopies(appPath),
          reveal: () => revealOldCopies(appPath) };
      })(),
      // The Mining page's "Open NIR Майнер" button, by bundle identifier.
      openMiner: () => execFileAsync("/usr/bin/open", ["-b", "org.nir.model-lab-local-test"], { timeout: 10_000 }),
      origin,
      pairingCode,
      pairingLifetimeMs: 300_000,
      sessionToken: randomBytes(32).toString("hex"),
      vaultPath: selected.walletPath,
    });
    await listen(bridge, BRIDGE_PORT);
  } catch (error) {
    if (ui.listening) ui.close();
    if (bridge?.listening) bridge.close();
    throw error;
  }
  for (const event of ["SIGINT", "SIGTERM"]) {
    process.once(event, () => { bridge.close(); ui.close(); process.exitCode = 0; });
  }
  // The native shell embeds this exact fresh loopback origin in a nonpersistent
  // WKWebView. Do not open a system browser with the wallet session.
  process.stdout.write(`${origin}/?local-demo=1&local-app=1\t${pairingCode}\n`);
}

main().catch(async (error) => {
  try {
    await notify("NIR не запущен", "Не удалось открыть тестовый кошелёк. Проверьте, что другая копия NIR не заняла порт 8788. Файлы кошелька не удалены.");
  } catch { /* Native UI can also be unavailable. */ }
  process.stderr.write(`NIR wallet failed: ${error?.message ?? "unknown error"}\n`);
  process.exitCode = 1;
});

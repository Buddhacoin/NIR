#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createWalletBridgeServer } from "./wallet-bridge.mjs";
import { walletPublicInfo } from "./wallet-files.mjs";
import { listLocalTestWallets, renewLocalTestRecoveryCode } from "./wallet-onboarding.mjs";
import { recoveryBackupFingerprint, verifyRecoveryExportReceipt } from "./wallet-backup-export-check.mjs";
import { createWalletPreviewServer } from "./wallet-preview-cli.mjs";

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
  const summary = [
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

let pairingPrompt = null;
function showPairingCode(code) {
  const executable = fileURLToPath(new URL("../../../MacOS/onboarding", import.meta.url));
  return new Promise((resolve, reject) => {
    if (pairingPrompt && pairingPrompt.exitCode === null) pairingPrompt.kill("SIGTERM");
    const child = spawn(executable, ["--show-pairing"], { stdio: ["pipe", "ignore", "ignore"] });
    pairingPrompt = child;
    child.once("error", reject);
    child.once("close", (status) => {
      if (pairingPrompt === child) pairingPrompt = null;
      if (status === 0 || child.killed) resolve();
      else reject(new Error("pairing window failed"));
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify({ code }));
  });
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

async function main() {
  if (process.platform !== "darwin") throw new Error("this visual wallet runs on macOS only");
  const setup = fileURLToPath(new URL("./wallet-macos-setup.mjs", import.meta.url));
  let setupOutput;
  try {
    ({ stdout: setupOutput } = await execFileAsync(process.execPath, [setup], {
      encoding: "utf8", maxBuffer: 8 * 1024, timeout: 600_000,
    }));
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
    const { stdout } = await execFileAsync(process.execPath, [setup, "--create-only"], {
      encoding: "utf8", maxBuffer: 8 * 1024, timeout: 600_000,
    });
    const created = JSON.parse(noTrailingNewline(stdout));
    if (walletPublicInfo(created.walletPath).address !== created.address) {
      throw new Error("new wallet identity changed");
    }
    return { address: created.address, path: created.walletPath };
  };

  const pairingCode = randomInt(0, 100_000_000).toString().padStart(8, "0");
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
      nativeSecurity,
      origin,
      pairingCode,
      pairingLifetimeMs: 300_000,
      presentPairingCode: () => { void showPairingCode(pairingCode).catch(() => {}); },
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
  process.stdout.write(`${origin}/?local-demo=1&local-app=1\n`);
}

main().catch(async (error) => {
  try {
    await notify("NIR не запущен", "Не удалось открыть тестовый кошелёк. Проверьте, что другая копия NIR не заняла порт 8788. Файлы кошелька не удалены.");
  } catch { /* Native UI can also be unavailable. */ }
  process.stderr.write(`NIR wallet failed: ${error?.message ?? "unknown error"}\n`);
  process.exitCode = 1;
});

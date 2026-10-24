#!/usr/bin/env node
// NIR on Windows and Linux (docs/install-desktop.md): NIR Wallet and NIR
// Майнер from one launcher. Both run the same local services as the Mac apps
// and show their pages in app windows of the system's browser, in NIR's own
// private profile. The first start creates or restores the wallet in NIR's
// confirmation windows. Everything stops when the last NIR window closes.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { appWindowProfile, miningDataDirectory, walletStorageRoot } from "./app-paths.mjs";
import { findAppBrowser, openAppWindow } from "./desktop-browser.mjs";
import { createDialogHost } from "./desktop-dialogs.mjs";
import { createDesktopWalletHost, systemLanguage } from "./desktop-wallet.mjs";
import { activeMinerNetworkTrust, minerNetworkSignature } from "./miner-network-trust.mjs";
import { createMiningPracticeApp, miningModelAppPreflight } from "./mining-practice-app.mjs";
import { createWalletBridgeServer } from "./wallet-bridge.mjs";
import { listLocalTestWallets } from "./wallet-onboarding.mjs";
import { createWalletPreviewServer } from "./wallet-preview-cli.mjs";

const BRIDGE_PORT = 8788;
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
}

// A second start while NIR runs brings its windows back instead.
async function reopenRunning(controlPath) {
  try {
    const { port, token } = JSON.parse(readFileSync(controlPath, "utf8"));
    const response = await fetch(`http://127.0.0.1:${port}/reopen`, { method: "POST",
      headers: { "x-nir-control": token }, signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (process.platform === "darwin") throw new Error("on a Mac, open NIR Wallet and NIR Майнер instead");
  const preflight = miningModelAppPreflight({ root: ROOT });
  if (!preflight.ready) {
    throw new Error(preflight.checks.filter(([ok]) => !ok).map(([, message]) => message).join(" "));
  }
  const storageRoot = walletStorageRoot();
  const miningDirectory = miningDataDirectory();
  mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  mkdirSync(miningDirectory, { recursive: true, mode: 0o700 });
  const controlPath = join(storageRoot, "..", "desktop-control.json");
  if (await reopenRunning(controlPath)) return;

  const language = systemLanguage();
  const browser = findAppBrowser();
  const profile = appWindowProfile();
  const children = new Set();
  let windowsShown = false;
  let stopping = false;
  const servers = [];
  const stop = () => {
    if (stopping) return;
    stopping = true;
    rmSync(controlPath, { force: true });
    for (const server of servers) server.close();
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  // Every window starts a browser process for NIR's profile; all but the
  // first hand over to it and exit. None left means no NIR window is open.
  const openWindow = (url, { width, height } = {}) => {
    const child = openAppWindow({ browser, profile, url, width, height });
    if (!child) return;
    children.add(child);
    child.once("error", () => children.delete(child));
    child.once("exit", () => {
      children.delete(child);
      if (windowsShown && children.size === 0) stop();
    });
  };

  const dialogs = createDialogHost({ openWindow });
  await dialogs.listen();
  servers.push(dialogs.server);

  const miner = createMiningPracticeApp({ root: ROOT, miningDirectory });
  await listen(miner, 0);
  servers.push(miner);
  const minerUrl = `http://127.0.0.1:${miner.address().port}/?local-app=1#session=${miner.localSessionToken}`;

  const host = createDesktopWalletHost({ dialogs, storageRoot, language });
  const selected = await host.setup();
  if (!selected) return stop();

  const pairingCode = randomBytes(32).toString("hex");
  const ui = createWalletPreviewServer();
  await listen(ui, 0);
  servers.push(ui);
  const origin = `http://127.0.0.1:${ui.address().port}`;
  const walletUrl = `${origin}/?local-demo=1&local-app=1#pair=${pairingCode}`;
  let networkSignature = minerNetworkSignature();
  const networkTrust = activeMinerNetworkTrust({ storageRoot });
  let networkTip = networkTrust?.trustAnchor.genesisCheckpoint.tipHash ?? null;
  const bridge = createWalletBridgeServer({
    accounts: listLocalTestWallets(storageRoot),
    authorize: host.authorize,
    createAccount: host.createAccount,
    nativePasswordChange: host.passwordChange,
    nativeRevealPhrase: host.revealPhrase,
    accountNames: host.accountNames,
    appConnect: true,
    openMiner: async () => openWindow(minerUrl),
    origin,
    pairingCode,
    pairingLifetimeMs: 300_000,
    sessionToken: randomBytes(32).toString("hex"),
    vaultPath: selected.walletPath,
    ...(networkTrust ?? {}),
  });
  await listen(bridge, BRIDGE_PORT);
  servers.push(bridge);
  // The miner may join the shared network after the wallet opened.
  setInterval(() => {
    const signature = minerNetworkSignature();
    if (signature === networkSignature) return;
    networkSignature = signature;
    const trust = activeMinerNetworkTrust({ storageRoot });
    const tip = trust?.trustAnchor.genesisCheckpoint.tipHash ?? null;
    if (!trust || tip === networkTip) return;
    try {
      bridge.setNetworkTrust(trust);
      networkTip = tip;
    } catch {
      networkSignature = null;
    }
  }, 5_000).unref();

  const showWindows = () => {
    openWindow(walletUrl, { width: 1180, height: 820 });
    openWindow(minerUrl, { width: 1180, height: 820 });
  };
  // A second start of NIR (after a closed or reloaded wallet window) opens
  // both windows again; the wallet window pairs with a fresh one-time code.
  const controlToken = dialogs.allowReopen(() => {
    const code = randomBytes(32).toString("hex");
    bridge.restartPairing(code);
    openWindow(`${origin}/?local-demo=1&local-app=1#pair=${code}`, { width: 1180, height: 820 });
    openWindow(minerUrl, { width: 1180, height: 820 });
  });
  writeFileSync(controlPath, JSON.stringify({ port: dialogs.server.address().port, token: controlToken }),
    { mode: 0o600 });
  showWindows();
  miner.openMiningNetworkAfterFirstScreen();
  windowsShown = true;
  if (!browser) {
    process.stdout.write(language === "ru"
      ? "NIR открыт в браузере. Не закрывайте это окно, пока работаете с NIR.\n"
      : "NIR is open in your browser. Keep this window open while you use NIR.\n");
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
}

main().catch((error) => {
  process.stderr.write(`NIR did not start: ${error?.message ?? "unknown error"}\n`);
  process.exitCode = 1;
});

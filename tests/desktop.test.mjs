import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appWindowProfile, miningDataDirectory, walletStorageRoot } from "../blockchain/app-paths.mjs";
import { appWindowArguments, findAppBrowser, openAppWindow } from "../blockchain/desktop-browser.mjs";
import { createDialogHost } from "../blockchain/desktop-dialogs.mjs";
import { createDesktopWalletHost, systemLanguage } from "../blockchain/desktop-wallet.mjs";
import { createWalletBridgeServer } from "../blockchain/wallet-bridge.mjs";
import { listLocalTestWallets } from "../blockchain/wallet-onboarding.mjs";
import { signingSummary } from "../blockchain/wallet-signing-summary.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const PASSWORD = "Zeus-Olymp-2026";

test("each system keeps NIR's files in its own per-user place", () => {
  const home = "/home/athena";
  assert.equal(walletStorageRoot({ platform: "linux", env: {}, home }), "/home/athena/.local/share/nir/wallet");
  assert.equal(miningDataDirectory({ platform: "linux", env: { XDG_DATA_HOME: "/data" }, home }), "/data/nir/miner");
  assert.equal(appWindowProfile({ platform: "linux", env: {}, home }), "/home/athena/.local/share/nir/window");
  assert.equal(walletStorageRoot({ platform: "darwin", env: {}, home }),
    "/home/athena/Library/Application Support/NIR Wallet");
  assert.equal(miningDataDirectory({ platform: "darwin", env: {}, home }),
    "/home/athena/Library/Application Support/NIR Model Lab/mining");
  assert.equal(miningDataDirectory({ platform: "linux", env: { NIR_MODEL_LAB_DATA: "/x" }, home }), "/x");
  assert.match(walletStorageRoot({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\Zeus\\AppData\\Local" }, home }),
    /AppData.Local.NIR.Wallet$/);
  // A relative XDG_DATA_HOME is ignored, as the XDG rules require.
  assert.equal(walletStorageRoot({ platform: "linux", env: { XDG_DATA_HOME: "data" }, home }),
    "/home/athena/.local/share/nir/wallet");
});

test("app windows use a Chromium-family browser in NIR's private profile and open only local pages", () => {
  const linux = findAppBrowser({ platform: "linux", env: { PATH: "/usr/bin:relative" },
    exists: (path) => path === "/usr/bin/chromium" });
  assert.equal(linux, "/usr/bin/chromium");
  assert.equal(findAppBrowser({ platform: "linux", env: { PATH: "/usr/bin" }, exists: () => false }), null);
  const windows = findAppBrowser({ platform: "win32", env: { "ProgramFiles(x86)": "C:\\PF86" },
    exists: (path) => path.endsWith("msedge.exe") });
  assert.match(windows, /Microsoft.Edge.Application.msedge\.exe$/);
  const args = appWindowArguments({ url: "http://127.0.0.1:1/", profile: "/p" });
  assert.ok(args.includes("--app=http://127.0.0.1:1/"));
  assert.ok(args.includes("--user-data-dir=/p"));
  assert.ok(args.includes("--disable-extensions"));
  assert.throws(() => openAppWindow({ browser: "/bin/true", profile: "/tmp", url: "https://example.com/" }),
    /only local NIR pages/);
});

async function answerDialog(url, answer) {
  const [, fragment] = url.split("#");
  const [id, token] = fragment.split(".");
  const base = url.split("/dialog")[0];
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: "POST",
    headers: { origin: base, "content-type": "application/json", "x-nir-dialog": token, ...headers },
    body: JSON.stringify({ id, ...body }) });
  const state = await post("/dialog/state", {});
  const spec = await state.json();
  if (answer) await post("/dialog/answer", answer(spec));
  return { spec, post };
}

test("a confirmation window is reachable only with its one-time token and returns the answer", async () => {
  const opened = [];
  const dialogs = createDialogHost({ openWindow: (url) => opened.push(url) });
  await dialogs.listen();
  try {
    const pending = dialogs.ask({ title: "T", message: "M", fields: [{ name: "password", type: "password", label: "P" }],
      buttons: [{ id: "no", label: "No" }, { id: "yes", label: "Yes", primary: true }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(opened.length, 1);
    assert.match(opened[0], /^http:\/\/127\.0\.0\.1:\d+\/dialog#[0-9a-f]{32}\.[0-9a-f]{64}$/);
    const base = opened[0].split("/dialog")[0];
    const id = opened[0].split("#")[1].split(".")[0];
    const forged = await fetch(`${base}/dialog/state`, { method: "POST", headers: { origin: base,
      "x-nir-dialog": "0".repeat(64) }, body: JSON.stringify({ id }) });
    assert.equal(forged.status, 403);
    const foreign = await fetch(`${base}/dialog/state`, { method: "POST", headers: { origin: "http://evil.example",
      "x-nir-dialog": "0".repeat(64) }, body: JSON.stringify({ id }) });
    assert.equal(foreign.status, 404);
    const { spec } = await answerDialog(opened[0], () => ({ button: "yes", values: { password: PASSWORD, extra: "x" } }));
    assert.equal(spec.title, "T");
    assert.deepEqual(await pending, { button: "yes", values: { password: PASSWORD } });
    const page = await fetch(`${base}/dialog`);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  } finally { await dialogs.close(); }
});

test("a closed, never-opened or aborted confirmation window counts as a refusal", async () => {
  const opened = [];
  const dialogs = createDialogHost({ openWindow: (url) => opened.push(url), openTimeoutMs: 300, aliveTimeoutMs: 300 });
  await dialogs.listen();
  try {
    const spec = { title: "T", buttons: [{ id: "ok", label: "OK", primary: true }] };
    assert.equal(await dialogs.ask(spec), null);
    const shown = dialogs.ask(spec);
    await new Promise((resolve) => setImmediate(resolve));
    await answerDialog(opened[1]);
    assert.equal(await shown, null);
    const controller = new AbortController();
    const aborted = dialogs.ask(spec, { signal: controller.signal });
    controller.abort();
    assert.equal(await aborted, null);
    assert.throws(() => dialogs.ask({ title: "T", buttons: [] }), /dialog is invalid/);
  } finally { await dialogs.close(); }
});

// Answers the wallet host's windows the way a person would.
function scriptedDialogs(steps) {
  const seen = [];
  return {
    seen,
    async ask(spec) {
      seen.push(spec);
      const step = steps.shift();
      return step ? step(spec) : null;
    },
  };
}

test("the first start creates a wallet, shows the 24 words once and checks two of them", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "nir-desktop-wallet-"));
  let words;
  const dialogs = scriptedDialogs([
    () => ({ button: "create", values: {} }),
    () => ({ button: "next", values: { password: PASSWORD, repeat: "different-2026" } }),
    (spec) => { assert.equal(spec.error.length > 0, true); return { button: "next", values: { password: PASSWORD, repeat: PASSWORD } }; },
    (spec) => { words = [...spec.words]; return { button: "written", values: {} }; },
    (spec) => {
      const [a, b] = spec.fields.map((field) => Number(field.label.match(/\d+/)[0]) - 1);
      return { button: "check", values: { a: words[a].toUpperCase(), b: ` ${words[b]} ` } };
    },
  ]);
  try {
    const host = createDesktopWalletHost({ dialogs, storageRoot, language: "ru" });
    const selected = await host.setup();
    assert.equal(words.length, 24);
    assert.equal(listLocalTestWallets(storageRoot)[0].address, selected.address);
    assert.equal(existsSync(selected.walletPath), true);
    // A second start opens the same wallet without asking anything.
    const again = await createDesktopWalletHost({ dialogs: scriptedDialogs([]), storageRoot }).setup();
    assert.equal(again.address, selected.address);
    // Signing asks for the password in the window and returns it to the bridge only.
    const signer = createDesktopWalletHost({ storageRoot, language: "en",
      dialogs: scriptedDialogs([(spec) => { assert.match(spec.message, /Sign a NIR operation/);
        return { button: "sign", values: { password: PASSWORD } }; }]) });
    assert.equal(await signer.authorize({ type: "transfer", networkId: "n", nonce: 1, requestId: "r" }), PASSWORD);
    const decliner = createDesktopWalletHost({ storageRoot,
      dialogs: scriptedDialogs([() => ({ button: "decline", values: { password: PASSWORD } })]) });
    assert.equal(await decliner.authorize({ type: "transfer", networkId: "n", nonce: 1, requestId: "r" }), null);
    // The words again, after the password; a wrong password shows nothing.
    const wrong = createDesktopWalletHost({ storageRoot,
      dialogs: scriptedDialogs([() => ({ button: "show", values: { password: "wrong-password-1" } })]) });
    assert.equal(await wrong.revealPhrase({}), "wrong-password");
    let revealed;
    const right = createDesktopWalletHost({ storageRoot, dialogs: scriptedDialogs([
      () => ({ button: "show", values: { password: PASSWORD } }),
      (spec) => { revealed = [...spec.words]; return { button: "ok", values: {} }; }]) });
    assert.equal(await right.revealPhrase({}), "shown");
    assert.deepEqual(revealed, words);
  } finally { rmSync(storageRoot, { recursive: true, force: true }); }
});

test("the 24 words restore the same wallet on another computer", async () => {
  const first = mkdtempSync(join(tmpdir(), "nir-desktop-first-"));
  const second = mkdtempSync(join(tmpdir(), "nir-desktop-second-"));
  let words;
  try {
    const created = await createDesktopWalletHost({ storageRoot: first, dialogs: scriptedDialogs([
      () => ({ button: "create", values: {} }),
      () => ({ button: "next", values: { password: PASSWORD, repeat: PASSWORD } }),
      (spec) => { words = [...spec.words]; return { button: "written", values: {} }; },
      () => null, // closing the check still leaves a working wallet
    ]) }).setup();
    const restored = await createDesktopWalletHost({ storageRoot: second, dialogs: scriptedDialogs([
      () => ({ button: "restore", values: {} }),
      () => ({ button: "restore", values: { words: "not real words", password: PASSWORD, repeat: PASSWORD } }),
      (spec) => { assert.ok(spec.error); return { button: "restore",
        values: { words: words.join("  ").toUpperCase(), password: PASSWORD, repeat: PASSWORD } }; },
    ]) }).setup();
    assert.equal(restored.address, created.address);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("closing the first window leaves no wallet behind", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "nir-desktop-cancel-"));
  try {
    assert.equal(await createDesktopWalletHost({ storageRoot, dialogs: scriptedDialogs([]) }).setup(), null);
    assert.deepEqual(listLocalTestWallets(storageRoot), []);
  } finally { rmSync(storageRoot, { recursive: true, force: true }); }
});

test("a reopened wallet window pairs again with a fresh code and the old session ends", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "nir-desktop-pair-"));
  const created = await createDesktopWalletHost({ storageRoot, dialogs: scriptedDialogs([
    () => ({ button: "create", values: {} }),
    () => ({ button: "next", values: { password: PASSWORD, repeat: PASSWORD } }),
    () => null,
  ]) }).setup();
  const origin = "http://127.0.0.1:8765";
  const first = "1".repeat(64);
  const server = createWalletBridgeServer({ authorize: async () => null, origin, pairingCode: first,
    sessionToken: "a".repeat(64), vaultPath: created.walletPath });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const pair = (code) => fetch(`${base}/v1/pair`, { method: "POST",
      headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const wallet = (token) => fetch(`${base}/v1/wallet`, { headers: { origin, "x-nir-bridge-token": token } });
    const { sessionToken: oldToken } = await (await pair(first)).json();
    assert.equal((await wallet(oldToken)).status, 200);
    assert.throws(() => server.restartPairing("short"), /pairing restart is invalid/);
    const second = "2".repeat(64);
    server.restartPairing(second);
    assert.equal((await wallet(oldToken)).status, 401);
    assert.equal((await pair(first)).status, 400);
    const { sessionToken: newToken } = await (await pair(second)).json();
    assert.notEqual(newToken, oldToken);
    assert.equal((await wallet(newToken)).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("signing texts exist in both languages and the system language picks one", () => {
  const intent = { type: "name-register", name: "athena", address: "nir1x", price: "10 NIR" };
  assert.match(signingSummary(intent), /Купить имя athena\.nir/);
  assert.match(signingSummary(intent, "en"), /Buy the name athena\.nir/);
  assert.equal(systemLanguage({ LANG: "ru_RU.UTF-8" }), "ru");
  assert.equal(systemLanguage({ LANG: "de_DE.UTF-8" }), "en");
});

test("the Linux installer verifies Node.js, installs the NIR launcher and a menu entry", () => {
  const installer = read("site/install.sh");
  assert.match(installer, /Linux\) install_linux; exit 0 ;;/);
  assert.match(installer, /sha256sum -c/);
  assert.match(installer, /node-v\$NODE_VERSION-linux-\$arch\.tar\.gz/);
  assert.match(installer, /blockchain\/nir-desktop\.mjs/);
  assert.match(installer, /\[Desktop Entry\]/);
  assert.ok(existsSync(new URL("../blockchain/nir-desktop.mjs", import.meta.url)));
});

test("the app pages accept their one-time codes from the fragment and speak of this computer", () => {
  const wallet = read("wallet-ui/app.js");
  assert.match(wallet, /#pair=\(\[0-9a-f\]\{64\}\)/);
  assert.match(wallet, /window\.__nirNativeBootstrap \?\? desktopPairing/);
  assert.match(wallet, /на этом компьютере/);
  const miner = read("mining-app/app.js");
  assert.match(miner, /window\.__NIR_MODEL_SESSION\) \|\| fragmentSession/);
});

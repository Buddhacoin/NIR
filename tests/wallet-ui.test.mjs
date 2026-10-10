import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { submissionStatus } from "../wallet-ui/submission-status.js";

const html = readFileSync(new URL("../wallet-ui/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../wallet-ui/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../wallet-ui/style.css", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../wallet-ui/sw.js", import.meta.url), "utf8");
const extensionBackground = readFileSync(new URL("../wallet-ui/extension-background.js", import.meta.url), "utf8");
const bridgeCli = readFileSync(new URL("../blockchain/wallet-bridge-cli.mjs", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../blockchain/wallet-bridge.mjs", import.meta.url), "utf8");
const extensionManifest = JSON.parse(readFileSync(
  new URL("../wallet-ui/manifest.json", import.meta.url), "utf8",
));

test("wallet browser module parses as valid JavaScript", () => {
  execFileSync(process.execPath, ["--check", new URL("../wallet-ui/app.js", import.meta.url).pathname]);
});

test("a verified account proof does not depend on an unauthenticated account response", async () => {
  const source = script.slice(script.indexOf("async function readAccount()"),
    script.indexOf("function renderTransactions("));
  const address = `nir1${"a".repeat(64)}`;
  const requests = [];
  const context = {
    walletInfo: { address }, networkInfo: { height: 1, networkId: "nir-test" },
    nodeUrl: (path) => path,
    fetch: async (path) => {
      requests.push(path);
      if (path === `/v1/accounts/${address}`) throw new Error("raw account unavailable");
      if (path === "/v1/validator-handoffs") return { ok: false };
      if (path === `/v1/accounts/${address}/proof`) return {
        ok: true, json: async () => ({ signed: "proof" }),
      };
      if (path.startsWith(`/v1/accounts/${address}/history?`)) return {
        ok: true, json: async () => ({ entries: [] }),
      };
      throw new Error(`unexpected request: ${path}`);
    },
    bridgeRequest: async (path) => {
      if (path === "/v1/trust-info") return { enabled: false };
      if (path === "/v1/verify-account-proof") return { verified: true, statement: {
        account: { address, atomicBalance: "500000000", history: { count: 0 } },
        height: 1, networkId: "nir-test", stateRoot: "b".repeat(64), tipHash: "c".repeat(64),
      } };
      if (path === "/v1/verify-account-history-page") return { verified: true, entries: [] };
      throw new Error(`unexpected bridge request: ${path}`);
    },
  };
  runInNewContext(`${source}\nglobalThis.readAccount = readAccount;`, context);
  const account = await context.readAccount();
  assert.equal(account.proofVerified, true);
  assert.equal(account.atomicBalance, "500000000");
  assert.ok(!requests.includes(`/v1/accounts/${address}`));

  const originalBridgeRequest = context.bridgeRequest;
  for (const change of [
    (result) => { result.verified = false; },
    (result) => { result.statement.account.address = `nir1${"d".repeat(64)}`; },
    (result) => { result.statement.networkId = "another-network"; },
    (result) => { result.statement.height = 0; },
  ]) {
    context.bridgeRequest = async (path) => {
      const result = await originalBridgeRequest(path);
      if (path === "/v1/verify-account-proof") change(result);
      return result;
    };
    const rejected = await context.readAccount();
    assert.equal(rejected.proofVerified, false);
    assert.equal(rejected.atomicBalance, undefined);
  }
});

test("a failed bridge reconnection clears a previously verified balance", async () => {
  const source = script.slice(script.indexOf('document.querySelector("#bridge-form").addEventListener'),
    script.indexOf("function receive()"));
  let submit;
  const balance = { textContent: "5.00000000" };
  const state = { textContent: "Кворум подтвердил баланс · блок 7" };
  const code = { value: "invalid" };
  const context = {
    accountEpoch: 0,
    bridgeSession: { token: "old" }, walletInfo: { address: `nir1${"a".repeat(64)}` },
    bridgeStatus: { textContent: "" }, bridgePanel: { open: false },
    document: { querySelector(selector) {
      if (selector === "#bridge-form") return { addEventListener(_event, handler) { submit = handler; } };
      if (selector === "#bridge-code") return code;
      if (selector === "#bridge-url") return { value: "bad-url" };
      return null;
    } },
    exactLoopbackUrl: () => { throw new Error("invalid URL"); },
    clearWalletSession: () => {
      context.accountEpoch += 1;
      context.bridgeSession = null;
      context.walletInfo = null;
      balance.textContent = "—";
      state.textContent = "Vault отключён";
    },
  };
  runInNewContext(source, context);
  await submit({ preventDefault() {} });
  assert.equal(context.bridgeSession, null);
  assert.equal(context.walletInfo, null);
  assert.equal(balance.textContent, "—");
  assert.doesNotMatch(state.textContent, /Кворум подтвердил/);
});

test("a late pairing response cannot restore a superseded wallet session", async () => {
  const source = script.slice(script.indexOf('document.querySelector("#bridge-form").addEventListener'),
    script.indexOf("function receive()"));
  let submit;
  let resolvePair;
  let bridgeCalls = 0;
  const code = { value: "12345678" };
  const balance = { textContent: "5.00000000" };
  const context = {
    accountEpoch: 0, bridgeSession: { token: "old" },
    walletInfo: { address: `nir1${"a".repeat(64)}` },
    bridgeStatus: { textContent: "" }, bridgePanel: { open: false },
    document: { querySelector(selector) {
      if (selector === "#bridge-form") return { addEventListener(_event, handler) { submit = handler; } };
      if (selector === "#bridge-code") return code;
      if (selector === "#bridge-url") return { value: "http://127.0.0.1:8788" };
      return null;
    } },
    exactLoopbackUrl: (value) => value,
    pairBridge: () => new Promise((resolve) => { resolvePair = resolve; }),
    bridgeRequest: async () => { bridgeCalls += 1; throw new Error("stale bridge call"); },
    clearWalletSession: () => {
      context.accountEpoch += 1;
      context.bridgeSession = null;
      context.walletInfo = null;
      balance.textContent = "—";
    },
  };
  runInNewContext(source, context);
  const first = submit({ preventDefault() {} });
  assert.equal(typeof resolvePair, "function");
  code.value = "bad";
  await submit({ preventDefault() {} });
  resolvePair("late-token");
  await first;
  assert.equal(bridgeCalls, 0);
  assert.equal(context.bridgeSession, null);
  assert.equal(context.walletInfo, null);
  assert.equal(balance.textContent, "—");
});

test("an old bridge 401 cannot disconnect a newer pairing", async () => {
  const source = script.slice(script.indexOf("async function bridgeRequest("),
    script.indexOf("async function signWithRecovery("));
  let finishFetch;
  let cleared = 0;
  const oldSession = { url: "http://127.0.0.1:8788", token: "old" };
  const newSession = { url: "http://127.0.0.1:8789", token: "new" };
  const context = {
    bridgeSession: oldSession, AbortController, setTimeout, clearTimeout,
    fetch: () => new Promise((resolve) => { finishFetch = resolve; }),
    clearWalletSession: () => { cleared += 1; context.bridgeSession = null; },
  };
  runInNewContext(`${source}\nglobalThis.bridgeRequest = bridgeRequest;`, context);
  const pending = context.bridgeRequest("/v1/accounts").catch(() => {});
  context.bridgeSession = newSession;
  finishFetch({ ok: false, status: 401, json: async () => ({ error: "expired" }) });
  await pending;
  assert.equal(cleared, 0);
  assert.equal(context.bridgeSession, newSession);
});

test("a stale account-list response cannot replace the new wallet identity", async () => {
  const source = script.slice(script.indexOf("async function renderAccounts()"),
    script.indexOf("async function completeAccountChange()"));
  let finishFetch;
  const selected = { textContent: "New ▾", dataset: { activeId: "new" } };
  const list = { replaceChildren() { this.rows = []; }, append(row) { this.rows.push(row); } };
  const context = {
    accountEpoch: 1, walletInfo: { address: `nir1${"a".repeat(64)}` },
    bridgeSession: { token: "old" },
    NIR_ADDRESS: /^nir1[0-9a-f]{64}$/, accountOpen: selected,
    bridgeRequest: () => new Promise((resolve) => { finishFetch = resolve; }),
    document: { querySelector: (query) => query === "#account-list" ? list : { hidden: false },
      createElement: () => ({ append() {}, setAttribute() {} }) },
    changeAccount() {},
  };
  runInNewContext(`${source}\nglobalThis.renderAccounts = renderAccounts;`, context);
  const pending = context.renderAccounts();
  context.accountEpoch += 1;
  context.walletInfo = { address: `nir1${"b".repeat(64)}` };
  finishFetch({ accounts: [{ id: "a".repeat(32), address: `nir1${"a".repeat(64)}`,
    label: "OLD" }], activeId: "a".repeat(32), canCreate: false });
  await pending;
  assert.equal(selected.textContent, "New ▾");
  assert.equal(selected.dataset.activeId, "new");
  assert.equal(list.rows, undefined);
});

test("an old account-change response cannot overwrite a new bridge identity", async () => {
  const source = script.slice(script.indexOf("async function completeAccountChange()"),
    script.indexOf("async function changeAccount("));
  let finishFetch;
  let refreshes = 0;
  const context = {
    accountEpoch: 0, walletInfo: { address: "old" },
    bridgeSession: { token: "old" },
    resetAccountView: () => { context.accountEpoch += 1; },
    bridgeRequest: () => new Promise((resolve) => { finishFetch = resolve; }),
    renderWalletConnection() {}, renderAccounts: async () => true,
    accountsPanel: { open: false },
    refreshNodeStatus: async () => { refreshes += 1; },
  };
  runInNewContext(`${source}\nglobalThis.completeAccountChange = completeAccountChange;`, context);
  const pending = context.completeAccountChange();
  context.accountEpoch += 1;
  context.bridgeSession = { token: "new" };
  context.walletInfo = { address: "new" };
  finishFetch({ address: "old" });
  await pending;
  assert.equal(context.walletInfo.address, "new");
  assert.equal(refreshes, 0);
});

test("an old account-switch failure cannot cancel a newer pairing", async () => {
  const source = script.slice(script.indexOf("async function completeAccountChange()"),
    script.indexOf("accountOpen.onclick"));
  let rejectOld;
  let clears = 0;
  const context = {
    accountEpoch: 0, accountTransitionPending: false,
    bridgeSession: { token: "old" }, walletInfo: { address: "old" },
    accountOpen: { dataset: { activeId: "old" } },
    accountsPanel: { close() {} }, accountsStatus: { textContent: "" },
    resetAccountView: () => { context.accountEpoch += 1; },
    clearWalletSession: () => { clears += 1; context.accountEpoch += 1; },
    bridgeRequest: () => new Promise((resolve, reject) => { rejectOld = reject; }),
    renderWalletConnection() {}, renderAccounts: async () => true,
    refreshNodeStatus: async () => {},
  };
  runInNewContext(`${source}\nglobalThis.changeAccount = changeAccount;`, context);
  const pending = context.changeAccount("new");
  context.accountEpoch += 1;
  context.bridgeSession = null;
  context.walletInfo = null;
  rejectOld(new Error("old session closed"));
  await pending;
  assert.equal(context.accountEpoch, 1);
  assert.equal(clears, 0);
});

test("double-click Mac mode removes terminal setup and false mining claims", () => {
  assert.match(script, /const localApp = new URLSearchParams\(location\.search\)\.get\("local-app"\) === "1"/);
  assert.match(script, /if \(localApp\) \{[\s\S]*?#onboarding ol[\s\S]*?#bridge-panel > p[\s\S]*?#setup-panel \.setup-steps[\s\S]*?\[data-action=\\?"mine/);
  assert.match(script, /if \(localApp\) messages\.mine = \["Майнинг недоступен"/);
  assert.match(script, /не начисляет NIR/);
  assert.match(styles, /\.setup-steps\[hidden\] \{ display: none; \}/);
  assert.match(script, /Проверьте окно macOS/);
  assert.match(html, /id="balance-value" data-i18n-ignore>—<\/span>/);
  assert.match(html, /id="onboarding-title">Подключите защищённый файл кошелька/);
  assert.match(html, /data-action="connect">Подключить кошелёк/);
  assert.match(script, /networkButton\.textContent = "○ Узлы недоступны"/);
});

test("wallet navigation has five interactive destinations", () => {
  for (const destination of ["home", "history", "resources", "mine", "settings"]) {
    assert.match(html, new RegExp(`data-nav="${destination}"`));
  }
  assert.match(script, /querySelectorAll\("\[data-nav\]"\)/);
  assert.match(script, /aria-current/);
});

test("wallet selects separate vault copies by opaque ID, including one shared address", () => {
  for (const id of ["account-open", "accounts-panel", "account-list", "add-account"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /bridgeRequest\("\/v1\/accounts"\)/);
  assert.match(script, /bridgeRequest\("\/v1\/select-account"/);
  assert.match(script, /JSON\.stringify\(\{ id \}\)/);
  assert.match(script, /account\.id === activeId/);
  assert.match(script, /resetAccountView/);
  assert.match(script, /canCreate !== true/);
  assert.match(bridgeCli, /listLocalTestWallets\(dirname\(dirname\(selectedVaultPath\)\)\)/);
  assert.match(bridgeCli, /!productionMode && basename\(dirname\(selectedVaultPath\)\) === "Wallets"/);
  assert.doesNotMatch(html.split('id="accounts-panel"')[1].split('</dialog>')[0], /\.nirvault\.json/);
});

test("asset proof refresh discards old-wallet responses before touching account state", () => {
  assert.match(script, /async function refreshAssets\(\) \{\s*const epoch = accountEpoch;/);
  assert.match(script, /const account = await readAccount\(\);\s*if \(!isCurrent\(\)\) return;/);
  assert.match(script, /statements\.push\(await verifyAssetState\(assetId, address\)\);\s*if \(!isCurrent\(\)\) return;/);
  assert.match(script, /\} catch \(error\) \{\s*if \(!isCurrent\(\)\) return;/);
  assert.match(script.split('const verified = await bridgeRequest("/v1/verify-asset-proof"')[1]
    .split("const statement = checkedAssetStatement")[0], /assertCurrent\(\);/);
});

test("delayed asset refresh cannot restore prior-account assets after switching vaults", async () => {
  const source = script.slice(script.indexOf("async function refreshAssets()"),
    script.indexOf("async function openAssets()"));
  const assetId = "a".repeat(64);
  const list = { children: [], replaceChildren(...children) { this.children = children; } };
  const checkpoint = { dataset: {}, textContent: "" };
  const knownAssetIds = new Set();
  let resolveProof;
  let rendered = 0;
  const context = {
    accountEpoch: 0, walletInfo: { address: `nir1${"b".repeat(64)}` },
    assetsStatus: { textContent: "" }, knownAssetIds,
    document: {
      createElement: () => ({ className: "", textContent: "" }),
      querySelector: (selector) => selector === "#asset-list" ? list : checkpoint,
    },
    readAccount: async () => ({ proofVerified: true, proofHeight: 1,
      proofStateRoot: "c".repeat(64) }),
    assetIdsFromVerifiedHistory: () => [assetId],
    verifyAssetState: () => new Promise((resolve) => { resolveProof = resolve; }),
    renderVerifiedAssets: () => { rendered += 1; },
    networkInfo: { networkId: "test", height: 1 },
  };
  runInNewContext(`${source}\nglobalThis.refreshAssets = refreshAssets;`, context);
  const pending = context.refreshAssets();
  for (let attempt = 0; attempt < 10 && !resolveProof; attempt++) await Promise.resolve();
  assert.equal(typeof resolveProof, "function");
  context.accountEpoch += 1;
  context.walletInfo = { address: `nir1${"d".repeat(64)}` };
  knownAssetIds.clear();
  list.replaceChildren();
  checkpoint.dataset.state = "stale";
  resolveProof({ asset: null, height: 1, stateRoot: "c".repeat(64), networkId: "test" });
  await pending;
  assert.equal(knownAssetIds.size, 0);
  assert.equal(rendered, 0);
  assert.equal(list.children.length, 0);
  assert.equal(checkpoint.dataset.state, "stale");
});

test("visible secondary controls have actions", () => {
  assert.match(html, /class="network" data-action="network"/);
  assert.match(html, /data-action="history">Все/);
  for (const action of ["receive", "send", "mine", "history", "settings", "network"]) {
    assert.match(script, new RegExp(`${action}: \\[`));
  }
});

test("bottom navigation is a compact readable dock", () => {
  assert.match(styles, /nav \{ position: fixed/);
  assert.match(styles, /grid-template-columns: repeat\(5, 1fr\)/);
  assert.match(styles, /width: min\(422px, calc\(100% - 24px\)\)/);
  assert.match(styles, /nav button \{[^}]*min-height: 66px/s);
  assert.match(styles, /nav button svg \{[^}]*width: 25px/s);
  assert.match(styles, /nav \.active i \{ background: transparent; color: #111/);
  assert.match(styles, /data-nav="home"\]\.active svg \{ fill: currentColor/);
  assert.match(html, />Главная<\/span>/);
});

test("wallet uses a neutral monochrome interface", () => {
  assert.match(styles, /--bg: #f5f5f7/);
  assert.match(styles, /--bg: #080808/);
  assert.doesNotMatch(styles, /#f47b19|#ff9138|#e76300/);
  assert.match(html, /class="brand-logo" src="nir-coin-icon\.png\?v=24"/);
  assert.match(styles, /\.balance h1 \{[^}]*font-weight: 480/s);
  assert.match(styles, /\.balance \{ padding: 30px 0 26px; text-align: center/);
});

test("wallet shell cache uses the current asset version", () => {
  assert.match(html, /style\.css\?v=33/);
  assert.match(serviceWorker, /style\.css\?v=33/);
  assert.match(html, /nir-coin-icon\.png\?v=24/);
  assert.match(serviceWorker, /nir-coin-icon\.png\?v=24/);
  assert.match(html, /app\.js\?v=40/);
  assert.match(serviceWorker, /app\.js\?v=40/);
  assert.match(serviceWorker, /nir-wallet-shell-v42/);
  assert.match(serviceWorker, /i18n\.js/);
  assert.match(serviceWorker, /submission-status\.js/);
  assert.match(serviceWorker, /skipWaiting/);
  assert.match(serviceWorker, /clients\.claim/);
  assert.match(serviceWorker, /node-selection\.js/);
  assert.match(serviceWorker, /address-book\.js/);
  assert.match(serviceWorker, /qr\.js/);
  assert.match(serviceWorker, /transaction-decoder\.js/);
  assert.match(serviceWorker, /offline-signing\.js/);
  assert.match(serviceWorker, /nodes\.json/);
  assert.match(serviceWorker, /fetch\(event\.request,\{cache:"no-store"\}\)/);
  assert.doesNotMatch(serviceWorker.match(/const ASSETS=\[[^;]+/)[0], /nodes\.json/);
});

test("wallet provides safe onboarding, recovery guidance, and session revocation", () => {
  for (const id of ["onboarding", "settings-panel", "setup-panel", "disconnect-wallet"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /npm run wallet:backup/);
  assert.match(html, /npm run wallet:restore/);
  assert.match(script, /bridgeRequest\("\/v1\/session", \{ method: "DELETE" \}\)/);
  assert.match(script, /clearWalletSession/);
  assert.match(script, /onboarding\.hidden = connected/);
});

test("wallet limits browser privileges and supports accessible system settings", () => {
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /http:\/\/localhost/);
  assert.match(html, /aria-live="polite"/);
  assert.deepEqual(extensionManifest.permissions, []);
  assert.equal(extensionManifest.action.default_popup, undefined);
  assert.deepEqual(extensionManifest.background, { service_worker: "extension-background.js" });
  assert.match(extensionBackground, /chrome\.action\.onClicked\.addListener/);
  assert.match(extensionBackground, /chrome\.tabs\.create\(\{ url: chrome\.runtime\.getURL\("index\.html"\) \}\)/);
  assert.doesNotMatch(extensionBackground, /storage|sessionToken|password/);
  assert.deepEqual(extensionManifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.match(extensionManifest.key, /^[A-Za-z0-9+/]+=*$/);
  assert.match(extensionManifest.content_security_policy.extension_pages, /object-src 'none'/);
  assert.doesNotMatch(extensionManifest.content_security_policy.extension_pages, /localhost|unsafe-eval/);
  assert.match(script, /globalThis\.top !== globalThis\.self/);
  assert.match(script, /NIR Wallet framing is forbidden/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.match(styles, /forced-colors: active/);
  assert.match(styles, /@media \(max-width: 370px\)/);
  assert.match(styles, /@media \(min-width: 760px\)/);
});

test("extension action opens the pinned wallet page in a persistent tab", () => {
  let onClicked;
  const opened = [];
  runInNewContext(extensionBackground, {
    chrome: {
      action: { onClicked: { addListener: (listener) => { onClicked = listener; } } },
      runtime: { getURL: (path) => `chrome-extension://ojfgigpdjamebbiiihianbcjpabgdhnm/${path}` },
      tabs: { create: (options) => opened.push(options.url) },
    },
  });
  onClicked();
  assert.deepEqual(opened, ["chrome-extension://ojfgigpdjamebbiiihianbcjpabgdhnm/index.html"]);
});

test("wallet renders only locally verified transaction history", () => {
  assert.match(html, /id="transaction-list"/);
  assert.match(script, /\/v1\/verify-transaction-proof/);
  assert.match(script, /\/v1\/verify-account-history/);
  assert.match(script, /\/v1\/verify-account-history-page/);
  assert.match(script, /verifiedTransactions\.push/);
  assert.match(script, /Неподтверждённые ответы узла скрыты/);
  assert.match(styles, /\.transaction-row/);
});

test("wallet exposes native resource staking and delegation controls", () => {
  for (const id of ["resource-stake", "resource-credits", "resource-unstake",
    "stake-form", "delegation-form", "unstake-form", "claim-unstake"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /signWithRecovery\("\/v1\/sign-resource"/);
  assert.match(script, /type: "credit-stake"/);
  assert.match(script, /type: "credit-delegation"/);
  assert.match(script, /type: "credit-unstake-request"/);
  assert.match(script, /type: "credit-unstake-claim"/);
  assert.match(html, /id="resource-signed-json"/);
  assert.match(html, /id="submit-resource"[^>]*>Отправить в local testnet/);
  assert.match(script, /signedResourceTransaction = signed\.transaction/);
  assert.match(script, /health\.networkId !== signedResourceTransaction\.networkId/);
});

test("submission responses cannot claim transaction finality", () => {
  assert.equal(submissionStatus({ status: "queued", transactionId: "a".repeat(64) }),
    "Принято в очередь, ждите проверенного подтверждения.");
  for (const response of [
    { status: "known", transactionId: "a".repeat(64) },
    { status: "finalized", height: 12, blockHash: "b".repeat(64) },
    { height: 12, blockHash: "b".repeat(64) },
    {},
  ]) {
    assert.match(submissionStatus(response), /ждите проверенного подтверждения/);
    assert.doesNotMatch(submissionStatus(response), /Подтверждено|в блоке 12/);
  }
  assert.match(script, /resourcesStatus\.textContent = submissionStatus\(result\)/);
  assert.match(script, /sendStatus\.textContent = submissionStatus\(result\)/);
  assert.doesNotMatch(script, /Подтверждено в блоке \$\{result\.height\}/);
});

test("only explicit submit actions use the configured local ingress", () => {
  assert.equal((script.match(/fetch\(transactionSubmissionUrl\(nodePolicy\)/g) ?? []).length, 2);
  assert.doesNotMatch(script, /fetch\(nodeUrl\("\/v1\/transactions"\)/);
  assert.match(script, /health\.networkId !== signedResourceTransaction\.networkId/);
  assert.match(script, /currentNetwork\.networkId !== signedTransaction\.networkId/);
});

test("wallet pairs with a local bridge without exposing or persisting secrets", () => {
  assert.match(html, /id="bridge-code"[^>]*pattern="\[0-9\]\{8\}"/);
  assert.match(script, /pairBridge\(url, code\)/);
  assert.match(script, /fetch\(`\$\{url\}\/v1\/pair`/);
  assert.match(script, /x-nir-bridge-token/);
  assert.match(script, /bridgeSession = \{ token, url \}/);
  assert.doesNotMatch(script, /localStorage\.setItem\([^,]*(token|bridge)/i);
  assert.doesNotMatch(script, /localStorage\.setItem\([^,]*(password|private|seed)/i);
  assert.doesNotMatch(html + script, /privateKey/);
  assert.doesNotMatch(html, /<input[^>]+type="password"/);
  assert.match(bridgeCli, /readSecret\("Wallet password: ", \{ signal \}\)/);
  assert.doesNotMatch(bridgeCli, /console\.(?:log|error)\([^\n]*sessionToken/);
  assert.doesNotMatch(bridgeSource, /localStorage|sessionStorage|document\.|window\./);
  assert.doesNotMatch(bridgeSource, /password\s*:\s*(?:request|body)/);
});

test("wallet requires a proof-backed simulation before a separate testnet-only broadcast", () => {
  for (const field of ["transfer-simulation", "resource-simulation", "payment-request-simulation"]) {
    assert.match(html, new RegExp(`id="${field}"`));
  }
  assert.match(script, /bridgeRequest\("\/v1\/simulate-transaction"/);
  assert.match(script, /decodeVerifiedSimulation/);
  assert.match(script, /recheckSimulation/);
  assert.match(script, /assertSignedMatchesIntent/);
  assert.match(script, /signWithRecovery\("\/v1\/sign", pendingIntent, refreshed\.simulationId/);
  assert.match(script, /Симуляция недоступна: состояние не подтверждено кворумом/);
  assert.match(script, /signWithRecovery\("\/v1\/sign"/);
  assert.match(script, /\/v1\/sign-result\/\$\{requestId\}/);
  assert.match(script, /signButton\.disabled = true/);
  assert.match(script, /signButton\.disabled = false/);
  assert.match(html, /id="submit-signed"[^>]*>Отправить в local testnet/);
  assert.match(script, /currentNetwork\.valueMode !== "valueless-devnet"/);
  assert.match(script, /currentNetwork\.networkId !== signedTransaction\.networkId/);
  assert.match(script, /fetch\(transactionSubmissionUrl\(nodePolicy\)/);
  assert.match(script, /Автоматическая отправка намеренно отключена/);
});

test("wallet reports the local node connection state", () => {
  assert.match(script, /selectNodeHealth/);
  assert.match(script, /fetch\(`\$\{url\}\/health`/);
  assert.match(script, /bridgeRequest\("\/v1\/trust-info"/);
  assert.match(script, /networkButton\.classList\.add\("connected"\)/);
  assert.match(script, /networkButton\.classList\.add\("offline"\)/);
  assert.match(styles, /\.network\.connected/);
  assert.match(styles, /\.network\.offline/);
  assert.match(script, /\/v1\/accounts\/\$\{encodeURIComponent\(address\)\}\/proof/);
  assert.match(script, /bridgeRequest\("\/v1\/verify-account-proof"/);
  assert.match(script, /\/v1\/validator-handoffs/);
  assert.match(script, /bridgeRequest\("\/v1\/update-validator-trust"/);
  assert.match(script, /Кворум подтвердил баланс/);
  assert.match(script, /Баланс не подтверждён · ответ узла скрыт/);
});

test("wallet never displays an unverified node balance or stale verified balance", async () => {
  const clearSource = script.slice(script.indexOf("function clearAccountNumbers()"),
    script.indexOf("function resetAccountView("));
  const refreshSource = script.slice(script.indexOf("async function refreshAccount()"),
    script.indexOf("function randomRequestId()"));
  const nodes = new Map();
  const document = { querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: "", hidden: false, disabled: false });
    return nodes.get(selector);
  } };
  nodes.set("#balance-value", { textContent: "5.00000000" });
  const context = {
    document, accountEpoch: 0, accountRefreshSequence: 0,
    walletInfo: { address: `nir1${"a".repeat(64)}` },
    networkInfo: { height: 3 },
    readAccount: async () => ({ atomicBalance: "100000000000000", proofVerified: false,
      resources: { atomicStake: "500000000", availableTransferCredits: "99",
        pendingUnstake: { amount: "100000000", unlockHeight: 4 } } }),
    formatAtomic: (value) => (BigInt(value) / 100000000n).toString(),
    renderTransactions: () => {},
  };
  runInNewContext(`${clearSource}\n${refreshSource}\nglobalThis.refreshAccount = refreshAccount;`, context);
  await context.refreshAccount();
  assert.equal(nodes.get("#balance-value").textContent, "—");
  assert.equal(nodes.get("#resource-stake").textContent, "—");
  assert.equal(nodes.get("#resource-credits").textContent, "—");
  assert.equal(nodes.get("#resource-unstake").textContent, "—");
  assert.equal(nodes.get("#claim-unstake").hidden, true);
  assert.match(nodes.get("#wallet-state").textContent, /не подтвержд/);

  context.readAccount = async () => ({ atomicBalance: "500000000", proofVerified: true,
    proofHeight: 3, resources: { atomicStake: "0", availableTransferCredits: "2",
      pendingUnstake: null } });
  await context.refreshAccount();
  assert.equal(nodes.get("#balance-value").textContent, "5");
  assert.match(nodes.get("#wallet-state").textContent, /Кворум подтвердил баланс/);

  context.readAccount = async () => { throw new Error("node offline"); };
  await context.refreshAccount();
  assert.equal(nodes.get("#balance-value").textContent, "—");
  assert.equal(nodes.get("#resource-credits").textContent, "—");
  assert.match(nodes.get("#wallet-state").textContent, /не подтвержд/);

  context.readAccount = async () => ({ atomicBalance: "500000000", proofVerified: true,
    proofHeight: 3, resources: { atomicStake: "bad", availableTransferCredits: "2",
      pendingUnstake: null } });
  await context.refreshAccount();
  assert.equal(nodes.get("#balance-value").textContent, "—");

  const pending = [];
  context.readAccount = () => new Promise((resolve) => pending.push(resolve));
  const older = context.refreshAccount();
  const newer = context.refreshAccount();
  pending[1]({ atomicBalance: "100000000", proofVerified: false });
  await newer;
  pending[0]({ atomicBalance: "99900000000", proofVerified: true,
    proofHeight: 2, resources: { atomicStake: "0", availableTransferCredits: "0",
      pendingUnstake: null } });
  await older;
  assert.equal(nodes.get("#balance-value").textContent, "—");

  const previousNetwork = context.refreshAccount();
  context.networkInfo = { height: 4, networkId: "different" };
  pending[2]({ atomicBalance: "77700000000", proofVerified: true,
    proofHeight: 3, resources: { atomicStake: "0", availableTransferCredits: "0",
      pendingUnstake: null } });
  await previousNetwork;
  assert.equal(nodes.get("#balance-value").textContent, "—");
});

test("wallet clears a previously proven balance when node selection fails", async () => {
  const clearSource = script.slice(script.indexOf("function clearAccountNumbers()"),
    script.indexOf("function resetAccountView("));
  const refreshSource = script.slice(script.indexOf("async function refreshNodeStatus()"),
    script.indexOf("refreshNodeStatus();\nrenderWalletConnection();"));
  const nodes = new Map([["#balance-value", { textContent: "5.00000000" }],
    ["#wallet-state", { textContent: "Кворум подтвердил баланс · блок 3" }]]);
  const document = { querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: "", hidden: false,
      disabled: false, classList: { add() {}, remove() {} } });
    return nodes.get(selector);
  } };
  const context = { document, accountEpoch: 0, accountRefreshSequence: 0,
    nodeRefreshSequence: 0, networkInfo: { height: 3 }, activeNodeUrl: "http://127.0.0.1:1",
    networkButton: { textContent: "", classList: { add() {}, remove() {} } },
    messages: { network: [] }, selectActiveNode: async () => { throw new Error("offline"); } };
  runInNewContext(`${clearSource}\n${refreshSource}\nglobalThis.refreshNodeStatus = refreshNodeStatus;`,
    context);
  assert.equal(await context.refreshNodeStatus(), false);
  assert.equal(nodes.get("#balance-value").textContent, "—");
  assert.equal(nodes.get("#resource-stake").textContent, "—");
  assert.match(nodes.get("#wallet-state").textContent, /не подтвержд/);
  assert.equal(context.networkInfo, null);
});

test("superseded node refresh cannot authorize a testnet submission", async () => {
  const clearSource = script.slice(script.indexOf("function clearAccountNumbers()"),
    script.indexOf("function resetAccountView("));
  const refreshSource = script.slice(script.indexOf("async function refreshNodeStatus()"),
    script.indexOf("refreshNodeStatus();\nrenderWalletConnection();"));
  const nodes = new Map();
  const document = { querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: "", hidden: false,
      disabled: false, dataset: {}, classList: { add() {}, remove() {} } });
    return nodes.get(selector);
  } };
  const pending = [];
  const context = { document, accountEpoch: 0, accountRefreshSequence: 0,
    nodeRefreshSequence: 0, networkInfo: { height: 3 },
    activeNodeUrl: "http://127.0.0.1:1",
    networkButton: { textContent: "", classList: { add() {}, remove() {} } },
    messages: { network: [] }, assetsStatus: { textContent: "" },
    selectActiveNode: () => new Promise((resolve) => pending.push(resolve)),
    refreshAccount: async () => {},
  };
  runInNewContext(`${clearSource}\n${refreshSource}\nglobalThis.refreshNodeStatus = refreshNodeStatus;`,
    context);
  const first = context.refreshNodeStatus();
  const second = context.refreshNodeStatus();
  pending[0]();
  assert.equal(await first, false);
  assert.equal(context.networkInfo, null);
  context.networkInfo = { height: 4, networkId: "test", agreeingNodes: 2,
    availableNodes: 2 };
  pending[1]();
  assert.equal(await second, true);
});

test("both explicit testnet submissions recheck network through the fail-closed refresh", () => {
  for (const id of ["submit-resource", "submit-signed"]) {
    const start = script.indexOf(`document.querySelector("#${id}").onclick =`);
    assert.notEqual(start, -1);
    const section = script.slice(start, start + 1100);
    assert.match(section, /if \(!\(await refreshNodeStatus\(\)\)\) \{/);
    assert.match(section, /throw new Error\("Сеть не подтверждена; транзакция не отправлена\."\)/);
    assert.doesNotMatch(section, /await selectActiveNode\(\)/);
  }
});

test("wallet creates and verifies signed payment requests before filling a transfer", () => {
  for (const id of ["payment-request-form", "payment-request-json", "payment-request-input",
    "verify-payment-request", "verified-request-note"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /signWithRecovery\("\/v1\/sign-payment-request"/);
  assert.match(script, /bridgeRequest\("\/v1\/verify-payment-request"/);
  assert.match(script, /send-recipient"\)\.value = result\.request\.recipient/);
  assert.match(script, /send-amount"\)\.value = formatAtomic\(result\.request\.amount\)/);
});

test("wallet provides local contacts and local QR payment exchange without automatic sending", () => {
  for (const id of ["contacts-panel", "contacts-list", "contact-label", "contact-address", "contact-network", "confirm-address-change", "receive-qr", "payment-request-qr", "payment-request-qr-frame"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /readAddressBook/);
  assert.match(script, /saveAddressBookContact/);
  assert.match(script, /ADDRESS_CHANGE_CONFIRMATION_REQUIRED/);
  assert.match(script, /drawQr\(document\.querySelector\("#receive-qr"\)/);
  assert.match(script, /encodePaymentQrFrames/);
  assert.match(script, /decodePaymentQrFrames/);
  assert.match(html, /Импорт лишь проверяет и заполняет форму/);
  assert.match(styles, /\.qr-card/);
  assert.match(styles, /\.contact-row/);
});

test("wallet exports a versioned offline signing package and imports no broadcastable result", () => {
  for (const id of ["export-offline-package", "offline-signing-panel", "offline-package-json",
    "offline-package-qr", "offline-signed-input", "verify-offline-signed", "offline-signed-result"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /validateOfflineSigningPackage/);
  assert.match(script, /validateOfflineSignedEnvelope/);
  assert.match(script, /decodeOfflineQrFrames/);
  assert.match(script, /publicBridgeRequest\("\/v1\/verify-offline-signed-package"/);
  assert.match(script, /Artifact verification uses the paired session/);
  assert.match(script, /bridgeRequest\("\/v1\/create-offline-signing-package"/);
  assert.match(script, /Автоматическая отправка намеренно отключена/);
  assert.doesNotMatch(script, /signedTransaction = checked\.transaction/);
  assert.doesNotMatch(script, /localStorage\.setItem\([^,]*(offline|package|signature)/i);
});

test("wallet exposes proof-backed native assets without browser signing or broadcast", () => {
  for (const id of ["assets-panel", "asset-checkpoint", "asset-list", "asset-create-form",
    "asset-mint-form", "asset-transfer-form", "asset-burn-form", "asset-revoke-form",
    "asset-simulation", "export-asset-offline"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const type of ["asset-create", "asset-mint", "asset-transfer", "asset-burn",
    "asset-revoke-authority"]) assert.match(html + script, new RegExp(type));
  assert.match(script, /\/v1\/assets\/\$\{encodeURIComponent\(assetId\)\}\/proof/);
  assert.match(script, /bridgeRequest\("\/v1\/verify-asset-proof"/);
  assert.match(script, /bridgeRequest\("\/v1\/derive-asset-id"/);
  assert.match(script, /recheckAssetSimulation/);
  assert.match(script, /exportOfflineSigningPackage\(pendingAssetIntent, refreshed\)/);
  assert.doesNotMatch(script, /sign-resource[^\n]+pendingAssetIntent/);
  assert.doesNotMatch(script, /signedAssetTransaction/);
  assert.match(html, /Браузер не подписывает и не отправляет asset-операции/);
  assert.match(html, /Загрузка доказанных активов/);
  assert.match(script, /Устарело или ошибка доказательства/);
  assert.match(styles, /#assets-panel \{ max-height: calc\(100vh - 28px\); overflow-y: auto/);
});

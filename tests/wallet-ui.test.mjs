import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../wallet-ui/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../wallet-ui/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../wallet-ui/style.css", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../wallet-ui/sw.js", import.meta.url), "utf8");
const extensionManifest = JSON.parse(readFileSync(
  new URL("../wallet-ui/manifest.json", import.meta.url), "utf8",
));

test("wallet browser module parses as valid JavaScript", () => {
  execFileSync(process.execPath, ["--check", new URL("../wallet-ui/app.js", import.meta.url).pathname]);
});

test("wallet navigation has five interactive destinations", () => {
  for (const destination of ["home", "history", "resources", "mine", "settings"]) {
    assert.match(html, new RegExp(`data-nav="${destination}"`));
  }
  assert.match(script, /querySelectorAll\("\[data-nav\]"\)/);
  assert.match(script, /aria-current/);
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
  assert.match(html, /style\.css\?v=31/);
  assert.match(serviceWorker, /style\.css\?v=31/);
  assert.match(html, /nir-coin-icon\.png\?v=24/);
  assert.match(serviceWorker, /nir-coin-icon\.png\?v=24/);
  assert.match(html, /app\.js\?v=31/);
  assert.match(serviceWorker, /app\.js\?v=31/);
  assert.match(serviceWorker, /nir-wallet-shell-v33/);
  assert.match(serviceWorker, /skipWaiting/);
  assert.match(serviceWorker, /clients\.claim/);
  assert.match(serviceWorker, /node-selection\.js/);
  assert.match(serviceWorker, /address-book\.js/);
  assert.match(serviceWorker, /qr\.js/);
  assert.match(serviceWorker, /transaction-decoder\.js/);
  assert.match(serviceWorker, /offline-signing\.js/);
  assert.match(serviceWorker, /nodes\.json/);
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
  assert.match(html, /aria-live="polite"/);
  assert.deepEqual(extensionManifest.permissions, []);
  assert.deepEqual(extensionManifest.host_permissions,
    ["http://127.0.0.1/*", "http://localhost/*"]);
  assert.match(extensionManifest.content_security_policy.extension_pages, /object-src 'none'/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.match(styles, /forced-colors: active/);
  assert.match(styles, /@media \(max-width: 370px\)/);
  assert.match(styles, /@media \(min-width: 760px\)/);
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
  assert.match(script, /bridgeRequest\("\/v1\/sign-resource"/);
  assert.match(script, /type: "credit-stake"/);
  assert.match(script, /type: "credit-delegation"/);
  assert.match(script, /type: "credit-unstake-request"/);
  assert.match(script, /type: "credit-unstake-claim"/);
  assert.match(html, /id="resource-signed-json"/);
  assert.match(html, /id="submit-resource"[^>]*>Отправить в local testnet/);
  assert.match(script, /signedResourceTransaction = signed\.transaction/);
  assert.match(script, /health\.networkId !== signedResourceTransaction\.networkId/);
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
});

test("wallet requires a proof-backed simulation before a separate testnet-only broadcast", () => {
  for (const field of ["transfer-simulation", "resource-simulation", "payment-request-simulation"]) {
    assert.match(html, new RegExp(`id="${field}"`));
  }
  assert.match(script, /bridgeRequest\("\/v1\/simulate-transaction"/);
  assert.match(script, /decodeVerifiedSimulation/);
  assert.match(script, /recheckSimulation/);
  assert.match(script, /assertSignedMatchesIntent/);
  assert.match(script, /simulationId: refreshed\.simulationId/);
  assert.match(script, /Симуляция недоступна: состояние не подтверждено кворумом/);
  assert.match(script, /bridgeRequest\("\/v1\/sign"/);
  assert.match(script, /signButton\.disabled = true/);
  assert.match(script, /signButton\.disabled = false/);
  assert.match(html, /id="submit-signed"[^>]*>Отправить в local testnet/);
  assert.match(script, /currentNetwork\.valueMode !== "valueless-devnet"/);
  assert.match(script, /currentNetwork\.networkId !== signedTransaction\.networkId/);
  assert.match(script, /fetch\(nodeUrl\("\/v1\/transactions"\)/);
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
  assert.match(script, /\/v1\/accounts\/\$\{encodeURIComponent\(walletInfo\.address\)\}\/proof/);
  assert.match(script, /bridgeRequest\("\/v1\/verify-account-proof"/);
  assert.match(script, /\/v1\/validator-handoffs/);
  assert.match(script, /bridgeRequest\("\/v1\/update-validator-trust"/);
  assert.match(script, /Кворум подтвердил баланс/);
  assert.match(script, /данные одного узла/);
});

test("wallet creates and verifies signed payment requests before filling a transfer", () => {
  for (const id of ["payment-request-form", "payment-request-json", "payment-request-input",
    "verify-payment-request", "verified-request-note"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /bridgeRequest\("\/v1\/sign-payment-request"/);
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

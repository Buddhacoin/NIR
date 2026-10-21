import { normalizeNodePolicy, selectNodeHealth, transactionSubmissionUrl } from "./node-selection.js";
import { ADDRESS_PATTERN, readAddressBook, removeAddressBookContact, saveAddressBookContact } from "./address-book.js";
import { checksumAddress, parseAddress } from "./address-checksum.js";
import { decodePaymentQrFrames, drawQr, encodePaymentQrFrames } from "./qr.js";
import { decodeVerifiedSimulation } from "./transaction-decoder.js";
import { submissionStatus } from "./submission-status.js";
import { canonicalJson, decodeOfflineQrFrames, encodeOfflineQrFrames, validateOfflineSignedEnvelope, validateOfflineSigningPackage } from "./offline-signing.js";
import { translateWalletText } from "./i18n.js";

if (globalThis.top !== globalThis.self) {
  document.documentElement.replaceChildren();
  document.documentElement.textContent = "NIR Wallet cannot run inside a frame.";
  throw new Error("NIR Wallet framing is forbidden");
}

// Presentation state is separate from proof/account state. Language changes
// never trigger a network read, reveal a cached balance or change an intent.
const languageControl = document.querySelector("#language");
const localizedTextNodes = new WeakMap();
const localizedAttributes = new WeakMap();
const language = localStorage.getItem("nir-language") === "en" ? "en" : "ru";
languageControl.value = language;
document.documentElement.lang = language;

function localizeNode(node) {
  if (node.parentElement?.closest("script,style,code,pre,textarea,[data-i18n-ignore]")) return;
  const previous = localizedTextNodes.get(node);
  const source = previous && node.data === previous.rendered ? previous.source : node.data;
  const rendered = translateWalletText(source, document.documentElement.lang);
  localizedTextNodes.set(node, { source, rendered });
  if (node.data !== rendered) node.data = rendered;
}

function localizeAttributes(element) {
  const previous = localizedAttributes.get(element) ?? {};
  const next = { ...previous };
  for (const name of ["aria-label", "placeholder", "title"]) {
    if (!element.hasAttribute(name)) continue;
    const current = element.getAttribute(name);
    const source = previous[name] && current === previous[name].rendered ? previous[name].source : current;
    const rendered = translateWalletText(source, document.documentElement.lang);
    next[name] = { source, rendered };
    if (current !== rendered) element.setAttribute(name, rendered);
  }
  localizedAttributes.set(element, next);
}

function localizeDocument() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) localizeNode(walker.currentNode);
  for (const element of document.body.querySelectorAll("[aria-label],[placeholder],[title]")) {
    localizeAttributes(element);
  }
}

function setLanguage(value) {
  const next = value === "en" ? "en" : "ru";
  document.documentElement.lang = next;
  languageControl.value = next;
  localStorage.setItem("nir-language", next);
  // The native shell persists this non-secret preference across its ephemeral
  // web views. It accepts only ru/en from the exact local wallet page.
  globalThis.window?.webkit?.messageHandlers?.nirLanguage?.postMessage(next);
  localizeDocument();
}

languageControl.addEventListener("change", (event) => setLanguage(event.currentTarget.value));
const languageObserver = new MutationObserver(() => localizeDocument());
languageObserver.observe(document.body, { subtree: true, childList: true, characterData: true,
  attributes: true, attributeFilter: ["aria-label", "placeholder", "title"] });
localizeDocument();

const localApp = new URLSearchParams(location.search).get("local-app") === "1";
if (localApp) {
  document.querySelector("#onboarding ol").replaceChildren();
  document.querySelector("#onboarding > p").textContent =
    "Кошелёк создаётся и открывается в отдельном окне macOS до появления этой страницы. Ключ хранится в зашифрованном файле на этом Mac.";
  document.querySelector("#bridge-panel > p").textContent =
    "Приложение подключает локальный кошелёк автоматически. Пароль вводится только в системном окне подтверждения операции.";
  document.querySelector("#setup-panel > p").textContent =
    "Этот адрес уже выбран в отдельном окне macOS. Чтобы создать или восстановить другой кошелёк, закройте приложение и откройте его снова. Сохраните проверенную зашифрованную копию и код восстановления отдельно.";
  document.querySelector("#setup-panel .setup-steps").hidden = true;
  document.querySelector("#contacts-panel > p").textContent =
    "Контакты доступны только пока открыто это локальное тестовое окно; после закрытия они не сохраняются. Пароль и ключи здесь не хранятся.";
  document.querySelector('[data-action="mine"]').lastChild.textContent = "Майнинг";
  document.querySelector('[data-nav="mine"] span').textContent = "Майнинг";
}

const messages = {
  receive: ["Получить NIR", "Сначала подключите локальный кошелёк, чтобы показать публичный адрес."],
  send: ["Отправить NIR", "Подключите локальный кошелёк. Перед подписью он покажет адрес, сумму, комиссию и процент комиссии."],
  mine: ["Майнинг интеллекта", "Здесь можно будет выбрать роль, проверить оборудование и получить назначенное задание. Сейчас доступен только локальный демонстрационный режим."],
  history: ["История операций", "Операций пока нет. После подключения узла здесь появятся подтверждённые переводы, комиссии и награды."],
  resources: ["Ресурсы сети", "Заблокируйте NIR, чтобы получать Transfer Credits или безопасно делегировать лимит переводов другому адресу."],
  settings: ["Настройки", "Переключение темы уже работает. Session token хранится только в памяти страницы и исчезает при её закрытии."],
  network: ["Локальная тестовая сеть", "Это локальная тестовая сеть. Реальные NIR и вывод средств отключены."],
};

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8788";
const NIR_ADDRESS = ADDRESS_PATTERN;
const panel = document.querySelector("#panel");
const panelTitle = document.querySelector("#panel-title");
const panelCopy = document.querySelector("#panel-copy");
const bridgePanel = document.querySelector("#bridge-panel");
const accountsPanel = document.querySelector("#accounts-panel");
const accountOpen = document.querySelector("#account-open");
const accountsStatus = document.querySelector("#accounts-status");
const receivePanel = document.querySelector("#receive-panel");
const sendPanel = document.querySelector("#send-panel");
const resourcesPanel = document.querySelector("#resources-panel");
const assetsPanel = document.querySelector("#assets-panel");
const settingsPanel = document.querySelector("#settings-panel");
const setupPanel = document.querySelector("#setup-panel");
const contactsPanel = document.querySelector("#contacts-panel");
const offlineSigningPanel = document.querySelector("#offline-signing-panel");
const onboarding = document.querySelector("#onboarding");
const homePage = document.querySelector("#home-page");
const pageHost = document.querySelector("#page-host");
const miningPanel = document.querySelector("#mining-panel");
const pageDialogs = [panel, accountsPanel, bridgePanel, receivePanel, sendPanel,
  offlineSigningPanel, contactsPanel, resourcesPanel, assetsPanel, settingsPanel, setupPanel, miningPanel];
let activePage = null;
let pageTrail = [];
let activeTab = "home";
let pageNavigationEpoch = 0;
for (const page of pageDialogs) {
  page.classList.add("page-view");
  page.hidden = true;
  pageHost.append(page);
  const back = page.querySelector(":scope > .close");
  if (back) { back.textContent = "←"; back.setAttribute("aria-label", "Назад"); }
  page.addEventListener("close", () => {
    if (page.open) return;
    page.hidden = true;
    if (activePage !== page) return;
    pageNavigationEpoch += 1;
    activePage = null;
    while (pageTrail.length) {
      const previous = pageTrail.pop();
      if (previous.open) {
        previous.hidden = false;
        activePage = previous;
        focusPageHeading(previous);
        window.scrollTo({ top: 0, behavior: "instant" });
        return;
      }
    }
    showHomeTab(activeTab === "history" ? "history" : "home");
  });
}

function focusPageHeading(page) {
  const heading = page.querySelector(":scope > h2");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

function setActiveTab(destination) {
  activeTab = destination;
  for (const button of document.querySelectorAll("[data-nav]")) {
    const selected = button.dataset.nav === destination;
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

function clearOpenPages() {
  activePage = null;
  pageTrail = [];
  for (const page of pageDialogs) {
    page.hidden = true;
    if (page.open) page.close();
  }
}

function showHomeTab(destination = "home") {
  pageNavigationEpoch += 1;
  clearOpenPages();
  homePage.hidden = false;
  homePage.dataset.view = destination;
  document.querySelector("#history .title h2").textContent =
    destination === "history" ? "История операций" : "Последние операции";
  setActiveTab(destination);
  if (destination === "history") {
    const heading = document.querySelector("#history .title h2");
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0, behavior: "instant" });
}

function openPage(page, tab = null) {
  if (activePage === page) return;
  pageNavigationEpoch += 1;
  if (tab) {
    clearOpenPages();
    setActiveTab(tab);
  } else if (activePage) {
    activePage.hidden = true;
    pageTrail.push(activePage);
  }
  homePage.hidden = true;
  if (!page.open) page.show();
  page.hidden = false;
  activePage = page;
  focusPageHeading(page);
  window.scrollTo({ top: 0, behavior: "instant" });
}
const bridgeStatus = document.querySelector("#bridge-status");
const receiveStatus = document.querySelector("#receive-status");
const sendStatus = document.querySelector("#send-status");
const resourcesStatus = document.querySelector("#resources-status");
const assetsStatus = document.querySelector("#assets-status");
let bridgeSession = null;
let walletInfo = null;
let accountEpoch = 0;
let accountRefreshSequence = 0;
let nodeRefreshSequence = 0;
let accountTransitionPending = false;
let networkInfo = null;
let activeNodeUrl = null;
let chainNameCurrent = null;
let chainNameCheckEpoch = 0;
let nodePolicy = null;
let pendingIntent = null;
let pendingSimulation = null;
let pendingResourceIntent = null;
let pendingPaymentRequest = null;
let pendingAssetIntent = null;
let pendingAssetSimulation = null;
let verifiedAssetStatements = new Map();
const knownAssetIds = new Set();
let signedTransaction = null;
let signedResourceTransaction = null;
let addressBook = readAddressBook();
let pendingAddressChange = null;
let paymentRequestQrFrames = [];
let paymentRequestQrIndex = 0;
let offlineSigningPackage = null;
let offlinePackageQrFrames = [];
let offlinePackageQrIndex = 0;
let nativeConnectionError = null;

function renderWalletConnection() {
  const connected = Boolean(walletInfo && bridgeSession);
  onboarding.hidden = connected || localApp;
  const nativeError = document.querySelector("#native-connection-error");
  nativeError.hidden = !localApp || connected || !nativeConnectionError;
  nativeError.textContent = nativeError.hidden ? "" : nativeConnectionError;
  accountOpen.hidden = !connected;
  document.querySelector("#disconnect-wallet").hidden = !connected;
  document.querySelector("#settings-connect").hidden = connected || localApp;
  document.querySelector("#settings-secrets").hidden = !connected ||
    walletInfo.nativeSecurityAvailable !== true;
  document.querySelector("#settings-password-change").hidden = !connected ||
    walletInfo.nativePasswordChangeAvailable !== true;
  document.querySelector("#security-state").textContent = connected
    ? `Кошелёк подключён · ${walletInfo.address.slice(0, 16)}…`
    : (localApp && nativeConnectionError) || "Кошелёк не подключён";
}

function clearAccountNumbers() {
  document.querySelector("#balance-value").textContent = "—";
  document.querySelector("#resource-stake").textContent = "—";
  document.querySelector("#resource-credits").textContent = "—";
  document.querySelector("#resource-unstake").textContent = "—";
  document.querySelector("#claim-unstake").hidden = true;
  document.querySelector("#claim-unstake").disabled = true;
}

function resetAccountView(message) {
  accountEpoch += 1;
  accountRefreshSequence += 1;
  nodeRefreshSequence += 1;
  pendingIntent = null;
  signedTransaction = null;
  signedResourceTransaction = null;
  pendingSimulation = null;
  pendingResourceIntent = null;
  pendingPaymentRequest = null;
  pendingAssetIntent = null;
  pendingAssetSimulation = null;
  verifiedAssetStatements = new Map();
  knownAssetIds.clear();
  offlineSigningPackage = null;
  offlinePackageQrFrames = [];
  clearAccountNumbers();
  document.querySelector("#wallet-state").textContent = message;
  document.querySelector("#signed-json").value = "";
  document.querySelector("#resource-signed-json").value = "";
  document.querySelector("#send-review").hidden = true;
  document.querySelector("#signed-result").hidden = true;
  document.querySelector("#transfer-simulation").hidden = true;
  document.querySelector("#resource-signed").hidden = true;
  document.querySelector("#receive-address").textContent = "";
  document.querySelector("#receive-network").textContent = "";
  document.querySelector("#payment-request-json").value = "";
  document.querySelector("#payment-request-result").hidden = true;
  document.querySelector("#transaction-list").replaceChildren();
  document.querySelector("#transaction-list").hidden = true;
  document.querySelector("#history-empty").hidden = false;
  document.querySelector("#history-empty b").textContent = "Операций пока нет";
  document.querySelector("#history-empty p").textContent = "Ожидаем проверки выбранного адреса.";
  messages.history = ["История операций", "История выбранного адреса ещё не проверена."];
  document.querySelector("#asset-list").replaceChildren();
  document.querySelector("#asset-checkpoint").dataset.state = "stale";
  document.querySelector("#asset-checkpoint").textContent = "Доказательства ещё не проверены";
  networkInfo = null;
  activeNodeUrl = null;
}

function clearWalletSession(message = "Кошелёк отключён · ключи и session token отсутствуют в странице") {
  if (localApp && bridgeSession && !nativeConnectionError) {
    nativeConnectionError = "Сеанс закрыт. Чтобы подключиться снова, перезапустите NIR Wallet.";
  }
  bridgeSession = null;
  walletInfo = null;
  resetAccountView(message);
  if (accountsPanel.open) accountsPanel.close();
  renderWalletConnection();
}

function setText(id, value) { document.querySelector(id).textContent = value; }

function clearSimulation(target) {
  document.querySelector(target).hidden = true;
}

function renderSimulation(target, simulation) {
  const root = document.querySelector(target);
  const fields = root.querySelector(".simulation-fields");
  const risks = root.querySelector(".simulation-risks");
  fields.replaceChildren(); risks.replaceChildren();
  const add = (term, value, { termContainsProtocol = false } = {}) => {
    const row = document.createElement("div");
    const dt = document.createElement("dt"); const dd = document.createElement("dd");
    // The verifier supplied value is protocol data. Never translate it, even
    // when an arbitrary role/risk happens to match a UI label.
    dd.dataset.i18nIgnore = "";
    if (termContainsProtocol) dt.dataset.i18nIgnore = "";
    dt.textContent = term; dd.textContent = value; row.append(dt, dd); fields.append(row);
  };
  add("Операция", simulation.type);
  add("Сеть", `${simulation.networkId} · состояние на блоке ${simulation.stateHeight}`);
  add("Полномочия", simulation.authority.map((item) => `${item.role}: ${item.address}`).join(" · "));
  add("Комиссия", `${formatAtomic(simulation.fee.amount)} NIR · платит ${simulation.fee.payer ?? "ресурс сети"}`);
  for (const effect of simulation.balance) {
    const sign = BigInt(effect.delta) > 0n ? "+" : "";
    add(`Баланс: ${effect.role}`, `${effect.address ?? "получатель комиссии"}: ${sign}${effect.delta} atomic NIR`, { termContainsProtocol: true });
  }
  for (const resource of simulation.resources) add(`Ресурс: ${resource.role}`, resource.details || "изменение подтверждено", { termContainsProtocol: true });
  for (const asset of simulation.assets ?? []) add("Актив", asset.details || `${asset.assetId}: изменение подтверждено`);
  for (const nonce of simulation.nonces) add(`Nonce: ${nonce.role}`, `${nonce.address}: ${nonce.before} → ${nonce.after}`, { termContainsProtocol: true });
  for (const risk of simulation.risks) {
    const item = document.createElement("li"); item.className = "risk-info";
    item.dataset.i18nIgnore = "";
    item.textContent = risk; risks.append(item);
  }
  root.hidden = false;
}

async function simulateIntent(intent, account) {
  if (!account?.proofVerified) throw new Error("Симуляция недоступна: состояние не подтверждено кворумом.");
  const result = await bridgeRequest("/v1/simulate-transaction", {
    method: "POST",
    body: JSON.stringify({
      intent,
      verifiedAccount: { statement: account, height: account.proofHeight, proofVerified: account.proofVerified },
      network: { networkId: networkInfo?.networkId, height: networkInfo?.height, valueMode: networkInfo?.valueMode },
    }),
  });
  return decodeVerifiedSimulation(result, intent);
}

function sameSimulation(a, b) {
  const { simulationId: _a, ...left } = a;
  const { simulationId: _b, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertSignedMatchesIntent(transaction, intent) {
  if (!transaction || typeof transaction !== "object") throw new Error("Bridge вернул некорректную подписанную операцию.");
  for (const [key, value] of Object.entries(intent)) {
    if (transaction[key] !== value) throw new Error(`Подписанная операция отличается от проверенного намерения: ${key}.`);
  }
}

async function recheckSimulation(intent, previous) {
  const account = await readAccount();
  if (!account.proofVerified || (intent.nonce !== undefined && account.nextNonce !== intent.nonce)) {
    throw new Error("Состояние или nonce изменились после проверки. Подпись отменена.");
  }
  const refreshed = await simulateIntent(intent, account);
  if (!sameSimulation(previous, refreshed)) {
    throw new Error("Результат симуляции изменился. Подпись отменена; проверьте новую операцию.");
  }
  return refreshed;
}

function showMessage(key, copy = null, tab = null) {
  const [title, defaultCopy] = messages[key];
  panelTitle.textContent = title;
  panelCopy.textContent = copy ?? defaultCopy;
  openPage(panel, tab);
}

function exactLoopbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Разрешён только точный локальный адрес bridge.");
  }
  return url.origin;
}

async function bridgeRequest(path, options = {}, timeoutMs = 30_000) {
  if (!bridgeSession) throw new Error("Сначала подключите кошелёк.");
  const session = bridgeSession;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${session.url}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "x-nir-bridge-token": session.token,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401 && bridgeSession === session) {
        clearWalletSession("Сессия кошелька завершена · подключитесь снова");
      }
      throw new Error(result.error || "Локальный bridge отклонил запрос.");
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function signWithRecovery(path, intent, simulationId, onWait) {
  const requestId = intent.requestId;
  let result;
  try {
    result = await bridgeRequest(path, {
      method: "POST", body: JSON.stringify({ ...intent, simulationId }),
    });
  } catch (error) {
    if (error.name !== "AbortError" && !(error instanceof TypeError)) throw error;
    onWait?.();
    const deadline = Date.now() + 130_000;
    while (Date.now() < deadline) {
      const recovered = await bridgeRequest(`/v1/sign-result/${requestId}`, {}, 5_000);
      if (recovered.status !== "pending") {
        result = recovered;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (!result) throw new Error(localApp
      ? "Время подтверждения истекло. Проверьте окно macOS и начните новый запрос."
      : "Время подтверждения истекло. Проверьте терминал и начните новый запрос.");
  }
  if (result.requestId !== requestId) throw new Error("Bridge вернул результат другого запроса подписи.");
  return result;
}

/** Artifact verification uses the paired session but never decrypts or signs with the vault. */
async function publicBridgeRequest(path, options = {}) {
  if (!bridgeSession?.url) throw new Error("Сначала подключите локальный bridge для публичной проверки подписи.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${bridgeSession.url}${path}`, {
      ...options, signal: controller.signal,
      headers: {
        "x-nir-bridge-token": bridgeSession.token,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
    });
    let result;
    try { result = await response.json(); } catch { throw new Error("Публичная проверка вернула не JSON."); }
    if (response.status === 404 || response.status === 405) {
      throw new Error("Этот bridge ещё не поддерживает проверку офлайн-подписей. Обновите проверенную установку.");
    }
    if (!response.ok || result.verified !== true) throw new Error(result.error || "Публичная проверка подписи не пройдена.");
    return result;
  } finally { clearTimeout(timeout); }
}

async function pairBridge(url, code) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${url}/v1/pair`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const result = await response.json();
    if (!response.ok || !/^[0-9a-f]{64}$/.test(result.sessionToken ?? "")) {
      throw new Error(result.error || "Bridge вернул неверный session token.");
    }
    return result.sessionToken;
  } finally {
    clearTimeout(timeout);
  }
}

function parseNir(value) {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/.exec(value.trim());
  if (!match) throw new Error("Введите положительную сумму, не более 8 знаков после точки.");
  const atomic = BigInt(match[1]) * 100_000_000n + BigInt((match[2] ?? "").padEnd(8, "0") || "0");
  if (atomic <= 0n) throw new Error("Сумма должна быть больше нуля.");
  return atomic.toString();
}

function formatAtomic(value) {
  const atomic = BigInt(value);
  const fraction = (atomic % 100_000_000n).toString().padStart(8, "0");
  return `${atomic / 100_000_000n}.${fraction}`;
}

function nodeUrl(path) {
  if (!activeNodeUrl) throw new Error("Нет подтверждённого узла NIR.");
  return `${activeNodeUrl}${path}`;
}

async function readAccount() {
  if (!walletInfo || !networkInfo) throw new Error("Подключите кошелёк и локальный узел.");
  const address = walletInfo.address;
  const { height: minimumHeight, networkId } = networkInfo;
  try {
    const handoffResponse = await fetch(nodeUrl("/v1/validator-handoffs"));
    if (handoffResponse.ok) {
      const history = await handoffResponse.json();
      await bridgeRequest("/v1/update-validator-trust", {
        method: "POST", body: JSON.stringify({ handoffs: history.handoffs }),
      });
    }
    const trust = await bridgeRequest("/v1/trust-info");
    if (trust.enabled && trust.tipHash && minimumHeight > trust.minimumHeight) {
      let verifiedHeight = trust.minimumHeight;
      while (verifiedHeight < minimumHeight) {
        const finalityResponse = await fetch(nodeUrl(
          `/v1/finality-proofs?fromHeight=${verifiedHeight}&limit=512`,
        ));
        if (!finalityResponse.ok) throw new Error("finality proofs unavailable");
        const { proofs } = await finalityResponse.json();
        if (!Array.isArray(proofs) || proofs.length === 0) {
          throw new Error("finality proof chain is incomplete");
        }
        const verifiedChain = await bridgeRequest("/v1/verify-finality-chain", {
          method: "POST", body: JSON.stringify({ proofs }),
        });
        if (!verifiedChain.verified || verifiedChain.tip.height <= verifiedHeight) {
          throw new Error("finality proof chain did not advance");
        }
        verifiedHeight = verifiedChain.tip.height;
      }
    }
    const proofResponse = await fetch(
      nodeUrl(`/v1/accounts/${encodeURIComponent(address)}/proof`),
    );
    if (!proofResponse.ok) throw new Error("proof unavailable");
    const proof = await proofResponse.json();
    const verified = await bridgeRequest("/v1/verify-account-proof", {
      method: "POST",
      body: JSON.stringify({
        address,
        minimumHeight,
        proof,
      }),
    });
    if (verified.verified !== true || verified.statement?.account?.address !== address ||
        verified.statement.networkId !== networkId ||
        !Number.isSafeInteger(verified.statement.height) ||
        verified.statement.height < minimumHeight) {
      throw new Error("account proof does not match the selected wallet and network");
    }
    const historyCount = verified.statement.account.history.count;
    const historyResponse = await fetch(nodeUrl(
      `/v1/accounts/${encodeURIComponent(address)}/history?before=${historyCount}&limit=20`,
    ));
    if (!historyResponse.ok) throw new Error("account history page unavailable");
    const verifiedHistory = await bridgeRequest("/v1/verify-account-history-page", {
      method: "POST",
      body: JSON.stringify({ before: historyCount, limit: 20, page: await historyResponse.json() }),
    });
    if (!verifiedHistory.verified) throw new Error("account history page proof failed");
    const verifiedTransactions = [];
    let unavailableTransactions = 0;
    const recent = [...verifiedHistory.entries].reverse();
    for (const summary of recent) {
      try {
        const transactionResponse = await fetch(nodeUrl(
          `/v1/transactions/${encodeURIComponent(summary.id)}/proof`,
        ));
        if (!transactionResponse.ok) throw new Error("transaction proof unavailable");
        const result = await bridgeRequest("/v1/verify-transaction-proof", {
          method: "POST",
          body: JSON.stringify({
            proof: await transactionResponse.json(), transactionId: summary.id,
          }),
        });
        if (!result.verified || result.transactionId !== summary.id) {
          throw new Error("transaction proof was not accepted");
        }
        verifiedTransactions.push(result);
      } catch {
        unavailableTransactions += 1;
      }
    }
    return {
      ...verified.statement.account,
      proofHeight: verified.statement.height,
      proofStateRoot: verified.statement.stateRoot,
      proofTipHash: verified.statement.tipHash,
      proofVerified: true,
      unavailableTransactions,
      verifiedTransactions,
    };
  } catch {
    return { proofVerified: false };
  }
}

function renderTransactions(account) {
  const empty = document.querySelector("#history-empty");
  const list = document.querySelector("#transaction-list");
  list.replaceChildren();
  if (!account.proofVerified) {
    list.hidden = true;
    empty.hidden = false;
    empty.querySelector("b").textContent = "История не подтверждена";
    empty.querySelector("p").textContent = "Кошелёк не получил доказательства от кворума.";
    messages.history = ["История операций", "Неподтверждённые ответы узла скрыты."];
    return;
  }
  const transactions = account.verifiedTransactions ?? [];
  if (transactions.length === 0) {
    list.hidden = true;
    empty.hidden = false;
    empty.querySelector("b").textContent = "Подтверждённых операций нет";
    empty.querySelector("p").textContent = "История проверена по финализированным заголовкам.";
  } else {
    empty.hidden = true;
    list.hidden = false;
    for (const item of transactions) {
      const transaction = item.transaction;
      const incoming = transaction.recipient === walletInfo.address &&
        transaction.sender !== walletInfo.address;
      const row = document.createElement("div");
      row.className = "transaction-row";
      const symbol = document.createElement("i");
      symbol.textContent = incoming ? "↓" : transaction.type === "transfer" ? "↑" : "✓";
      const description = document.createElement("div");
      const title = document.createElement("b");
      title.textContent = transaction.type === "transfer"
        ? incoming ? "Получено" : "Отправлено"
        : "Операция сети";
      const details = document.createElement("span");
      details.textContent = `Блок ${item.height} · ${item.transactionId.slice(0, 10)}… · доказано`;
      description.append(title, details);
      const amount = document.createElement("strong");
      amount.textContent = transaction.amount === undefined ? "✓"
        : `${incoming ? "+" : "−"}${formatAtomic(transaction.amount)} NIR`;
      row.append(symbol, description, amount);
      list.append(row);
    }
  }
  const unavailable = account.unavailableTransactions ?? 0;
  messages.history = [
    "Проверенная история",
    `${transactions.length} операций доказаны заголовками финализированных блоков.` +
      (unavailable ? ` ${unavailable} неподтверждённых ответов скрыто.` : ""),
  ];
}

async function refreshAccount() {
  if (!walletInfo || !networkInfo) return;
  const expectedAddress = walletInfo.address;
  const epoch = accountEpoch;
  const expectedNetwork = networkInfo;
  const refreshSequence = ++accountRefreshSequence;
  const isCurrent = () => epoch === accountEpoch &&
    refreshSequence === accountRefreshSequence && walletInfo?.address === expectedAddress &&
    networkInfo === expectedNetwork;
  clearAccountNumbers();
  document.querySelector("#wallet-state").textContent = "Проверяем доказательство баланса…";
  try {
    const account = await readAccount();
    if (!isCurrent()) return;
    if (!account.proofVerified) {
      document.querySelector("#wallet-state").textContent = "Баланс не подтверждён · ответ узла скрыт";
      renderTransactions(account);
      return;
    }
    document.querySelector("#balance-value").textContent = formatAtomic(account.atomicBalance);
    const resources = account.resources ?? {};
    document.querySelector("#resource-stake").textContent = `${formatAtomic(resources.atomicStake ?? "0")} NIR`;
    document.querySelector("#resource-credits").textContent = `${resources.availableTransferCredits ?? "0"} переводов`;
    const pending = resources.pendingUnstake;
    document.querySelector("#resource-unstake").textContent = pending
      ? `${formatAtomic(pending.amount)} NIR · блок ${pending.unlockHeight}` : "Нет";
    const claim = document.querySelector("#claim-unstake");
    claim.hidden = !pending;
    claim.disabled = Boolean(pending && networkInfo.height < pending.unlockHeight);
    claim.textContent = pending && networkInfo.height < pending.unlockHeight
      ? `Доступно с блока ${pending.unlockHeight}` : "Завершить вывод";
    document.querySelector("#wallet-state").textContent =
      `Кворум подтвердил баланс · блок ${account.proofHeight}`;
    renderTransactions(account);
  } catch {
    if (!isCurrent()) return;
    clearAccountNumbers();
    document.querySelector("#wallet-state").textContent =
      "Баланс не подтверждён · локальный узел недоступен";
  }
}

function randomRequestId() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function activeNetworkId() {
  if (!networkInfo?.networkId) throw new Error("Сначала подключите и проверьте сеть.");
  return networkInfo.networkId;
}

function setContactForm(contact = null) {
  document.querySelector("#contact-id").value = contact?.id ?? "";
  document.querySelector("#contact-label").value = contact?.label ?? "";
  document.querySelector("#contact-address").value = contact?.address ?? "";
  document.querySelector("#contact-network").value = contact?.networkId ?? activeNetworkId();
}

function renderContacts() {
  const list = document.querySelector("#contacts-list");
  const network = activeNetworkId();
  list.replaceChildren();
  const matching = addressBook.filter((contact) => contact.networkId === network);
  if (!matching.length) {
    const empty = document.createElement("p");
    empty.className = "contact-empty";
    empty.textContent = "В этой сети контактов пока нет.";
    list.append(empty);
    return;
  }
  for (const contact of matching) {
    const row = document.createElement("div"); row.className = "contact-row";
    const copy = document.createElement("div");
    const label = document.createElement("b"); label.textContent = contact.label;
    const address = document.createElement("span"); address.textContent = checksumAddress(contact.address);
    address.setAttribute("aria-label", `Полный адрес ${contact.address}, сеть ${contact.networkId}`);
    copy.append(label, address);
    const use = document.createElement("button"); use.type = "button"; use.className = "secondary compact"; use.textContent = "Выбрать";
    use.onclick = () => {
      document.querySelector("#send-recipient").value = checksumAddress(contact.address);
      document.querySelector("#verified-request-note").textContent = `Контакт «${contact.label}» · сеть ${contact.networkId}`;
      contactsPanel.close();
      sendStatus.textContent = "Контакт выбран. Проверьте полный адрес и сумму перед подписью.";
    };
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "icon-button"; edit.textContent = "Изменить";
    edit.onclick = () => setContactForm(contact);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "icon-button"; remove.textContent = "Удалить";
    remove.onclick = () => {
      addressBook = removeAddressBookContact({ contacts: addressBook, id: contact.id });
      renderContacts(); document.querySelector("#contacts-status").textContent = "Контакт удалён только из этого браузера.";
    };
    const controls = document.createElement("div"); controls.className = "contact-controls"; controls.append(use, edit, remove);
    row.append(copy, controls); list.append(row);
  }
}

function openContacts() {
  if (!walletInfo) return openBridgePanel();
  try {
    const network = activeNetworkId();
    document.querySelector("#contacts-network").textContent = `Активная сеть: ${network}`;
    document.querySelector("#contacts-status").textContent = "";
    document.querySelector("#address-change-warning").hidden = true;
    pendingAddressChange = null;
    setContactForm(); renderContacts(); openPage(contactsPanel);
  } catch (error) { sendStatus.textContent = error.message; }
}

function saveContact(confirmAddressChange = false) {
  const networkId = activeNetworkId();
  const form = {
    id: document.querySelector("#contact-id").value || undefined,
    label: document.querySelector("#contact-label").value,
    address: document.querySelector("#contact-address").value,
    networkId,
  };
  const saved = saveAddressBookContact({ contacts: addressBook, candidate: form, confirmAddressChange });
  addressBook = saved.contacts;
  pendingAddressChange = null;
  document.querySelector("#address-change-warning").hidden = true;
  document.querySelector("#contacts-status").textContent = "Контакт сохранён локально. Перевод не создан.";
  setContactForm(); renderContacts();
}

function renderPaymentQrFrame() {
  const frame = paymentRequestQrFrames[paymentRequestQrIndex];
  if (!frame) return;
  drawQr(document.querySelector("#payment-request-qr"), frame, `QR-фрагмент платёжного запроса ${paymentRequestQrIndex + 1} из ${paymentRequestQrFrames.length}`);
  document.querySelector("#payment-request-qr-frame").value = frame;
  document.querySelector("#payment-request-qr-label").textContent = `Фрагмент ${paymentRequestQrIndex + 1} из ${paymentRequestQrFrames.length}. При импорте нужны все фрагменты.`;
  document.querySelector("#previous-payment-request-qr").disabled = paymentRequestQrIndex === 0;
  document.querySelector("#next-payment-request-qr").disabled = paymentRequestQrIndex === paymentRequestQrFrames.length - 1;
}

function renderOfflinePackageQrFrame() {
  const frame = offlinePackageQrFrames[offlinePackageQrIndex];
  if (!frame) return;
  drawQr(document.querySelector("#offline-package-qr"), frame,
    `QR-фрагмент пакета офлайн-подписи ${offlinePackageQrIndex + 1} из ${offlinePackageQrFrames.length}`);
  document.querySelector("#offline-package-qr-frame").value = frame;
  document.querySelector("#offline-package-qr-label").textContent =
    `Фрагмент ${offlinePackageQrIndex + 1} из ${offlinePackageQrFrames.length}. На офлайн-устройстве нужны все фрагменты.`;
  document.querySelector("#previous-offline-package-qr").disabled = offlinePackageQrIndex === 0;
  document.querySelector("#next-offline-package-qr").disabled = offlinePackageQrIndex === offlinePackageQrFrames.length - 1;
}

async function exportOfflineSigningPackage(intent, simulation) {
  const status = document.querySelector("#offline-signing-status");
  status.textContent = "Подготовка проверенного офлайн-пакета…";
  try {
    const result = await bridgeRequest("/v1/create-offline-signing-package", {
      method: "POST", body: JSON.stringify({ simulationId: simulation.simulationId }),
    });
    offlineSigningPackage = validateOfflineSigningPackage(result.signingPackage ?? result.package);
    offlinePackageQrFrames = []; offlinePackageQrIndex = 0;
    document.querySelector("#offline-package-json").value = JSON.stringify(offlineSigningPackage, null, 2);
    document.querySelector("#offline-package-summary").textContent =
      `Сеть: ${offlineSigningPackage.networkId} · checkpoint: ${offlineSigningPackage.checkpoint.height} · действует до ${new Date(offlineSigningPackage.expiresAt).toLocaleTimeString()}.`;
    document.querySelector("#offline-package-export").hidden = false;
    document.querySelector("#offline-package-qr-card").hidden = true;
    document.querySelector("#offline-signed-result").hidden = true;
    document.querySelector("#offline-signed-input").value = "";
    status.textContent = "Пакет создан. Его создание не подписывает и не отправляет операцию.";
    openPage(offlineSigningPanel);
  } catch (error) { status.textContent = error.message; }
}

async function openResources() {
  if (!walletInfo) return openBridgePanel();
  resourcesStatus.textContent = "Обновление…";
  openPage(resourcesPanel, "resources");
  await refreshAccount();
  resourcesStatus.textContent = "";
}

const ASSET_ID = /^[0-9a-f]{64}$/;
const ASSET_UNITS = /^(0|[1-9][0-9]{0,31})$/;

function assetIdsFromVerifiedHistory(account) {
  const ids = new Set();
  for (const entry of account.verifiedTransactions ?? []) {
    const id = entry.transaction?.assetId;
    if (ASSET_ID.test(id ?? "") && id !== "0".repeat(64)) ids.add(id);
  }
  return ids;
}

function checkedAssetStatement(value, assetId, holder) {
  const statement = value?.statement;
  if (value?.verified !== true || !statement || statement.assetId !== assetId ||
      statement.holder !== holder || statement.networkId !== networkInfo?.networkId ||
      !Number.isSafeInteger(statement.height) || statement.height !== networkInfo.height ||
      !/^[0-9a-f]{64}$/.test(statement.stateRoot ?? "") ||
      !/^[0-9a-f]{64}$/.test(statement.tipHash ?? "") ||
      !ASSET_UNITS.test(statement.balance ?? "")) {
    throw new Error("Asset proof не совпадает с текущим проверенным checkpoint.");
  }
  if (statement.asset !== null && (statement.asset.assetId !== assetId ||
      !/^[0-9a-f]{64}$/.test(statement.asset.metadataHash ?? "") ||
      !ASSET_UNITS.test(statement.asset.supply ?? "") ||
      !ASSET_UNITS.test(statement.asset.maxSupply ?? ""))) {
    throw new Error("Bridge вернул некорректное доказанное состояние актива.");
  }
  return statement;
}

async function verifyAssetState(assetId, holder) {
  if (!ASSET_ID.test(assetId ?? "") || assetId === "0".repeat(64) || !NIR_ADDRESS.test(holder ?? "")) {
    throw new Error("Asset ID или адрес holder неверен.");
  }
  const epoch = accountEpoch;
  const address = walletInfo?.address;
  const assertCurrent = () => {
    if (epoch !== accountEpoch || walletInfo?.address !== address) {
      throw new Error("Кошелёк изменился во время проверки актива.");
    }
  };
  const response = await fetch(nodeUrl(`/v1/assets/${encodeURIComponent(assetId)}/proof?holder=${encodeURIComponent(holder)}`),
    { cache: "no-store" });
  assertCurrent();
  if (!response.ok) throw new Error("Узел не предоставил кворумное доказательство актива.");
  const proof = await response.json();
  assertCurrent();
  const verified = await bridgeRequest("/v1/verify-asset-proof", { method: "POST", body: JSON.stringify({
    assetId, holder, minimumHeight: networkInfo.height, proof,
  }) });
  assertCurrent();
  const statement = checkedAssetStatement(verified, assetId, holder);
  verifiedAssetStatements.set(`${assetId}:${holder}`, statement);
  if (holder === walletInfo.address && statement.asset !== null) knownAssetIds.add(assetId);
  return statement;
}

function renderVerifiedAssets(statements) {
  const list = document.querySelector("#asset-list");
  list.replaceChildren();
  const visible = statements.filter(({ asset }) => asset !== null);
  if (visible.length === 0) {
    const empty = document.createElement("p"); empty.className = "contact-empty";
    empty.textContent = "Нет обнаруженных доказанных активов. Asset ID берутся только из проверенной истории этой сессии.";
    list.append(empty); return;
  }
  for (const statement of visible) {
    const row = document.createElement("article"); row.className = "asset-row";
    row.dataset.i18nIgnore = "";
    const title = document.createElement("b"); title.textContent = `${statement.balance} units`;
    const id = document.createElement("span"); id.textContent = `ID ${statement.assetId}`;
    const metadata = document.createElement("span"); metadata.textContent = `metadata ${statement.asset.metadataHash}`;
    const supply = document.createElement("span"); supply.textContent =
      `supply ${statement.asset.supply} / max ${statement.asset.maxSupply} · authority ${statement.asset.authority ?? "отозвана"}`;
    row.append(title, id, metadata, supply); list.append(row);
  }
}

async function refreshAssets() {
  const epoch = accountEpoch;
  const address = walletInfo?.address;
  const isCurrent = () => epoch === accountEpoch && walletInfo?.address === address;
  const list = document.querySelector("#asset-list");
  const checkpoint = document.querySelector("#asset-checkpoint");
  const loading = document.createElement("p"); loading.className = "contact-empty";
  loading.textContent = "Загрузка кворумных доказательств…"; list.replaceChildren(loading);
  checkpoint.textContent = "Проверка checkpoint…"; checkpoint.dataset.state = "loading";
  assetsStatus.textContent = "";
  try {
    const account = await readAccount();
    if (!isCurrent()) return;
    if (!account.proofVerified) throw new Error("Список недоступен: account state не подтверждён кворумом.");
    for (const id of assetIdsFromVerifiedHistory(account)) knownAssetIds.add(id);
    const statements = [];
    for (const assetId of [...knownAssetIds].sort()) {
      statements.push(await verifyAssetState(assetId, address));
      if (!isCurrent()) return;
    }
    renderVerifiedAssets(statements);
    const state = statements[0];
    checkpoint.textContent = state
      ? `Проверено · блок ${state.height} · root ${state.stateRoot.slice(0, 16)}… · ${state.networkId}`
      : `Проверено · блок ${account.proofHeight} · root ${account.proofStateRoot.slice(0, 16)}… · ${networkInfo.networkId} · доказанных asset ID не обнаружено`;
    checkpoint.dataset.state = "verified"; checkpoint.dataset.height = String(state?.height ?? account.proofHeight);
  } catch (error) {
    if (!isCurrent()) return;
    const unavailable = document.createElement("p"); unavailable.className = "contact-empty";
    unavailable.textContent = "Доказанный список временно недоступен."; list.replaceChildren(unavailable);
    checkpoint.textContent = networkInfo ? `Устарело или ошибка доказательства · текущий блок ${networkInfo.height}` : "Checkpoint недоступен";
    checkpoint.dataset.state = "stale"; delete checkpoint.dataset.height; assetsStatus.textContent = error.message;
  }
}

async function openAssets() {
  if (!walletInfo) return openBridgePanel();
  openPage(assetsPanel);
  await refreshAssets();
}

function assetFormValues(form, type) {
  const values = Object.fromEntries(new FormData(form).entries());
  if (type === "asset-create") {
    if (!/^[0-9a-f]{64}$/.test(values.metadataHash ?? "") || !ASSET_UNITS.test(values.initialSupply ?? "") ||
        !ASSET_UNITS.test(values.maxSupply ?? "") || BigInt(values.maxSupply) === 0n) {
      throw new Error("Metadata hash и параметры выпуска заполнены неверно.");
    }
    return { fixedSupply: form.elements.fixedSupply.checked, initialSupply: values.initialSupply,
      maxSupply: values.maxSupply, metadataHash: values.metadataHash };
  }
  if (!ASSET_ID.test(values.assetId ?? "") || values.assetId === "0".repeat(64)) throw new Error("Asset ID неверен.");
  if (["asset-mint", "asset-transfer", "asset-burn"].includes(type) &&
      (!ASSET_UNITS.test(values.amount ?? "") || BigInt(values.amount) === 0n)) throw new Error("Количество units неверно.");
  if (type === "asset-transfer" && (!NIR_ADDRESS.test(values.recipient ?? "") || values.recipient === walletInfo.address)) {
    throw new Error("Адрес получателя неверен или совпадает с адресом кошелька.");
  }
  return { assetId: values.assetId, ...(values.amount ? { amount: values.amount } : {}),
    ...(values.recipient ? { recipient: values.recipient } : {}) };
}

async function proveAssetIntent(intent) {
  await verifyAssetState(intent.assetId, walletInfo.address);
  if (intent.type === "asset-transfer") await verifyAssetState(intent.assetId, intent.recipient);
}

async function prepareAssetSimulation(type, fields) {
  if (!networkInfo || networkInfo.valueMode !== "valueless-devnet") throw new Error("Нужна подключённая локальная testnet.");
  const account = await readAccount();
  if (!account.proofVerified) throw new Error("Account state не подтверждён кворумом.");
  const fee = await resourceFee();
  let intent = { type, ...fields, fee, networkId: networkInfo.networkId, nonce: account.nextNonce };
  if (type === "asset-create") {
    const derived = await bridgeRequest("/v1/derive-asset-id", { method: "POST",
      body: JSON.stringify({ networkId: networkInfo.networkId, nonce: account.nextNonce }) });
    if (derived.verified !== true || derived.creator !== walletInfo.address || derived.nonce !== account.nextNonce ||
        !ASSET_ID.test(derived.assetId ?? "")) throw new Error("Bridge не подтвердил deterministic asset ID.");
    intent = { ...intent, assetId: derived.assetId };
  }
  await proveAssetIntent(intent);
  assetsStatus.textContent = "Симуляция с кворумными account и asset proofs…";
  const simulation = await simulateIntent(intent, account);
  pendingAssetIntent = intent; pendingAssetSimulation = simulation;
  renderSimulation("#asset-simulation", simulation);
  assetsStatus.textContent = "Проверьте fee, asset deltas, authority и риски. Браузер не может подписать операцию.";
}

async function recheckAssetSimulation() {
  const account = await readAccount();
  if (!account.proofVerified || account.nextNonce !== pendingAssetIntent.nonce) throw new Error("Checkpoint или nonce изменились; экспорт отменён.");
  await proveAssetIntent(pendingAssetIntent);
  const refreshed = await simulateIntent(pendingAssetIntent, account);
  if (!sameSimulation(refreshed, pendingAssetSimulation)) throw new Error("Последствия изменились; проверьте новую симуляцию.");
  return refreshed;
}

document.querySelector("#open-assets").onclick = openAssets;
document.querySelector("#refresh-assets").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  eventTarget.disabled = true; try { await refreshAssets(); } finally { eventTarget.disabled = false; }
};
document.querySelectorAll("[data-asset-form]").forEach((form) => form.addEventListener("submit", async (event) => {
  event.preventDefault(); const button = form.querySelector("button[type=submit]"); button.disabled = true;
  try { await prepareAssetSimulation(form.dataset.assetForm, assetFormValues(form, form.dataset.assetForm)); }
  catch (error) { assetsStatus.textContent = error.message; }
  finally { button.disabled = false; }
}));
document.querySelector("#edit-asset-simulation").onclick = () => {
  pendingAssetIntent = null; pendingAssetSimulation = null; clearSimulation("#asset-simulation");
  assetsStatus.textContent = "Симуляция отменена. Ничего не подписано и не отправлено.";
};
document.querySelector("#export-asset-offline").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  if (!pendingAssetIntent || !pendingAssetSimulation) return;
  eventTarget.disabled = true; assetsStatus.textContent = "Повторная проверка proofs перед экспортом…";
  try {
    const refreshed = await recheckAssetSimulation();
    await exportOfflineSigningPackage(pendingAssetIntent, refreshed);
    assetsStatus.textContent = "Проверенный пакет экспортирован. Подпись возможна только на офлайн-устройстве.";
  } catch (error) { assetsStatus.textContent = error.message; }
  finally { eventTarget.disabled = false; }
};

async function resourceFee() {
  const response = await fetch(nodeUrl("/v1/fees?amount=1"));
  if (!response.ok) throw new Error("Узел не смог рассчитать комиссию.");
  return (await response.json()).amount;
}

async function prepareResourceSimulation(fields) {
  if (!walletInfo || !networkInfo || networkInfo.valueMode !== "valueless-devnet") {
    throw new Error("Операция разрешена только в подключённой локальной тестовой сети.");
  }
  if (signedResourceTransaction) {
    throw new Error("Сначала отправьте или удалите уже подписанную операцию.");
  }
  const account = await readAccount();
  const intent = {
    ...fields,
    networkId: networkInfo.networkId,
    nonce: account.nextNonce,
    requestId: randomRequestId(),
  };
  if (["credit-stake", "credit-delegation", "credit-unstake-request"].includes(intent.type)) {
    intent.fee = await resourceFee();
  }
  resourcesStatus.textContent = "Симуляция с доказательством состояния…";
  const simulation = await simulateIntent(intent, account);
  pendingResourceIntent = intent;
  pendingSimulation = simulation;
  renderSimulation("#resource-simulation", simulation);
  resourcesStatus.textContent = "Проверьте последствия. Подпись ещё не запрошена.";
}

document.querySelector("#confirm-resource-simulation").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  if (!pendingResourceIntent || !pendingSimulation) return;
  eventTarget.disabled = true;
  resourcesStatus.textContent = "Повторная симуляция перед подписью…";
  try {
    const refreshed = await recheckSimulation(pendingResourceIntent, pendingSimulation);
    resourcesStatus.textContent = localApp
      ? "Подтвердите параметры и пароль только в отдельном окне macOS…"
      : "Подтвердите параметры и пароль только в терминале bridge…";
    const signed = await signWithRecovery("/v1/sign-resource", pendingResourceIntent,
      refreshed.simulationId, () => { resourcesStatus.textContent = localApp
        ? "Ожидание подтверждения в окне macOS…" : "Ожидание подтверждения в терминале…"; });
    assertSignedMatchesIntent(signed.transaction, pendingResourceIntent);
    signedResourceTransaction = signed.transaction;
    document.querySelector("#resource-signed-json").value = JSON.stringify(signedResourceTransaction, null, 2);
    document.querySelector("#resource-signed").hidden = false;
    clearSimulation("#resource-simulation");
    pendingResourceIntent = null; pendingSimulation = null;
    resourcesStatus.textContent = "Подписано локально. Отправка остаётся отдельным действием.";
  } catch (error) { resourcesStatus.textContent = error.message; }
  finally { eventTarget.disabled = false; }
};
document.querySelector("#edit-resource-simulation").onclick = () => {
  pendingResourceIntent = null; pendingSimulation = null; clearSimulation("#resource-simulation");
  resourcesStatus.textContent = "Симуляция отменена. Операция не подписана.";
};

document.querySelector("#submit-resource").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  if (!signedResourceTransaction) return;
  const transaction = signedResourceTransaction;
  const navigationEpoch = pageNavigationEpoch;
  const walletEpoch = accountEpoch;
  const assertCurrent = () => {
    if (pageNavigationEpoch !== navigationEpoch || accountEpoch !== walletEpoch ||
        activePage !== resourcesPanel || signedResourceTransaction !== transaction) {
      throw new Error("Страница или операция изменилась; повторите отправку.");
    }
  };
  eventTarget.disabled = true;
  resourcesStatus.textContent = "Повторная проверка тестовой сети…";
  try {
    if (!(await refreshNodeStatus())) {
      throw new Error("Сеть не подтверждена; транзакция не отправлена.");
    }
    assertCurrent();
    const health = await fetch(nodeUrl("/health")).then((response) => response.json());
    assertCurrent();
    if (health.valueMode !== "valueless-devnet" ||
        health.networkId !== transaction.networkId) {
      throw new Error("Сеть изменилась после подписи; транзакция не отправлена.");
    }
    const response = await fetch(transactionSubmissionUrl(nodePolicy), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transaction),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Узел отклонил операцию.");
    if (signedResourceTransaction === transaction) {
      resourcesStatus.textContent = submissionStatus(result);
      signedResourceTransaction = null;
      document.querySelector("#resource-signed").hidden = true;
    }
    await refreshNodeStatus();
  } catch (error) {
    if (signedResourceTransaction === transaction && activePage === resourcesPanel) resourcesStatus.textContent = error.message;
  } finally { if (signedResourceTransaction === transaction) eventTarget.disabled = false; }
};

document.querySelector("#discard-resource").onclick = () => {
  signedResourceTransaction = null;
  document.querySelector("#resource-signed-json").value = "";
  document.querySelector("#resource-signed").hidden = true;
  resourcesStatus.textContent = "Подписанная операция удалена и не отправлена.";
};

document.querySelector("#stake-form").addEventListener("submit", async (event) => {
  const eventTarget = event.currentTarget;
  event.preventDefault();
  const button = eventTarget.querySelector("button");
  button.disabled = true;
  try {
    await prepareResourceSimulation({
      amount: parseNir(document.querySelector("#stake-amount").value), type: "credit-stake",
    });
    eventTarget.reset();
  } catch (error) { resourcesStatus.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector("#delegation-form").addEventListener("submit", async (event) => {
  const eventTarget = event.currentTarget;
  event.preventDefault();
  const button = eventTarget.querySelector("button");
  button.disabled = true;
  try {
    let delegate = document.querySelector("#delegate-address").value.trim();
    try { delegate = parseAddress(delegate).address; } catch {}
    const limit = Number(document.querySelector("#delegate-limit").value);
    if (!NIR_ADDRESS.test(delegate) || delegate === walletInfo.address ||
        !Number.isSafeInteger(limit) || limit < 0 || limit > 1_000_000) {
      throw new Error("Проверьте адрес и целый лимит от 0 до 1 000 000.");
    }
    await prepareResourceSimulation({ delegate, limit, type: "credit-delegation" });
    eventTarget.reset();
  } catch (error) { resourcesStatus.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector("#unstake-form").addEventListener("submit", async (event) => {
  const eventTarget = event.currentTarget;
  event.preventDefault();
  const button = eventTarget.querySelector("button");
  button.disabled = true;
  try {
    await prepareResourceSimulation({
      amount: parseNir(document.querySelector("#unstake-amount").value),
      type: "credit-unstake-request",
    });
    eventTarget.reset();
  } catch (error) { resourcesStatus.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector("#claim-unstake").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  eventTarget.disabled = true;
  try { await prepareResourceSimulation({ type: "credit-unstake-claim" }); }
  catch (error) { resourcesStatus.textContent = error.message; }
  finally { eventTarget.disabled = false; }
};

function openBridgePanel() {
  if (localApp) {
    nativeConnectionError = "Нет защищённой связи с приложением. Закройте и откройте NIR Wallet снова.";
    renderWalletConnection();
    document.querySelector("#wallet-state").textContent =
      "Защищённая связь с приложением недоступна · закройте и откройте NIR Wallet снова";
    return;
  }
  bridgeStatus.textContent = "";
  document.querySelector("#bridge-url").value = bridgeSession?.url ?? DEFAULT_BRIDGE_URL;
  document.querySelector("#bridge-code").value = "";
  openPage(bridgePanel);
  // Native Mac app brings its pairing code above the browser. The standalone
  // CLI has no such endpoint; its terminal code remains the fallback.
  void fetch(`${DEFAULT_BRIDGE_URL}/v1/pairing-prompt`, { method: "POST" }).catch(() => {});
}

async function connectNativeWallet() {
  if (!localApp) return;
  const code = window.__nirNativeBootstrap;
  delete window.__nirNativeBootstrap;
  nativeConnectionError = null;
  if (!/^[0-9a-f]{64}$/.test(code ?? "")) {
    nativeConnectionError = "Нет защищённой связи с приложением. Закройте и откройте NIR Wallet снова.";
    clearWalletSession("Нет защищённой связи с приложением · откройте кошелёк через NIR Wallet");
    return;
  }
  clearWalletSession("Подключаем локальный кошелёк…");
  const epoch = accountEpoch;
  try {
    const token = await pairBridge(DEFAULT_BRIDGE_URL, code);
    if (epoch !== accountEpoch) return;
    bridgeSession = { token, url: DEFAULT_BRIDGE_URL };
    walletInfo = await bridgeRequest("/v1/wallet");
    if (epoch !== accountEpoch) return;
    if (await renderAccounts() !== true || epoch !== accountEpoch) {
      throw new Error("wallet account changed during native pairing");
    }
    nativeConnectionError = null;
    renderWalletConnection();
    await refreshNodeStatus();
  } catch {
    if (epoch === accountEpoch) {
      nativeConnectionError = "Подключение не подтверждено. Закройте и откройте NIR Wallet снова.";
      clearWalletSession("Подключение не подтверждено · закройте и откройте NIR Wallet снова");
    }
  }
}

async function renderAccounts() {
  const epoch = accountEpoch;
  const { accounts, activeId, canCreate, canRename } = await bridgeRequest("/v1/accounts");
  if (epoch !== accountEpoch || !walletInfo || !bridgeSession) return false;
  if (!Array.isArray(accounts) || !accounts.some((account) => account.id === activeId)) {
    throw new Error("Не удалось проверить список кошельков.");
  }
  if (accounts.find((account) => account.id === activeId).address !== walletInfo.address) {
    throw new Error("Выбранный адрес не совпадает с подключённым кошельком.");
  }
  const list = document.querySelector("#account-list");
  list.replaceChildren();
  for (const account of accounts) {
    if (!/^[0-9a-f]{32}$/.test(account.id ?? "") || !NIR_ADDRESS.test(account.address ?? "")) {
      throw new Error("Список кошельков содержит некорректную запись.");
    }
    const row = document.createElement("div");
    row.className = "account-row";
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-current", account.id === activeId ? "true" : "false");
    const dot = document.createElement("i");
    dot.className = "account-dot";
    dot.style.background = accountColor(account.address);
    const title = document.createElement("strong");
    title.textContent = `${account.label}${account.id === activeId ? " · выбран" : ""}`;
    const detail = document.createElement("small");
    detail.textContent = shortAddress(account.address);
    button.append(dot, title, detail);
    button.onclick = () => changeAccount(account.id);
    row.append(button);
    if (canRename === true) {
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "account-rename";
      rename.textContent = "Переименовать";
      rename.onclick = () => startRename(row, account);
      row.append(rename);
    }
    list.append(row);
  }
  const active = accounts.find((account) => account.id === activeId);
  const activeName = document.querySelector("#active-account");
  activeName.hidden = false;
  activeName.replaceChildren();
  const activeDot = document.createElement("i");
  activeDot.className = "account-dot";
  activeDot.style.background = accountColor(active.address);
  activeName.append(activeDot, `${active.label} · ${shortAddress(active.address)}`);
  accountOpen.textContent = `${active.label} ▾`;
  accountOpen.dataset.activeId = activeId;
  document.querySelector("#add-account").hidden = canCreate !== true;
  chainNameCurrent = null;
  void refreshChainName();
  return true;
}

async function completeAccountChange() {
  const session = bridgeSession;
  if (!session) return false;
  resetAccountView("Кошелёк выбран · проверяем баланс заново");
  const epoch = accountEpoch;
  const info = await bridgeRequest("/v1/wallet");
  if (bridgeSession !== session || accountEpoch !== epoch) return false;
  walletInfo = info;
  if (await renderAccounts() !== true || bridgeSession !== session || accountEpoch !== epoch) return false;
  renderWalletConnection();
  if (accountsPanel.open) accountsPanel.close();
  await refreshNodeStatus();
  return bridgeSession === session && accountEpoch === epoch;
}

async function reconcileAccountAfterError() {
  const session = bridgeSession;
  if (!session) return false;
  resetAccountView("Проверяем выбранный кошелёк заново");
  const epoch = accountEpoch;
  const info = await bridgeRequest("/v1/wallet");
  if (bridgeSession !== session || accountEpoch !== epoch) return false;
  walletInfo = info;
  if (await renderAccounts() !== true || bridgeSession !== session || accountEpoch !== epoch) return false;
  renderWalletConnection();
  await refreshNodeStatus();
  return bridgeSession === session && accountEpoch === epoch;
}

async function changeAccount(id) {
  if (accountTransitionPending) return;
  if (id === accountOpen.dataset.activeId) { accountsPanel.close(); return; }
  accountTransitionPending = true;
  const session = bridgeSession;
  accountsStatus.textContent = "Переключаем кошелёк…";
  try {
    await bridgeRequest("/v1/select-account", { method: "POST", body: JSON.stringify({ id }) });
    if (bridgeSession !== session) return;
    await completeAccountChange();
  } catch (error) {
    if (bridgeSession !== session) return;
    accountsStatus.textContent = error.message;
    try { await reconcileAccountAfterError(); }
    catch { if (bridgeSession === session) clearWalletSession("Не удалось сверить выбранный кошелёк · подключитесь снова"); }
  } finally { accountTransitionPending = false; }
}

accountOpen.onclick = async () => {
  accountsStatus.textContent = "";
  try { if (await renderAccounts() === true && bridgeSession && walletInfo) openPage(accountsPanel); }
  catch (error) { showMessage("settings", error.message); }
};

document.querySelector("#add-account").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  if (accountTransitionPending) return;
  accountTransitionPending = true;
  const session = bridgeSession;
  const button = eventTarget;
  button.disabled = true;
  accountsStatus.textContent = "Продолжите в окне Mac…";
  try {
    await bridgeRequest("/v1/create-account", { method: "POST", body: "{}" }, 600_000);
    if (bridgeSession !== session) return;
    await completeAccountChange();
  } catch (error) {
    if (bridgeSession !== session) return;
    accountsStatus.textContent = error.message;
    try { await reconcileAccountAfterError(); }
    catch { if (bridgeSession === session) clearWalletSession("Не удалось сверить созданный кошелёк · подключитесь снова"); }
  } finally { button.disabled = false; accountTransitionPending = false; }
};

function openSetupPanel() {
  openPage(setupPanel);
}

function openSettingsPanel() {
  renderWalletConnection();
  openPage(settingsPanel, "settings");
  void refreshChainName();
}

document.querySelector("#bridge-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearWalletSession("Переподключение кошелька · ожидаем подтверждения нового сеанса");
  const pairingEpoch = accountEpoch;
  bridgeStatus.textContent = "Подключение…";
  const codeInput = document.querySelector("#bridge-code");
  try {
    const url = exactLoopbackUrl(document.querySelector("#bridge-url").value);
    const code = codeInput.value.trim();
    if (!/^[0-9]{8}$/.test(code)) throw new Error("Введите восьмизначный одноразовый код.");
    const token = await pairBridge(url, code);
    if (pairingEpoch !== accountEpoch) return;
    bridgeSession = { token, url };
    const info = await bridgeRequest("/v1/wallet");
    if (pairingEpoch !== accountEpoch) return;
    walletInfo = info;
    await renderAccounts();
    if (pairingEpoch !== accountEpoch) return;
    codeInput.value = "";
    bridgeStatus.textContent = `Подключён ${walletInfo.address.slice(0, 16)}…`;
    renderWalletConnection();
    await refreshNodeStatus();
    if (pairingEpoch !== accountEpoch) return;
    setTimeout(() => bridgePanel.open && bridgePanel.close(), 450);
  } catch (error) {
    if (pairingEpoch !== accountEpoch) return;
    clearWalletSession("Подключение кошелька не подтверждено · баланс скрыт");
    codeInput.value = "";
    bridgeStatus.textContent = error.name === "AbortError" ? "Bridge не ответил вовремя." : error.message;
  }
});

function receive() {
  if (!walletInfo) return openBridgePanel();
  if (!networkInfo?.networkId) {
    receiveStatus.textContent = "Сначала дождитесь проверки сети, затем откройте получение снова.";
    return;
  }
  // People and exchanges get the checksummed form, which catches typos.
  const shownAddress = checksumAddress(walletInfo.address);
  document.querySelector("#receive-address").textContent = shownAddress;
  document.querySelector("#receive-network").textContent = `Сеть: ${networkInfo.networkId}`;
  drawQr(document.querySelector("#receive-qr"), `nir:${shownAddress}`, `QR публичного адреса ${shownAddress}; сеть ${networkInfo.networkId}`);
  document.querySelector("#payment-request-result").hidden = true;
  document.querySelector("#payment-request-simulation").hidden = true;
  document.querySelector("#payment-request-form").hidden = false;
  document.querySelector("#payment-request-qr-card").hidden = true;
  document.querySelector("#payment-request-json").value = "";
  paymentRequestQrFrames = [];
  receiveStatus.textContent = "";
  openPage(receivePanel);
}

document.querySelector("#payment-request-form").addEventListener("submit", async (event) => {
  const eventTarget = event.currentTarget;
  event.preventDefault();
  const button = eventTarget.querySelector("button");
  button.disabled = true;
  receiveStatus.textContent = "Симуляция платёжного запроса…";
  try {
    if (!networkInfo || networkInfo.valueMode !== "valueless-devnet") {
      throw new Error("Подключите локальную тестовую сеть.");
    }
    const minutes = Number(document.querySelector("#request-minutes").value);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 43_200) {
      throw new Error("Срок должен быть от 1 минуты до 30 дней.");
    }
    const intent = { type: "payment-request", amount: parseNir(document.querySelector("#request-amount").value),
      expiresAt: Date.now() + minutes * 60_000, memo: document.querySelector("#request-memo").value.trim(),
      networkId: networkInfo.networkId, requestId: randomRequestId() };
    const simulation = await simulateIntent(intent, await readAccount());
    pendingPaymentRequest = { intent, simulation };
    renderSimulation("#payment-request-simulation", simulation);
    eventTarget.hidden = true;
    receiveStatus.textContent = "Проверьте последствия. Подпись ещё не создана.";
  } catch (error) { receiveStatus.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector("#confirm-payment-request-simulation").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  if (!pendingPaymentRequest) return;
  eventTarget.disabled = true; receiveStatus.textContent = "Повторная симуляция перед подписью…";
  try {
    const account = await readAccount();
    if (!account.proofVerified) throw new Error("Состояние сети больше не подтверждено. Подпись отменена.");
    const refreshed = await simulateIntent(pendingPaymentRequest.intent, account);
    if (!sameSimulation(refreshed, pendingPaymentRequest.simulation)) throw new Error("Результат симуляции изменился. Подпись отменена.");
    const result = await signWithRecovery("/v1/sign-payment-request", pendingPaymentRequest.intent,
      refreshed.simulationId, () => { receiveStatus.textContent = localApp
        ? "Ожидание подтверждения в окне macOS…" : "Ожидание подтверждения в терминале…"; });
    const verifiedRequest = await bridgeRequest("/v1/verify-payment-request", {
      method: "POST", body: JSON.stringify({ networkId: pendingPaymentRequest.intent.networkId, request: result.paymentRequest }),
    });
    if (verifiedRequest.request.amount !== pendingPaymentRequest.intent.amount ||
        verifiedRequest.request.networkId !== pendingPaymentRequest.intent.networkId ||
        verifiedRequest.request.requestId !== pendingPaymentRequest.intent.requestId) {
      throw new Error("Подписанный запрос отличается от проверенного намерения.");
    }
    document.querySelector("#payment-request-json").value = JSON.stringify(result.paymentRequest, null, 2);
    document.querySelector("#payment-request-result").hidden = false;
    document.querySelector("#payment-request-qr-card").hidden = true;
    clearSimulation("#payment-request-simulation"); pendingPaymentRequest = null; paymentRequestQrFrames = [];
    receiveStatus.textContent = "Подписано. Отправка запроса не создаёт перевод.";
  } catch (error) { receiveStatus.textContent = error.message; }
  finally { eventTarget.disabled = false; }
};
document.querySelector("#edit-payment-request-simulation").onclick = () => {
  pendingPaymentRequest = null; clearSimulation("#payment-request-simulation");
  document.querySelector("#payment-request-form").hidden = false;
  receiveStatus.textContent = "Симуляция отменена. Запрос не подписан.";
};

document.querySelector("#copy-payment-request").onclick = async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector("#payment-request-json").value);
    receiveStatus.textContent = "Платёжный запрос скопирован.";
  } catch { receiveStatus.textContent = "Браузер запретил доступ к буферу обмена."; }
};

document.querySelector("#show-payment-request-qr").onclick = () => {
  try {
    paymentRequestQrFrames = encodePaymentQrFrames(document.querySelector("#payment-request-json").value);
    paymentRequestQrIndex = 0;
    document.querySelector("#payment-request-qr-card").hidden = false;
    renderPaymentQrFrame();
    receiveStatus.textContent = "QR сформирован локально. Передайте все фрагменты, если их несколько.";
  } catch (error) { receiveStatus.textContent = error.message; }
};
document.querySelector("#previous-payment-request-qr").onclick = () => { paymentRequestQrIndex -= 1; renderPaymentQrFrame(); };
document.querySelector("#next-payment-request-qr").onclick = () => { paymentRequestQrIndex += 1; renderPaymentQrFrame(); };
document.querySelector("#copy-payment-request-qr").onclick = async () => {
  try { await navigator.clipboard.writeText(document.querySelector("#payment-request-qr-frame").value); receiveStatus.textContent = "QR-фрагмент скопирован."; }
  catch { receiveStatus.textContent = "Браузер запретил доступ к буферу обмена."; }
};

function openSend() {
  if (!walletInfo) return openBridgePanel();
  document.querySelector("#send-form").hidden = false;
  document.querySelector("#send-review").hidden = true;
  document.querySelector("#signed-result").hidden = true;
  sendStatus.textContent = "";
  pendingIntent = null;
  signedTransaction = null;
  const submitButton = document.querySelector("#submit-signed");
  submitButton.disabled = false;
  submitButton.hidden = false;
  openPage(sendPanel);
}

document.querySelector("#verify-payment-request").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  eventTarget.disabled = true;
  sendStatus.textContent = "Проверка постквантовой подписи…";
  try {
    if (!networkInfo) throw new Error("Локальный узел не подключён.");
    let encoded = document.querySelector("#payment-request-input").value.trim();
    if (encoded.length < 2 || encoded.length > 16_000) {
      throw new Error("Размер платёжного запроса недопустим.");
    }
    if (encoded.startsWith("NIRQR1|")) encoded = decodePaymentQrFrames(encoded);
    let paymentRequest;
    try { paymentRequest = JSON.parse(encoded); }
    catch { throw new Error("Платёжный запрос не является корректным JSON."); }
    const result = await bridgeRequest("/v1/verify-payment-request", {
      method: "POST",
      body: JSON.stringify({ networkId: networkInfo.networkId, request: paymentRequest }),
    });
    document.querySelector("#send-recipient").value = result.request.recipient;
    document.querySelector("#send-amount").value = formatAtomic(result.request.amount);
    document.querySelector("#verified-request-note").textContent = result.request.memo
      ? `✓ Подпись верна · ${result.request.memo}` : "✓ Подпись верна";
    sendStatus.textContent = "Реквизиты заполнены из проверенного запроса. Проверьте перевод.";
  } catch (error) {
    document.querySelector("#verified-request-note").textContent = "";
    sendStatus.textContent = error.message;
  } finally { eventTarget.disabled = false; }
};

document.querySelector("#open-contacts").onclick = openContacts;
document.querySelector("#contact-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try { saveContact(false); }
  catch (error) {
    if (error.code !== "ADDRESS_CHANGE_CONFIRMATION_REQUIRED") {
      document.querySelector("#contacts-status").textContent = error.message; return;
    }
    pendingAddressChange = error;
    document.querySelector("#contact-old-address").textContent = error.existing.address;
    document.querySelector("#contact-new-address").textContent = document.querySelector("#contact-address").value.trim().toLowerCase();
    document.querySelector("#contact-change-network").textContent = `${error.existing.networkId} → ${activeNetworkId()}`;
    document.querySelector("#address-change-warning").hidden = false;
    document.querySelector("#contacts-status").textContent = "Нужна отдельная проверка и явное подтверждение замены.";
  }
});
document.querySelector("#confirm-address-change").onclick = () => {
  if (!pendingAddressChange) return;
  try { saveContact(true); }
  catch (error) { document.querySelector("#contacts-status").textContent = error.message; }
};

document.querySelector("#send-form").addEventListener("submit", async (event) => {
  const eventTarget = event.currentTarget;
  event.preventDefault();
  sendStatus.textContent = "Симуляция перевода с доказательством состояния…";
  try {
    const typed = document.querySelector("#send-recipient").value.trim();
    let recipient;
    if (/^nir1/i.test(typed)) {
      recipient = parseAddress(typed).address;
    } else {
      // A name is only a shortcut: the full address it stands for is shown.
      const resolved = await resolveName(typed);
      recipient = resolved.address;
      document.querySelector("#send-recipient-resolved").textContent =
        `${resolved.name}.nir → ${checksumAddress(recipient)}`;
    }
    if (recipient === walletInfo.address) throw new Error("Нельзя отправить перевод на тот же адрес.");
    const amount = parseNir(document.querySelector("#send-amount").value);
    const [account, quoteResponse] = await Promise.all([
      readAccount(), fetch(nodeUrl(`/v1/fees?amount=${encodeURIComponent(amount)}`)),
    ]);
    if (!quoteResponse.ok) throw new Error("Узел не смог рассчитать комиссию.");
    const quote = await quoteResponse.json();
    pendingIntent = {
      type: "transfer",
      amount,
      fee: quote.amount,
      networkId: networkInfo.networkId,
      nonce: account.nextNonce,
      recipient,
      requestId: [...crypto.getRandomValues(new Uint8Array(32))]
        .map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
    const simulation = await simulateIntent(pendingIntent, account);
    pendingSimulation = simulation;
    renderSimulation("#transfer-simulation", simulation);
    eventTarget.hidden = true;
    document.querySelector("#send-review").hidden = false;
    sendStatus.textContent = "Проверьте точные изменения и риски. Подпись ещё не запрошена.";
  } catch (error) {
    sendStatus.textContent = error.message;
  }
});

document.querySelector("#edit-transfer").onclick = () => {
  pendingIntent = null;
  pendingSimulation = null;
  clearSimulation("#transfer-simulation");
  document.querySelector("#send-review").hidden = true;
  document.querySelector("#send-form").hidden = false;
  sendStatus.textContent = "";
};

document.querySelector("#export-offline-package").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  if (!pendingIntent || !pendingSimulation) return;
  eventTarget.disabled = true;
  try { await exportOfflineSigningPackage(pendingIntent, pendingSimulation); }
  finally { eventTarget.disabled = false; }
};

document.querySelector("#copy-offline-package").onclick = async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector("#offline-package-json").value);
    document.querySelector("#offline-signing-status").textContent = "Офлайн-пакет скопирован.";
  } catch { document.querySelector("#offline-signing-status").textContent = "Браузер запретил доступ к буферу обмена."; }
};
document.querySelector("#show-offline-package-qr").onclick = () => {
  try {
    offlinePackageQrFrames = encodeOfflineQrFrames(document.querySelector("#offline-package-json").value);
    offlinePackageQrIndex = 0;
    document.querySelector("#offline-package-qr-card").hidden = false;
    renderOfflinePackageQrFrame();
    document.querySelector("#offline-signing-status").textContent = "QR создан локально. Передайте все фрагменты.";
  } catch (error) { document.querySelector("#offline-signing-status").textContent = error.message; }
};
document.querySelector("#previous-offline-package-qr").onclick = () => { offlinePackageQrIndex -= 1; renderOfflinePackageQrFrame(); };
document.querySelector("#next-offline-package-qr").onclick = () => { offlinePackageQrIndex += 1; renderOfflinePackageQrFrame(); };
document.querySelector("#copy-offline-package-qr").onclick = async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector("#offline-package-qr-frame").value);
    document.querySelector("#offline-signing-status").textContent = "QR-фрагмент скопирован.";
  } catch { document.querySelector("#offline-signing-status").textContent = "Браузер запретил доступ к буферу обмена."; }
};
document.querySelector("#verify-offline-signed").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  eventTarget.disabled = true;
  const status = document.querySelector("#offline-signing-status");
  status.textContent = "Локальная проверка структуры и срока действия…";
  try {
    let encoded = document.querySelector("#offline-signed-input").value.trim();
    if (encoded.startsWith("NIRQR1/")) encoded = decodeOfflineQrFrames(encoded);
    if (encoded.length < 2 || encoded.length > 128_000) throw new Error("Размер подписанного пакета недопустим.");
    let signedPackage;
    try { signedPackage = JSON.parse(encoded); } catch { throw new Error("Подписанный пакет не является корректным JSON."); }
    const local = await validateOfflineSignedEnvelope(signedPackage, { expected: offlineSigningPackage });
    if (!networkInfo || local.packet.networkId !== networkInfo.networkId) throw new Error("Сеть подписанного пакета не совпадает с подключённой сетью.");
    status.textContent = "Независимая публичная проверка подписи…";
    const verified = await publicBridgeRequest("/v1/verify-offline-signed-package", {
      method: "POST", body: JSON.stringify({ networkId: local.packet.networkId, signedPackage }),
    });
    const bridgeEnvelope = verified.signedPackage ?? verified.envelope;
    const checked = await validateOfflineSignedEnvelope(bridgeEnvelope, { expected: local.packet });
    if (canonicalTransaction(checked.transaction) !== canonicalTransaction(local.transaction)) {
      throw new Error("Публичная проверка вернула другую операцию.");
    }
    document.querySelector("#offline-signed-json").value = JSON.stringify(checked.transaction, null, 2);
    document.querySelector("#offline-signed-summary").textContent =
      `Сеть ${checked.packet.networkId}; тип ${checked.packet.intent.type}; checkpoint ${checked.packet.checkpoint.height}. Операция не отправлена.`;
    document.querySelector("#offline-signed-result").hidden = false;
    status.textContent = "Подпись проверена. Автоматическая отправка намеренно отключена.";
  } catch (error) {
    document.querySelector("#offline-signed-result").hidden = true;
    status.textContent = error.name === "AbortError" ? "Публичная проверка не ответила вовремя." : error.message;
  } finally { eventTarget.disabled = false; }
};

function canonicalTransaction(transaction) {
  return canonicalJson(transaction);
}

document.querySelector("#request-signature").onclick = async () => {
  if (!pendingIntent || !pendingSimulation) return;
  const signButton = document.querySelector("#request-signature");
  signButton.disabled = true;
  sendStatus.textContent = localApp
    ? "Подтвердите запрос и введите пароль в отдельном окне macOS…"
    : "Подтвердите запрос и введите пароль в терминале bridge…";
  try {
    const refreshed = await recheckSimulation(pendingIntent, pendingSimulation);
    const result = await signWithRecovery("/v1/sign", pendingIntent, refreshed.simulationId,
      () => { sendStatus.textContent = localApp
        ? "Ожидание подтверждения в окне macOS…" : "Ожидание подтверждения в терминале…"; });
    assertSignedMatchesIntent(result.transaction, pendingIntent);
    document.querySelector("#signed-json").value = JSON.stringify(result.transaction, null, 2);
    signedTransaction = result.transaction;
    document.querySelector("#send-review").hidden = true;
    document.querySelector("#signed-result").hidden = false;
    sendStatus.textContent = "Подписано. Автоматическая отправка намеренно отключена.";
    pendingIntent = null;
    pendingSimulation = null;
  } catch (error) {
    sendStatus.textContent = error.name === "AbortError" ? "Bridge не ответил вовремя." : error.message;
  } finally {
    signButton.disabled = false;
  }
};

document.querySelector("#submit-signed").onclick = async () => {
  if (!signedTransaction) return;
  const transaction = signedTransaction;
  const navigationEpoch = pageNavigationEpoch;
  const walletEpoch = accountEpoch;
  const assertCurrent = () => {
    if (pageNavigationEpoch !== navigationEpoch || accountEpoch !== walletEpoch ||
        activePage !== sendPanel || signedTransaction !== transaction) {
      throw new Error("Страница или операция изменилась; повторите отправку.");
    }
  };
  const submitButton = document.querySelector("#submit-signed");
  submitButton.disabled = true;
  sendStatus.textContent = "Повторная проверка тестовой сети…";
  try {
    if (!(await refreshNodeStatus())) {
      throw new Error("Сеть не подтверждена; транзакция не отправлена.");
    }
    assertCurrent();
    const healthResponse = await fetch(nodeUrl("/health"));
    if (!healthResponse.ok) throw new Error("Локальный узел не отвечает.");
    const currentNetwork = await healthResponse.json();
    assertCurrent();
    if (currentNetwork.valueMode !== "valueless-devnet") {
      throw new Error("Отправка разрешена только в сети без реальной стоимости.");
    }
    if (currentNetwork.networkId !== transaction.networkId) {
      throw new Error("Сеть узла не совпадает с сетью подписанной транзакции.");
    }
    const response = await fetch(transactionSubmissionUrl(nodePolicy), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transaction),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Узел отклонил транзакцию.");
    if (signedTransaction === transaction) {
      sendStatus.textContent = submissionStatus(result);
      submitButton.hidden = true;
      signedTransaction = null;
    }
    await refreshNodeStatus();
  } catch (error) {
    if (signedTransaction === transaction && activePage === sendPanel) {
      sendStatus.textContent = error.message;
    }
  } finally { if (signedTransaction === transaction) submitButton.disabled = false; }
};

document.querySelector("#copy-signed").onclick = async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector("#signed-json").value);
    sendStatus.textContent = "JSON скопирован.";
  } catch {
    sendStatus.textContent = "Браузер запретил доступ к буферу обмена.";
  }
};

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.action === "receive") receive();
    else if (button.dataset.action === "send") openSend();
    else if (button.dataset.action === "connect") openBridgePanel();
    else if (button.dataset.action === "setup") openSetupPanel();
    else if (button.dataset.action === "history") showHomeTab("history");
    else if (button.dataset.action === "mine") openMiningPanel();
    else showMessage(button.dataset.action);
  });
});
document.querySelector("#panel .close").onclick = () => panel.close();
document.querySelector("#panel .primary").onclick = () => panel.close();
document.querySelectorAll("[data-close]").forEach((button) => {
  button.onclick = () => document.querySelector(`#${button.dataset.close}`).close();
});
document.querySelector("#settings-connect").onclick = () => {
  openBridgePanel();
};
document.querySelector("#settings-setup").onclick = openSetupPanel;
document.querySelector("#sign-operator-link").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  const status = document.querySelector("#operator-link-status");
  const proofField = document.querySelector("#operator-link-proof");
  const copy = document.querySelector("#copy-operator-link-proof");
  proofField.hidden = true;
  copy.hidden = true;
  proofField.value = "";
  const challenge = document.querySelector("#operator-link-challenge").value.trim();
  if (!/^[0-9a-f]{64}$/.test(challenge)) {
    status.textContent = "Нужен полный одноразовый запрос из Model Lab.";
    return;
  }
  if (!walletInfo || !bridgeSession) {
    status.textContent = "Сначала подключите vault к этому окну кошелька.";
    return;
  }
  const expectedAddress = walletInfo.address;
  eventTarget.disabled = true;
  try {
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
    status.textContent = "Подтвердите запрос в системном окне кошелька.";
    const result = await signWithRecovery("/v1/sign-operator-link", { challenge, requestId },
      undefined, () => { status.textContent = "Ожидаем подтверждения кошелька…"; });
    if (walletInfo?.address !== expectedAddress || result.proof?.address !== expectedAddress ||
        result.proof?.challenge !== challenge) throw new Error("Адрес изменился во время подтверждения.");
    proofField.value = JSON.stringify(result.proof);
    proofField.hidden = false;
    copy.hidden = false;
    status.textContent = "Скопируйте доказательство в Model Lab. Это не заявка и не награда.";
  } catch {
    status.textContent = "Подтверждение не завершилось. Запрос не создал перевод или награду.";
  } finally { eventTarget.disabled = false; }
};
document.querySelector("#copy-operator-link-proof").onclick = async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector("#operator-link-proof").value);
    document.querySelector("#operator-link-status").textContent = "Доказательство скопировано. Вставьте его в Model Lab.";
  } catch {
    document.querySelector("#operator-link-status").textContent = "Копирование недоступно. Скопируйте текст вручную.";
  }
};
document.querySelector("#sign-iris-receipt").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  const status = document.querySelector("#iris-receipt-status");
  const signedField = document.querySelector("#iris-receipt-signed");
  const copy = document.querySelector("#copy-iris-receipt");
  signedField.value = "";
  signedField.hidden = true;
  copy.hidden = true;
  if (!walletInfo || !bridgeSession) {
    status.textContent = "Сначала подключите vault к этому окну кошелька.";
    return;
  }
  let intent;
  try { intent = JSON.parse(document.querySelector("#iris-receipt-intent").value); }
  catch { status.textContent = "Нужен точный JSON intent из Model Lab."; return; }
  if (intent?.recipient !== walletInfo.address || intent?.scope !== "local-rehearsal-only" ||
      intent?.networkSubmitted !== false || intent?.rewardEligible !== false ||
      intent?.executionVerified !== false) {
    status.textContent = "Intent не совпадает с адресом или обещает сетевую награду.";
    return;
  }
  const expectedAddress = walletInfo.address;
  eventTarget.disabled = true;
  try {
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
    status.textContent = "Подтвердите хэш свидетельства в системном окне кошелька.";
    const result = await signWithRecovery("/v1/sign-local-iris-receipt", { intent, requestId },
      undefined, () => { status.textContent = "Ожидаем подтверждения кошелька…"; });
    if (walletInfo?.address !== expectedAddress || result.receipt?.recipient !== expectedAddress ||
        result.receipt?.nonce !== intent.nonce ||
        result.receipt?.evidenceDigest !== intent.evidenceDigest)
      throw new Error("Квитанция не совпадает с intent.");
    signedField.value = JSON.stringify(result.receipt);
    signedField.hidden = false;
    copy.hidden = false;
    status.textContent = "Скопируйте подпись в Model Lab. Выполнение модели подписью не доказано; средства и сеть не изменились.";
  } catch {
    status.textContent = "Подпись не завершилась. Сетевая заявка и награда не созданы.";
  } finally { eventTarget.disabled = false; }
};
document.querySelector("#copy-iris-receipt").onclick = async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector("#iris-receipt-signed").value);
    document.querySelector("#iris-receipt-status").textContent = "Квитанция скопирована. Вставьте её в Model Lab.";
  } catch {
    document.querySelector("#iris-receipt-status").textContent = "Копирование недоступно. Скопируйте текст вручную.";
  }
};
// The Update button (docs/app-updates.md): the bridge builds the newest
// published version and the wallet restarts into it.
const UPDATE_WORKING = ["checking", "downloading", "building", "restarting"];
let walletBuild = null;
let walletUpdate = null;
let walletUpdatePoll = null;
function renderWalletUpdate(failed = false) {
  const status = document.querySelector("#wallet-update-status");
  const apply = document.querySelector("#wallet-apply-update");
  const u = walletUpdate;
  const installed = walletBuild ? `Установлена версия ${walletBuild.version} · ревизия ${walletBuild.localBuildSequence}. ` : "";
  status.textContent = failed || !u ? "Не удалось получить сведения о запущенном сервисе. Приложение не изменено."
    : installed + (u.error === "not-updatable-build"
      ? "Эта сборка ещё не умеет обновляться сама. Соберите кошелёк один раз заново — дальше хватит кнопки «Обновить»."
        : u.state === "checking" ? "Проверяем, есть ли новая версия…"
          : u.state === "downloading" ? "Скачиваем новую версию…"
            : u.state === "building" ? "Собираем новую версию. Это займёт несколько минут; кошелёк перезапустится сам."
              : u.state === "restarting" ? "Перезапускаем кошелёк…"
                : u.state === "failed" ? `Обновить не удалось. Установленный кошелёк не изменён. Причина: ${u.error ?? "неизвестна"}`
                  : u.available ? `Доступна новая версия ${u.release.version} от ${u.release.date}.`
                    : "У вас последняя версия.");
  apply.hidden = !u?.available || UPDATE_WORKING.includes(u?.state);
  document.querySelector("#wallet-check-updates").disabled = UPDATE_WORKING.includes(u?.state);
}
async function followWalletUpdate(path) {
  clearTimeout(walletUpdatePoll);
  let failed = false;
  try {
    const result = await bridgeRequest(path ?? "/v1/app-update", path ? { method: "POST" } : {});
    if (typeof result?.state !== "string") throw new Error("Неверные сведения об обновлении.");
    walletUpdate = result;
  } catch {
    // The bridge stops while the wallet restarts for an update.
    failed = walletUpdate?.state !== "restarting";
  }
  renderWalletUpdate(failed);
  if (UPDATE_WORKING.includes(walletUpdate?.state)) {
    walletUpdatePoll = setTimeout(() => { void followWalletUpdate(); }, 1_000);
  }
}
document.querySelector("#wallet-check-updates").onclick = async () => {
  try {
    if (!bridgeSession) throw new Error("Нет активного сеанса кошелька.");
    const build = await bridgeRequest("/v1/app-build");
    if (!/^\d+\.\d+\.\d+$/.test(build.version) ||
        !Number.isSafeInteger(build.localBuildSequence) || build.localBuildSequence < 1) {
      throw new Error("Неверные сведения о сборке.");
    }
    walletBuild = build;
  } catch {
    renderWalletUpdate(true);
    return;
  }
  await followWalletUpdate("/v1/app-update/check");
};
document.querySelector("#wallet-apply-update").onclick = (event) => {
  event.currentTarget.hidden = true;
  void followWalletUpdate("/v1/app-update/apply");
};
document.querySelector("#settings-secrets").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  const button = eventTarget;
  const status = document.querySelector("#settings-secrets-status");
  button.disabled = true;
  status.textContent = "Подтвердите действие в отдельном окне Mac; секрет здесь не появится.";
  try {
    const result = await bridgeRequest("/v1/native-security", { method: "POST" }, 600_000);
    status.textContent = result.opened ? "Новая зашифрованная копия проверена в окне Mac."
      : "Действие отменено. Существующие копии не изменены.";
  } catch (error) {
    status.textContent = error.name === "AbortError"
      ? "Окно Mac не ответило вовремя." : "Не удалось завершить действие. Проверьте окно Mac.";
  } finally { button.disabled = false; }
};
document.querySelector("#settings-password-change").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  const button = eventTarget;
  const status = document.querySelector("#settings-password-status");
  button.disabled = true;
  status.textContent = "Введите старый и новый пароль только в отдельном окне Mac.";
  try {
    const result = await bridgeRequest("/v1/native-password-change", { method: "POST" }, 600_000);
    status.textContent = result.changed ? "Пароль активного файла изменён. Старые копии не отозваны."
      : "Действие отменено. Пароль не изменён.";
  } catch (error) {
    status.textContent = error.name === "AbortError"
      ? "Окно Mac не ответило вовремя. Перезапустите кошелёк и проверьте доступ."
      : "Не удалось завершить смену пароля. Проверьте окно Mac и доступ после перезапуска.";
  } finally { button.disabled = false; }
};
document.querySelector("#setup-connect").onclick = () => {
  openBridgePanel();
};
document.querySelector("#disconnect-wallet").onclick = async (event) => {
  const eventTarget = event.currentTarget;
  eventTarget.disabled = true;
  try {
    if (bridgeSession) await bridgeRequest("/v1/session", { method: "DELETE" });
  } catch {
    // Local state is still erased if the bridge has already stopped or the session expired.
  } finally {
    if (localApp) nativeConnectionError = "Сеанс закрыт. Чтобы подключиться снова, перезапустите NIR Wallet.";
    clearWalletSession();
    eventTarget.disabled = false;
    settingsPanel.close();
  }
};

const navigationButtons = [...document.querySelectorAll("[data-nav]")];
navigationButtons.forEach((button) => button.addEventListener("click", () => {
  const destination = button.dataset.nav;
  if (destination === "home" || destination === "history") showHomeTab(destination);
  else if (destination === "resources") openResources();
  else if (destination === "settings") openSettingsPanel();
  else if (destination === "mine") openMiningPanel();
  else showMessage(destination, null, destination);
}));

const themeButton = document.querySelector("#theme");
const setTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme === "light" ? "☾" : "☀";
  themeButton.setAttribute("aria-label", theme === "light" ? "Включить тёмную тему" : "Включить дневную тему");
  localStorage.setItem("nir-theme", theme);
};
setTheme(localStorage.getItem("nir-theme") || "dark");
themeButton.onclick = () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");

const networkButton = document.querySelector(".network");
async function loadNodePolicy() {
  if (nodePolicy) return nodePolicy;
  const response = await fetch("./nodes.json", { cache: "no-store" });
  if (!response.ok) throw new Error("node policy unavailable");
  nodePolicy = normalizeNodePolicy(await response.json());
  return nodePolicy;
}

async function selectActiveNode(refreshSequence) {
  const epoch = accountEpoch;
  const policy = await loadNodePolicy();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);
  try {
    let trust = { minimumHeight: 0, networkId: null };
    if (bridgeSession) {
      const candidate = await bridgeRequest("/v1/trust-info");
      if (candidate.enabled) trust = candidate;
    }
    const responses = await Promise.allSettled(policy.nodes.map(async (url) => {
      const response = await fetch(`${url}/health`, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("node unavailable");
      return { health: await response.json(), url };
    }));
    const selected = selectNodeHealth(
      responses.filter(({ status }) => status === "fulfilled").map(({ value }) => value),
      {
        expectedNetworkId: trust.networkId,
        minimumAgreement: policy.minimumAgreement,
        minimumHeight: trust.minimumHeight,
        trustedTipHash: trust.tipHash,
      },
    );
    if (epoch !== accountEpoch || refreshSequence !== nodeRefreshSequence) {
      throw new Error("wallet or network changed during node selection");
    }
    activeNodeUrl = selected.url;
    networkInfo = {
      ...selected.health,
      agreeingNodes: selected.agreeingNodes,
      availableNodes: selected.availableNodes,
    };
    return networkInfo;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshNodeStatus() {
  const epoch = accountEpoch;
  const refreshSequence = ++nodeRefreshSequence;
  accountRefreshSequence += 1;
  networkInfo = null;
  activeNodeUrl = null;
  clearAccountNumbers();
  document.querySelector("#wallet-state").textContent = "Проверяем сеть и баланс…";
  try {
    await selectActiveNode(refreshSequence);
    if (epoch !== accountEpoch || refreshSequence !== nodeRefreshSequence) return false;
    const assetCheckpoint = document.querySelector("#asset-checkpoint");
    if (assetCheckpoint.dataset.state === "verified" &&
        Number(assetCheckpoint.dataset.height) !== networkInfo.height) {
      assetCheckpoint.dataset.state = "stale";
      assetCheckpoint.textContent = `Доказательства устарели · проверено на блоке ${assetCheckpoint.dataset.height}, текущий блок ${networkInfo.height}`;
      assetsStatus.textContent = "Обновите asset proofs перед просмотром или новой операцией.";
    }
    networkButton.textContent = `● Тестовая сеть · блок ${networkInfo.height}`;
    networkButton.classList.add("connected");
    networkButton.classList.remove("offline");
    messages.network = ["Узлы NIR подключены", `${networkInfo.networkId}, высота ${networkInfo.height}. Совпадающих узлов: ${networkInfo.agreeingNodes} из ${networkInfo.availableNodes}.`];
    await refreshAccount();
    return epoch === accountEpoch && refreshSequence === nodeRefreshSequence;
  } catch {
    if (epoch !== accountEpoch || refreshSequence !== nodeRefreshSequence) return false;
    networkInfo = null;
    activeNodeUrl = null;
    clearAccountNumbers();
    document.querySelector("#wallet-state").textContent = "Баланс не подтверждён · узлы недоступны";
    networkButton.textContent = "○ Нет связи с сетью";
    networkButton.classList.add("offline");
    networkButton.classList.remove("connected");
    messages.network = ["Узлы NIR не подтверждены", "Нет достаточного числа доступных узлов с совпадающим финализированным состоянием."];
    return false;
  }
}
refreshNodeStatus();
renderWalletConnection();
void connectNativeWallet();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  if (localApp) {
    // The native launcher uses an ephemeral origin. Never keep a cache-first
    // worker for a later build that might reuse this port.
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((entry) => entry.unregister())))
      .catch(() => {});
  } else {
    navigator.serviceWorker.register("./sw.js");
  }
}

// Mining (NIR Майнер on this Mac): what the local test network says about
// this wallet's rewards, and a button that opens the miner app.
let miningSnapshot = null;
let miningRewards = [];
function renderMining() {
  const state = document.querySelector("#mining-card-state");
  const note = document.querySelector("#mining-card-note");
  const view = miningSnapshot;
  const mine = view?.active && walletInfo
    ? (view.escrows ?? []).filter((entry) => entry.recipient === walletInfo.address) : [];
  const incoming = mine.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
  if (!view) {
    state.textContent = "Майнер не запущен";
    note.textContent = "Откройте NIR Майнер и нажмите «Начать майнинг».";
  } else if (!view.active) {
    state.textContent = "Майнинг в этой сети не включён";
    note.textContent = "";
  } else {
    state.textContent = `● Сеть майнинга работает · уровень ${view.level}`;
    note.textContent = incoming > 0n
      ? `В пути к вам: ${formatAtomic(incoming)} NIR. Придут в течение нескольких минут.`
      : "Награды приходят на подключённый в майнере кошелёк.";
  }
  document.querySelector("#mining-status").textContent = !view ? "Не запущен" : view.active ? "Работает" : "Выключен";
  document.querySelector("#mining-level").textContent = view?.active ? String(view.level) : "—";
  document.querySelector("#mining-height").textContent = view ? String(view.height) : "—";
  document.querySelector("#mining-incoming").textContent = view?.active
    ? `${formatAtomic(incoming).replace(/\.?0+$/, "")} NIR` : "—";
  document.querySelector("#mining-incoming-note").textContent = mine.length
    ? "Награда ждёт 64 блока после решения задачи, затем зачисляется на баланс." : "";
  const short = (atomic) => formatAtomic(atomic).replace(/\.?0+$/, "");
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const today = miningRewards.filter((entry) => entry.timestamp >= startOfDay)
    .reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
  if (today > 0n) note.textContent = `Сегодня намайнено: +${short(today)} NIR. ${note.textContent}`;
  const list = document.querySelector("#mining-rewards");
  list.replaceChildren(...miningRewards.slice(0, 20).map((entry) => {
    const item = document.createElement("li");
    const when = document.createElement("span");
    when.textContent = new Date(entry.timestamp).toLocaleString(document.documentElement.lang === "en" ? "en-GB" : "ru-RU",
      { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const amount = document.createElement("b");
    amount.textContent = `+${short(entry.amount)} NIR`;
    item.append(when, amount);
    return item;
  }));
  document.querySelector("#mining-rewards-empty").hidden = miningRewards.length > 0;
}
async function loadMining() {
  try {
    const response = await fetch(`${activeNodeUrl ?? "http://127.0.0.1:8787"}/v1/proof-mining`,
      { cache: "no-store", signal: AbortSignal.timeout(3_000) });
    const view = await response.json();
    miningSnapshot = response.ok && typeof view?.active === "boolean" ? view : null;
  } catch {
    miningSnapshot = null;
  }
  miningRewards = [];
  if (miningSnapshot && walletInfo) {
    try {
      const response = await fetch(`${activeNodeUrl ?? "http://127.0.0.1:8787"}/v1/accounts/${walletInfo.address}/proof-rewards`,
        { cache: "no-store", signal: AbortSignal.timeout(3_000) });
      const body = await response.json();
      if (response.ok && body?.address === walletInfo.address && Array.isArray(body.rewards)) {
        miningRewards = body.rewards.filter((entry) => /^[0-9]{1,30}$/.test(entry?.amount ?? "") &&
          Number.isSafeInteger(entry.timestamp)).slice(0, 200);
      }
    } catch {}
  }
  renderMining();
}
function openMiningPanel() {
  openPage(miningPanel, "mine");
  void loadMining();
}
document.querySelector("#mining-card").addEventListener("click", openMiningPanel);
document.querySelector("#header-settings").addEventListener("click", openSettingsPanel);
document.querySelector("#settings-resources").addEventListener("click", () => { void openResources(); });
document.querySelector("#open-miner").addEventListener("click", async (event) => {
  const eventTarget = event.currentTarget;
  const status = document.querySelector("#open-miner-status");
  eventTarget.disabled = true;
  try {
    await bridgeRequest("/v1/open-miner", { method: "POST" });
    status.textContent = "";
  } catch {
    status.textContent = "Не удалось открыть NIR Майнер. Откройте его из папки «Программы».";
  } finally { eventTarget.disabled = false; }
});
void loadMining();
setInterval(() => { void loadMining(); }, 15_000);

// Settings → More: earlier NIR builds Launchpad still lists.
document.querySelector("#old-copies-find").addEventListener("click", async (event) => {
  const eventTarget = event.currentTarget;
  const state = document.querySelector("#old-copies-state");
  const trash = document.querySelector("#old-copies-trash");
  eventTarget.disabled = true;
  try {
    const { copies } = await bridgeRequest("/v1/old-copies", {}, 60_000);
    state.textContent = copies.length ? `Найдено старых копий: ${copies.length}.` : "Старых копий не найдено.";
    trash.hidden = copies.length === 0;
  } catch {
    state.textContent = "Не удалось выполнить поиск.";
  } finally { eventTarget.disabled = false; }
});
document.querySelector("#old-copies-trash").addEventListener("click", async (event) => {
  const eventTarget = event.currentTarget;
  const state = document.querySelector("#old-copies-state");
  eventTarget.disabled = true;
  try {
    document.querySelector("#old-copies-reason").textContent = "";
    const { moved, deleted = [], failed = [] } = await bridgeRequest("/v1/old-copies/trash", { method: "POST" }, 300_000);
    state.textContent = `Удалено старых копий: ${moved.length + deleted.length}.`;
    if (failed.length) {
      state.textContent = `Удалено старых копий: ${moved.length + deleted.length}. Не удалось убрать: ${failed.length}. Нажмите «Показать в Finder» и перетащите их в Корзину.`;
      document.querySelector("#old-copies-reason").textContent = failed[0].reason;
    }
    document.querySelector("#old-copies-reveal").hidden = failed.length === 0;
    eventTarget.hidden = true;
  } catch {
    state.textContent = "Не удалось удалить старые копии.";
  } finally { eventTarget.disabled = false; }
});

// Account names (docs: account names are this Mac's own labels; the address
// stays the account's identity and is always shown next to the name).
function shortAddress(address) {
  const shown = checksumAddress(address);
  return `${shown.slice(0, 10)}…${shown.slice(-6)}`;
}
function accountColor(address) {
  return `hsl(${parseInt(address.slice(4, 10), 16) % 360} 70% 55%)`;
}
function startRename(row, account) {
  const form = document.createElement("form");
  form.className = "account-rename-form";
  const input = document.createElement("input");
  input.maxLength = 64;
  input.value = account.label;
  input.setAttribute("aria-label", "Новое имя счёта");
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary";
  save.textContent = "Сохранить";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = "Отмена";
  form.append(input, save, cancel);
  row.replaceChildren(form);
  input.focus();
  input.select();
  cancel.onclick = () => { void renderAccounts(); };
  form.onsubmit = async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      await bridgeRequest("/v1/rename-account", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: account.id, name: input.value }) });
      accountsStatus.textContent = "";
      await renderAccounts();
    } catch (error) {
      accountsStatus.textContent = /already has this name/.test(error.message)
        ? "Такое имя уже есть у другого вашего счёта."
        : "Имя не подходит: от 1 до 32 символов, без служебных знаков.";
      save.disabled = false;
    }
  };
}

// Settings → the 24 secret words, shown only in the Mac window after the password.
document.querySelector("#settings-phrase").addEventListener("click", async (event) => {
  const eventTarget = event.currentTarget;
  const status = document.querySelector("#settings-phrase-status");
  eventTarget.disabled = true;
  status.textContent = "Введите пароль в окне Mac.";
  try {
    const { outcome } = await bridgeRequest("/v1/reveal-phrase", { method: "POST" }, 600_000);
    status.textContent = outcome === "shown" ? "Фраза показана в окне Mac."
      : outcome === "wrong-password" ? "Неверный пароль. Фраза не показана."
        : outcome === "no-phrase" ? "Этот счёт создан до появления 24 слов, и из слов его получить нельзя. Нажмите «Создать 24 слова»: появится новый счёт из 24 слов. Потом переведите на него NIR со старого счёта."
          : "Отменено.";
    document.querySelector("#settings-phrase-create").hidden = outcome !== "no-phrase";
  } catch {
    status.textContent = "Не удалось показать фразу.";
  } finally { eventTarget.disabled = false; }
});

// A wallet made before phrases: "Add account" creates the 24 words and the
// first account from them.
document.querySelector("#settings-phrase-create").addEventListener("click", (event) => {
  event.currentTarget.hidden = true;
  document.querySelector("#settings-phrase-status").textContent = "";
  if (!accountsPanel.open) accountsPanel.showModal();
  document.querySelector("#add-account").click();
});
document.querySelector("#old-copies-reveal").addEventListener("click", async (event) => {
  const eventTarget = event.currentTarget;
  eventTarget.disabled = true;
  try { await bridgeRequest("/v1/old-copies/reveal", { method: "POST" }, 60_000); }
  catch {} finally { eventTarget.disabled = false; }
});

// Account names (docs/names.md): `sasha.nir` stands for one address. A name is
// shown only when it points to the address and the address points back to it;
// sending always shows the full address the name stands for.
const NAME_RESERVED = new Set(["admin", "administrator", "airdrop", "bank", "exchange", "faucet", "founder",
  "foundation", "giveaway", "help", "helpdesk", "mainnet", "miner", "mining", "moderator", "null", "official",
  "owner", "pay", "payment", "payments", "refund", "root", "security", "staff", "support", "system", "team",
  "testnet", "treasury", "undefined", "validator", "validators", "wallet"]);
function nameProblemText(name) {
  if (name.length < 3) return "Имя слишком короткое: нужно хотя бы 3 знака.";
  if (name.length > 32) return "Имя слишком длинное: не больше 32 знаков.";
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) || name.includes("--")) {
    return "Только латинские буквы, цифры и дефис внутри имени.";
  }
  if (name.startsWith("nir") || NAME_RESERVED.has(name)) return "Это имя зарезервировано: его нельзя купить.";
  return null;
}
function bareName(input) {
  return String(input ?? "").trim().toLowerCase().replace(/\.nir$/, "");
}
async function nameNodeJson(path) {
  let response;
  let body;
  try {
    response = await fetch(`${activeNodeUrl ?? "http://127.0.0.1:8787"}${path}`,
      { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    body = await response.json();
  } catch {
    throw new Error("Сеть NIR не ответила. Откройте NIR Майнер.");
  }
  if (!response.ok) throw new Error("Сеть NIR не ответила. Откройте NIR Майнер.");
  return body;
}
function nameSubmissionUrl() {
  try { return transactionSubmissionUrl(nodePolicy); }
  catch { return `${activeNodeUrl ?? "http://127.0.0.1:8787"}/v1/transactions`; }
}
async function submitNameTransaction(transaction) {
  let response;
  let body;
  try {
    response = await fetch(nameSubmissionUrl(), { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(transaction) });
    body = await response.json();
  } catch {
    throw new Error("Сеть NIR не ответила. Откройте NIR Майнер.");
  }
  if (!response.ok) throw new Error(body.error || "Сеть отклонила операцию.");
  return body;
}
// The name an address has, only when both directions agree.
async function verifiedNameOf(address) {
  const { name } = await nameNodeJson(`/v1/accounts/${address}/name`);
  if (typeof name !== "string") return null;
  const entry = await nameNodeJson(`/v1/names/${encodeURIComponent(name)}`);
  return entry.owner === address ? name : null;
}
// The address a name stands for, only when both directions agree.
async function resolveName(input) {
  const name = bareName(input);
  const problem = nameProblemText(name);
  if (problem) throw new Error(problem);
  const entry = await nameNodeJson(`/v1/names/${encodeURIComponent(name)}`);
  if (!entry.owner) throw new Error(`Имя ${name}.nir никому не принадлежит.`);
  const reverse = await nameNodeJson(`/v1/accounts/${entry.owner}/name`);
  if (reverse.name !== name) throw new Error(`Имя ${name}.nir не подтверждено владельцем.`);
  return { name, address: entry.owner };
}

function renderChainNameTag() {
  const chip = document.querySelector("#active-account");
  chip.querySelector(".chain-name-tag")?.remove();
  if (!chainNameCurrent || chip.hidden) return;
  const tag = document.createElement("span");
  tag.className = "chain-name-tag";
  tag.textContent = `${chainNameCurrent}.nir`;
  chip.append(" · ", tag);
}
async function refreshChainName() {
  const current = document.querySelector("#chain-name-current");
  const release = document.querySelector("#chain-name-release");
  if (!walletInfo) {
    current.textContent = "Подключите кошелёк, чтобы выбрать имя.";
    release.hidden = true;
    return;
  }
  const address = walletInfo.address;
  try {
    const info = await nameNodeJson("/v1/names");
    if (!info.active) {
      current.textContent = "Имена появятся, когда сеть обновится. Обновите NIR Майнер.";
      release.hidden = true;
      return;
    }
    const name = await verifiedNameOf(address);
    if (walletInfo?.address !== address) return;
    chainNameCurrent = name;
    current.textContent = name ? `Ваше имя: ${name}.nir` : "У этого счёта пока нет имени.";
    release.hidden = !name;
    document.querySelector("#chain-name-buy").textContent = name ? "Сменить имя" : "Купить имя";
  } catch {
    chainNameCurrent = null;
    current.textContent = "Сеть NIR не ответила. Откройте NIR Майнер.";
    release.hidden = true;
  }
  renderChainNameTag();
}
document.querySelector("#chain-name-input").addEventListener("input", (event) => {
  const epoch = ++chainNameCheckEpoch;
  const check = document.querySelector("#chain-name-check");
  const buy = document.querySelector("#chain-name-buy");
  buy.disabled = true;
  check.classList.remove("taken");
  const input = event.currentTarget;
  if (input.value !== input.value.toLowerCase()) input.value = input.value.toLowerCase();
  const name = bareName(input.value);
  if (!name) { check.textContent = ""; return; }
  const problem = nameProblemText(name);
  if (problem) { check.textContent = problem; check.classList.add("taken"); return; }
  check.textContent = "Проверяем…";
  setTimeout(async () => {
    if (epoch !== chainNameCheckEpoch) return;
    try {
      const entry = await nameNodeJson(`/v1/names/${encodeURIComponent(name)}`);
      if (epoch !== chainNameCheckEpoch) return;
      if (entry.owner === walletInfo?.address) {
        check.textContent = "Это уже ваше имя.";
      } else if (entry.available) {
        check.textContent = `${name}.nir свободно · цена ${formatAtomic(entry.price).replace(/\.?0+$/, "")} NIR`;
        buy.disabled = !walletInfo;
      } else {
        check.textContent = `${name}.nir уже занято.`;
        check.classList.add("taken");
      }
    } catch (error) {
      if (epoch === chainNameCheckEpoch) check.textContent = error.message;
    }
  }, 300);
});
async function signNameOperation(action, extra = {}) {
  const info = await nameNodeJson("/v1/names");
  if (!info.active) throw new Error("Имена появятся, когда сеть обновится. Обновите NIR Майнер.");
  const account = await nameNodeJson(`/v1/accounts/${walletInfo.address}`);
  const requestId = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const { transactions } = await bridgeRequest("/v1/sign-name", { method: "POST", body: JSON.stringify({
    action, chainIdentityGenesisHash: info.chainIdentityGenesisHash, networkId: info.networkId,
    nonce: account.nextNonce, requestId, ...extra }) }, 600_000);
  return { info, transactions };
}
document.querySelector("#chain-name-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("#chain-name-status");
  const buy = document.querySelector("#chain-name-buy");
  const name = bareName(document.querySelector("#chain-name-input").value);
  if (nameProblemText(name) || !walletInfo) return;
  buy.disabled = true;
  status.textContent = "Подтвердите покупку и введите пароль в окне Mac.";
  try {
    const { info, transactions: [commit, register] } = await signNameOperation("register", { name });
    status.textContent = "Шаг 1 из 2: скрытая заявка на имя…";
    const committed = await submitNameTransaction(commit);
    // The name itself goes in a few blocks later, so nobody can take it in between.
    const readyAt = (committed.height ?? info.height) + info.revealDelayBlocks;
    status.textContent = "Шаг 2 из 2: записываем имя. Это займёт около минуты…";
    for (let attempt = 0; ; attempt++) {
      const { height } = await nameNodeJson("/v1/names");
      if (height >= readyAt) {
        try { await submitNameTransaction(register); break; }
        catch (error) { if (attempt > 60 || !/window/.test(error.message)) throw error; }
      }
      if (attempt > 120) throw new Error("Сеть не успела записать имя. Проверьте, что NIR Майнер открыт.");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    status.textContent = `Готово: ваше имя ${name}.nir.`;
    document.querySelector("#chain-name-input").value = "";
    document.querySelector("#chain-name-check").textContent = "";
    await refreshChainName();
  } catch (error) {
    status.textContent = /already taken/.test(error.message) ? `${name}.nir уже заняли. Выберите другое имя.`
      : /rejected by the user/.test(error.message) ? "Покупка отменена." : `Имя не записано: ${error.message}`;
  } finally { buy.disabled = false; }
});
document.querySelector("#chain-name-release").addEventListener("click", async () => {
  const status = document.querySelector("#chain-name-status");
  const release = document.querySelector("#chain-name-release");
  release.disabled = true;
  status.textContent = "Подтвердите в окне Mac.";
  try {
    const { transactions: [transaction] } = await signNameOperation("release");
    await submitNameTransaction(transaction);
    status.textContent = "Имя освобождено.";
    await refreshChainName();
  } catch (error) {
    status.textContent = /rejected by the user/.test(error.message) ? "Отменено." : `Не получилось: ${error.message}`;
  } finally { release.disabled = false; }
});

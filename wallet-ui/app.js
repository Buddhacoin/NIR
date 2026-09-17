import { normalizeNodePolicy, selectNodeHealth } from "./node-selection.js";
import { ADDRESS_PATTERN, readAddressBook, removeAddressBookContact, saveAddressBookContact } from "./address-book.js";
import { decodePaymentQrFrames, drawQr, encodePaymentQrFrames } from "./qr.js";
import { decodeVerifiedSimulation } from "./transaction-decoder.js";

const messages = {
  receive: ["Получить NIR", "Сначала подключите локальный vault, чтобы показать публичный адрес."],
  send: ["Отправить NIR", "Подключите локальный vault. Перед подписью кошелёк покажет адрес, сумму, комиссию и процент комиссии."],
  mine: ["Майнинг интеллекта", "Здесь можно будет выбрать роль, проверить оборудование и получить назначенное задание. Сейчас доступен только локальный демонстрационный режим."],
  history: ["История операций", "Операций пока нет. После подключения узла здесь появятся подтверждённые переводы, комиссии и награды."],
  resources: ["Ресурсы сети", "Заблокируйте NIR, чтобы получать Transfer Credits или безопасно делегировать лимит переводов другому адресу."],
  settings: ["Настройки", "Переключение темы уже работает. Session token хранится только в памяти страницы и исчезает при её закрытии."],
  network: ["Local testnet", "Это локальная тестовая сеть. Реальные NIR и вывод средств отключены."],
};

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8788";
const NIR_ADDRESS = ADDRESS_PATTERN;
const panel = document.querySelector("#panel");
const panelTitle = document.querySelector("#panel-title");
const panelCopy = document.querySelector("#panel-copy");
const bridgePanel = document.querySelector("#bridge-panel");
const receivePanel = document.querySelector("#receive-panel");
const sendPanel = document.querySelector("#send-panel");
const resourcesPanel = document.querySelector("#resources-panel");
const settingsPanel = document.querySelector("#settings-panel");
const setupPanel = document.querySelector("#setup-panel");
const contactsPanel = document.querySelector("#contacts-panel");
const onboarding = document.querySelector("#onboarding");
const bridgeStatus = document.querySelector("#bridge-status");
const receiveStatus = document.querySelector("#receive-status");
const sendStatus = document.querySelector("#send-status");
const resourcesStatus = document.querySelector("#resources-status");
let bridgeSession = null;
let walletInfo = null;
let networkInfo = null;
let activeNodeUrl = null;
let nodePolicy = null;
let pendingIntent = null;
let pendingSimulation = null;
let pendingResourceIntent = null;
let pendingPaymentRequest = null;
let signedTransaction = null;
let signedResourceTransaction = null;
let addressBook = readAddressBook();
let pendingAddressChange = null;
let paymentRequestQrFrames = [];
let paymentRequestQrIndex = 0;

function renderWalletConnection() {
  const connected = Boolean(walletInfo && bridgeSession);
  onboarding.hidden = connected;
  document.querySelector("#disconnect-wallet").hidden = !connected;
  document.querySelector("#settings-connect").hidden = connected;
  document.querySelector("#security-state").textContent = connected
    ? `Vault подключён · ${walletInfo.address.slice(0, 16)}…`
    : "Vault не подключён";
}

function clearWalletSession(message = "Vault отключён · ключи и session token отсутствуют в странице") {
  bridgeSession = null;
  walletInfo = null;
  pendingIntent = null;
  signedTransaction = null;
  signedResourceTransaction = null;
  pendingSimulation = null;
  pendingResourceIntent = null;
  pendingPaymentRequest = null;
  document.querySelector("#balance-value").textContent = "0.00000000";
  document.querySelector("#wallet-state").textContent = message;
  document.querySelector("#signed-json").value = "";
  document.querySelector("#resource-signed-json").value = "";
  document.querySelector("#send-review").hidden = true;
  document.querySelector("#signed-result").hidden = true;
  document.querySelector("#transfer-simulation").hidden = true;
  document.querySelector("#resource-signed").hidden = true;
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
  const add = (term, value) => {
    const row = document.createElement("div");
    const dt = document.createElement("dt"); const dd = document.createElement("dd");
    dt.textContent = term; dd.textContent = value; row.append(dt, dd); fields.append(row);
  };
  add("Операция", simulation.type);
  add("Сеть", `${simulation.networkId} · состояние на блоке ${simulation.stateHeight}`);
  add("Полномочия", simulation.authority.map((item) => `${item.role}: ${item.address}`).join(" · "));
  add("Комиссия", `${formatAtomic(simulation.fee.amount)} NIR · платит ${simulation.fee.payer ?? "ресурс сети"}`);
  for (const effect of simulation.balance) {
    const sign = BigInt(effect.delta) > 0n ? "+" : "";
    add(`Баланс: ${effect.role}`, `${effect.address ?? "получатель комиссии"}: ${sign}${effect.delta} atomic NIR`);
  }
  for (const resource of simulation.resources) add(`Ресурс: ${resource.role}`, resource.details || "изменение подтверждено");
  for (const nonce of simulation.nonces) add(`Nonce: ${nonce.role}`, `${nonce.address}: ${nonce.before} → ${nonce.after}`);
  for (const risk of simulation.risks) {
    const item = document.createElement("li"); item.className = "risk-info";
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

function showMessage(key, copy = null) {
  const [title, defaultCopy] = messages[key];
  panelTitle.textContent = title;
  panelCopy.textContent = copy ?? defaultCopy;
  if (!panel.open) panel.showModal();
}

function exactLoopbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Разрешён только точный локальный адрес bridge.");
  }
  return url.origin;
}

async function bridgeRequest(path, options = {}) {
  if (!bridgeSession) throw new Error("Сначала подключите vault.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${bridgeSession.url}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "x-nir-bridge-token": bridgeSession.token,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401) clearWalletSession("Сессия vault завершена · подключитесь снова");
      throw new Error(result.error || "Локальный bridge отклонил запрос.");
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
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
  if (!walletInfo || !networkInfo) throw new Error("Подключите vault и локальный узел.");
  const response = await fetch(nodeUrl(`/v1/accounts/${encodeURIComponent(walletInfo.address)}`));
  if (!response.ok) throw new Error("Не удалось получить nonce и баланс от узла.");
  const account = await response.json();
  try {
    const handoffResponse = await fetch(nodeUrl("/v1/validator-handoffs"));
    if (handoffResponse.ok) {
      const history = await handoffResponse.json();
      await bridgeRequest("/v1/update-validator-trust", {
        method: "POST", body: JSON.stringify({ handoffs: history.handoffs }),
      });
    }
    const trust = await bridgeRequest("/v1/trust-info");
    if (trust.enabled && trust.tipHash && networkInfo.height > trust.minimumHeight) {
      let verifiedHeight = trust.minimumHeight;
      while (verifiedHeight < networkInfo.height) {
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
      nodeUrl(`/v1/accounts/${encodeURIComponent(walletInfo.address)}/proof`),
    );
    if (!proofResponse.ok) throw new Error("proof unavailable");
    const proof = await proofResponse.json();
    const verified = await bridgeRequest("/v1/verify-account-proof", {
      method: "POST",
      body: JSON.stringify({
        address: walletInfo.address,
        minimumHeight: networkInfo.height,
        proof,
      }),
    });
    const historyCount = verified.statement.account.history.count;
    const historyResponse = await fetch(nodeUrl(
      `/v1/accounts/${encodeURIComponent(walletInfo.address)}/history?before=${historyCount}&limit=20`,
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
      ...account,
      ...verified.statement.account,
      proofHeight: verified.statement.height,
      proofVerified: true,
      unavailableTransactions,
      verifiedTransactions,
    };
  } catch {
    return { ...account, proofVerified: false };
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
  try {
    const account = await readAccount();
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
    document.querySelector("#wallet-state").textContent = account.proofVerified
      ? `Кворум подтвердил баланс · блок ${account.proofHeight}`
      : `Подключён ${walletInfo.address.slice(0, 12)}… · данные одного узла`;
    renderTransactions(account);
  } catch {
    document.querySelector("#wallet-state").textContent = "Vault подключён · локальный узел недоступен";
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
    const address = document.createElement("span"); address.textContent = contact.address;
    address.setAttribute("aria-label", `Полный адрес ${contact.address}, сеть ${contact.networkId}`);
    copy.append(label, address);
    const use = document.createElement("button"); use.type = "button"; use.className = "secondary compact"; use.textContent = "Выбрать";
    use.onclick = () => {
      document.querySelector("#send-recipient").value = contact.address;
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
    setContactForm(); renderContacts(); contactsPanel.showModal();
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

async function openResources() {
  if (!walletInfo) return openBridgePanel();
  resourcesStatus.textContent = "Обновление…";
  resourcesPanel.showModal();
  await refreshAccount();
  resourcesStatus.textContent = "";
}

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
  if (!pendingResourceIntent || !pendingSimulation) return;
  event.currentTarget.disabled = true;
  resourcesStatus.textContent = "Повторная симуляция перед подписью…";
  try {
    const refreshed = await recheckSimulation(pendingResourceIntent, pendingSimulation);
    resourcesStatus.textContent = "Подтвердите параметры и пароль только в терминале bridge…";
    const signed = await bridgeRequest("/v1/sign-resource", {
      method: "POST", body: JSON.stringify({ ...pendingResourceIntent, simulationId: refreshed.simulationId }),
    });
    assertSignedMatchesIntent(signed.transaction, pendingResourceIntent);
    signedResourceTransaction = signed.transaction;
    document.querySelector("#resource-signed-json").value = JSON.stringify(signedResourceTransaction, null, 2);
    document.querySelector("#resource-signed").hidden = false;
    clearSimulation("#resource-simulation");
    pendingResourceIntent = null; pendingSimulation = null;
    resourcesStatus.textContent = "Подписано локально. Отправка остаётся отдельным действием.";
  } catch (error) { resourcesStatus.textContent = error.message; }
  finally { event.currentTarget.disabled = false; }
};
document.querySelector("#edit-resource-simulation").onclick = () => {
  pendingResourceIntent = null; pendingSimulation = null; clearSimulation("#resource-simulation");
  resourcesStatus.textContent = "Симуляция отменена. Операция не подписана.";
};

document.querySelector("#submit-resource").onclick = async (event) => {
  if (!signedResourceTransaction) return;
  event.currentTarget.disabled = true;
  resourcesStatus.textContent = "Повторная проверка тестовой сети…";
  try {
    await selectActiveNode();
    const health = await fetch(nodeUrl("/health")).then((response) => response.json());
    if (health.valueMode !== "valueless-devnet" ||
        health.networkId !== signedResourceTransaction.networkId) {
      throw new Error("Сеть изменилась после подписи; транзакция не отправлена.");
    }
    const response = await fetch(nodeUrl("/v1/transactions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signedResourceTransaction),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Узел отклонил операцию.");
    resourcesStatus.textContent = `Подтверждено в блоке ${result.height}.`;
    signedResourceTransaction = null;
    document.querySelector("#resource-signed").hidden = true;
    await refreshNodeStatus();
  } catch (error) { resourcesStatus.textContent = error.message; }
  finally { event.currentTarget.disabled = false; }
};

document.querySelector("#discard-resource").onclick = () => {
  signedResourceTransaction = null;
  document.querySelector("#resource-signed-json").value = "";
  document.querySelector("#resource-signed").hidden = true;
  resourcesStatus.textContent = "Подписанная операция удалена и не отправлена.";
};

document.querySelector("#stake-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await prepareResourceSimulation({
      amount: parseNir(document.querySelector("#stake-amount").value), type: "credit-stake",
    });
    event.currentTarget.reset();
  } catch (error) { resourcesStatus.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector("#delegation-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    const delegate = document.querySelector("#delegate-address").value.trim();
    const limit = Number(document.querySelector("#delegate-limit").value);
    if (!NIR_ADDRESS.test(delegate) || delegate === walletInfo.address ||
        !Number.isSafeInteger(limit) || limit < 0 || limit > 1_000_000) {
      throw new Error("Проверьте адрес и целый лимит от 0 до 1 000 000.");
    }
    await prepareResourceSimulation({ delegate, limit, type: "credit-delegation" });
    event.currentTarget.reset();
  } catch (error) { resourcesStatus.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector("#unstake-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await prepareResourceSimulation({
      amount: parseNir(document.querySelector("#unstake-amount").value),
      type: "credit-unstake-request",
    });
    event.currentTarget.reset();
  } catch (error) { resourcesStatus.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector("#claim-unstake").onclick = async (event) => {
  event.currentTarget.disabled = true;
  try { await prepareResourceSimulation({ type: "credit-unstake-claim" }); }
  catch (error) { resourcesStatus.textContent = error.message; }
  finally { event.currentTarget.disabled = false; }
};

function openBridgePanel() {
  bridgeStatus.textContent = "";
  document.querySelector("#bridge-url").value = bridgeSession?.url ?? DEFAULT_BRIDGE_URL;
  document.querySelector("#bridge-code").value = "";
  bridgePanel.showModal();
}

function openSetupPanel() {
  if (settingsPanel.open) settingsPanel.close();
  setupPanel.showModal();
}

function openSettingsPanel() {
  renderWalletConnection();
  settingsPanel.showModal();
}

document.querySelector("#bridge-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  bridgeStatus.textContent = "Подключение…";
  const codeInput = document.querySelector("#bridge-code");
  try {
    const url = exactLoopbackUrl(document.querySelector("#bridge-url").value);
    const code = codeInput.value.trim();
    if (!/^[0-9]{8}$/.test(code)) throw new Error("Введите восьмизначный одноразовый код.");
    const token = await pairBridge(url, code);
    bridgeSession = { token, url };
    walletInfo = await bridgeRequest("/v1/wallet");
    codeInput.value = "";
    bridgeStatus.textContent = `Подключён ${walletInfo.address.slice(0, 16)}…`;
    renderWalletConnection();
    await refreshNodeStatus();
    setTimeout(() => bridgePanel.open && bridgePanel.close(), 450);
  } catch (error) {
    bridgeSession = null;
    walletInfo = null;
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
  document.querySelector("#receive-address").textContent = walletInfo.address;
  document.querySelector("#receive-network").textContent = `Сеть: ${networkInfo.networkId}`;
  drawQr(document.querySelector("#receive-qr"), `nir:${walletInfo.address}`, `QR публичного адреса ${walletInfo.address}; сеть ${networkInfo.networkId}`);
  document.querySelector("#payment-request-result").hidden = true;
  document.querySelector("#payment-request-simulation").hidden = true;
  document.querySelector("#payment-request-form").hidden = false;
  document.querySelector("#payment-request-qr-card").hidden = true;
  document.querySelector("#payment-request-json").value = "";
  paymentRequestQrFrames = [];
  receiveStatus.textContent = "";
  receivePanel.showModal();
}

document.querySelector("#payment-request-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
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
    event.currentTarget.hidden = true;
    receiveStatus.textContent = "Проверьте последствия. Подпись ещё не создана.";
  } catch (error) { receiveStatus.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector("#confirm-payment-request-simulation").onclick = async (event) => {
  if (!pendingPaymentRequest) return;
  event.currentTarget.disabled = true; receiveStatus.textContent = "Повторная симуляция перед подписью…";
  try {
    const account = await readAccount();
    if (!account.proofVerified) throw new Error("Состояние сети больше не подтверждено. Подпись отменена.");
    const refreshed = await simulateIntent(pendingPaymentRequest.intent, account);
    if (!sameSimulation(refreshed, pendingPaymentRequest.simulation)) throw new Error("Результат симуляции изменился. Подпись отменена.");
    const result = await bridgeRequest("/v1/sign-payment-request", {
      method: "POST", body: JSON.stringify({ ...pendingPaymentRequest.intent, simulationId: refreshed.simulationId }),
    });
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
  finally { event.currentTarget.disabled = false; }
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
  sendPanel.showModal();
}

document.querySelector("#verify-payment-request").onclick = async (event) => {
  event.currentTarget.disabled = true;
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
  } finally { event.currentTarget.disabled = false; }
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
  event.preventDefault();
  sendStatus.textContent = "Симуляция перевода с доказательством состояния…";
  try {
    const recipient = document.querySelector("#send-recipient").value.trim();
    if (!NIR_ADDRESS.test(recipient)) throw new Error("Адрес получателя NIR неверен.");
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
    event.currentTarget.hidden = true;
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

document.querySelector("#request-signature").onclick = async () => {
  if (!pendingIntent || !pendingSimulation) return;
  const signButton = document.querySelector("#request-signature");
  signButton.disabled = true;
  sendStatus.textContent = "Подтвердите запрос и введите пароль в терминале bridge…";
  try {
    const refreshed = await recheckSimulation(pendingIntent, pendingSimulation);
    const result = await bridgeRequest("/v1/sign", {
      method: "POST",
      body: JSON.stringify({ ...pendingIntent, simulationId: refreshed.simulationId }),
    });
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
  const submitButton = document.querySelector("#submit-signed");
  submitButton.disabled = true;
  sendStatus.textContent = "Повторная проверка тестовой сети…";
  try {
    await selectActiveNode();
    const healthResponse = await fetch(nodeUrl("/health"));
    if (!healthResponse.ok) throw new Error("Локальный узел не отвечает.");
    const currentNetwork = await healthResponse.json();
    if (currentNetwork.valueMode !== "valueless-devnet") {
      throw new Error("Отправка разрешена только в сети без реальной стоимости.");
    }
    if (currentNetwork.networkId !== signedTransaction.networkId) {
      throw new Error("Сеть узла не совпадает с сетью подписанной транзакции.");
    }
    const response = await fetch(nodeUrl("/v1/transactions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signedTransaction),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Узел отклонил транзакцию.");
    sendStatus.textContent = `Принято local testnet · ${result.transactionId ?? result.status}`;
    submitButton.hidden = true;
    signedTransaction = null;
    await refreshNodeStatus();
  } catch (error) {
    sendStatus.textContent = error.message;
    submitButton.disabled = false;
  }
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
    else showMessage(button.dataset.action);
  });
});
document.querySelector("#panel .close").onclick = () => panel.close();
document.querySelector("#panel .primary").onclick = () => panel.close();
document.querySelectorAll("[data-close]").forEach((button) => {
  button.onclick = () => document.querySelector(`#${button.dataset.close}`).close();
});
document.querySelector("#settings-connect").onclick = () => {
  settingsPanel.close();
  openBridgePanel();
};
document.querySelector("#settings-setup").onclick = openSetupPanel;
document.querySelector("#setup-connect").onclick = () => {
  setupPanel.close();
  openBridgePanel();
};
document.querySelector("#disconnect-wallet").onclick = async (event) => {
  event.currentTarget.disabled = true;
  try {
    if (bridgeSession) await bridgeRequest("/v1/session", { method: "DELETE" });
  } catch {
    // Local state is still erased if the bridge has already stopped or the session expired.
  } finally {
    clearWalletSession();
    event.currentTarget.disabled = false;
    settingsPanel.close();
  }
};

const navigationButtons = [...document.querySelectorAll("[data-nav]")];
navigationButtons.forEach((button) => button.addEventListener("click", () => {
  navigationButtons.forEach((candidate) => {
    const selected = candidate === button;
    candidate.classList.toggle("active", selected);
    if (selected) candidate.setAttribute("aria-current", "page");
    else candidate.removeAttribute("aria-current");
  });
  const destination = button.dataset.nav;
  if (destination === "home") window.scrollTo({ top: 0, behavior: "smooth" });
  else if (destination === "resources") openResources();
  else if (destination === "history") {
    document.querySelector("#history").scrollIntoView({ behavior: "smooth", block: "center" });
    showMessage("history");
  } else if (destination === "settings") openSettingsPanel();
  else showMessage(destination);
}));

const themeButton = document.querySelector("#theme");
const setTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme === "light" ? "☾" : "☀";
  themeButton.setAttribute("aria-label", theme === "light" ? "Включить тёмную тему" : "Включить дневную тему");
  localStorage.setItem("nir-theme", theme);
};
setTheme(localStorage.getItem("nir-theme") || "light");
themeButton.onclick = () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");

const networkButton = document.querySelector(".network");
async function loadNodePolicy() {
  if (nodePolicy) return nodePolicy;
  const response = await fetch("./nodes.json", { cache: "no-store" });
  if (!response.ok) throw new Error("node policy unavailable");
  nodePolicy = normalizeNodePolicy(await response.json());
  return nodePolicy;
}

async function selectActiveNode() {
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
  try {
    await selectActiveNode();
    networkButton.textContent = `● ${networkInfo.agreeingNodes}/${networkInfo.availableNodes} · h${networkInfo.height}`;
    networkButton.classList.add("connected");
    networkButton.classList.remove("offline");
    messages.network = ["Узлы NIR подключены", `${networkInfo.networkId}, высота ${networkInfo.height}. Совпадающих узлов: ${networkInfo.agreeingNodes} из ${networkInfo.availableNodes}.`];
    await refreshAccount();
  } catch {
    networkInfo = null;
    activeNodeUrl = null;
    networkButton.textContent = "○ Nodes offline";
    networkButton.classList.add("offline");
    networkButton.classList.remove("connected");
    messages.network = ["Узлы NIR не подтверждены", "Нет достаточного числа доступных узлов с совпадающим финализированным состоянием."];
  }
}
refreshNodeStatus();
renderWalletConnection();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js");
}

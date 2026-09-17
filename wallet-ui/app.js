const messages = {
  receive: ["Получить NIR", "Сначала подключите локальный vault, чтобы показать публичный адрес."],
  send: ["Отправить NIR", "Подключите локальный vault. Перед подписью кошелёк покажет адрес, сумму, комиссию и процент комиссии."],
  mine: ["Майнинг интеллекта", "Здесь можно будет выбрать роль, проверить оборудование и получить назначенное задание. Сейчас доступен только локальный демонстрационный режим."],
  history: ["История операций", "Операций пока нет. После подключения узла здесь появятся подтверждённые переводы, комиссии и награды."],
  resources: ["Ресурсы сети", "Заблокируйте NIR, чтобы получать Transfer Credits или безопасно делегировать лимит переводов другому адресу."],
  settings: ["Настройки", "Переключение темы уже работает. Session token хранится только в памяти страницы и исчезает при её закрытии."],
  network: ["Local testnet", "Это локальная тестовая сеть. Реальные NIR и вывод средств отключены."],
};

const NODE_URL = "http://127.0.0.1:8787";
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8788";
const NIR_ADDRESS = /^nir1[0-9a-f]{64}$/;
const panel = document.querySelector("#panel");
const panelTitle = document.querySelector("#panel-title");
const panelCopy = document.querySelector("#panel-copy");
const bridgePanel = document.querySelector("#bridge-panel");
const sendPanel = document.querySelector("#send-panel");
const resourcesPanel = document.querySelector("#resources-panel");
const bridgeStatus = document.querySelector("#bridge-status");
const sendStatus = document.querySelector("#send-status");
const resourcesStatus = document.querySelector("#resources-status");
let bridgeSession = null;
let walletInfo = null;
let networkInfo = null;
let pendingIntent = null;
let signedTransaction = null;
let signedResourceTransaction = null;

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
    if (!response.ok) throw new Error(result.error || "Локальный bridge отклонил запрос.");
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

async function readAccount() {
  if (!walletInfo || !networkInfo) throw new Error("Подключите vault и локальный узел.");
  const response = await fetch(`${NODE_URL}/v1/accounts/${encodeURIComponent(walletInfo.address)}`);
  if (!response.ok) throw new Error("Не удалось получить nonce и баланс от узла.");
  return response.json();
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
    document.querySelector("#wallet-state").textContent = `Подключён ${walletInfo.address.slice(0, 12)}… · тестовая сеть`;
  } catch {
    document.querySelector("#wallet-state").textContent = "Vault подключён · локальный узел недоступен";
  }
}

function randomRequestId() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function openResources() {
  if (!walletInfo) return openBridgePanel();
  resourcesStatus.textContent = "Обновление…";
  resourcesPanel.showModal();
  await refreshAccount();
  resourcesStatus.textContent = "";
}

async function resourceFee() {
  const response = await fetch(`${NODE_URL}/v1/fees?amount=1`);
  if (!response.ok) throw new Error("Узел не смог рассчитать комиссию.");
  return (await response.json()).amount;
}

async function signResource(fields) {
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
  if (["credit-stake", "credit-delegation"].includes(intent.type)) {
    intent.fee = await resourceFee();
  }
  resourcesStatus.textContent = "Подтвердите точные параметры и пароль в терминале bridge…";
  const signed = await bridgeRequest("/v1/sign-resource", {
    method: "POST", body: JSON.stringify(intent),
  });
  signedResourceTransaction = signed.transaction;
  document.querySelector("#resource-signed-json").value =
    JSON.stringify(signedResourceTransaction, null, 2);
  document.querySelector("#resource-signed").hidden = false;
  resourcesStatus.textContent = "Подписано локально. Проверьте JSON перед отдельной отправкой.";
}

document.querySelector("#submit-resource").onclick = async (event) => {
  if (!signedResourceTransaction) return;
  event.currentTarget.disabled = true;
  resourcesStatus.textContent = "Повторная проверка тестовой сети…";
  try {
    const health = await fetch(`${NODE_URL}/health`).then((response) => response.json());
    if (health.valueMode !== "valueless-devnet" ||
        health.networkId !== signedResourceTransaction.networkId) {
      throw new Error("Сеть изменилась после подписи; транзакция не отправлена.");
    }
    const response = await fetch(`${NODE_URL}/v1/transactions`, {
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
    await signResource({
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
    await signResource({ delegate, limit, type: "credit-delegation" });
    event.currentTarget.reset();
  } catch (error) { resourcesStatus.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector("#unstake-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await signResource({
      amount: parseNir(document.querySelector("#unstake-amount").value),
      type: "credit-unstake-request",
    });
    event.currentTarget.reset();
  } catch (error) { resourcesStatus.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector("#claim-unstake").onclick = async (event) => {
  event.currentTarget.disabled = true;
  try { await signResource({ type: "credit-unstake-claim" }); }
  catch (error) { resourcesStatus.textContent = error.message; }
  finally { event.currentTarget.disabled = false; }
};

function openBridgePanel() {
  bridgeStatus.textContent = "";
  document.querySelector("#bridge-url").value = bridgeSession?.url ?? DEFAULT_BRIDGE_URL;
  document.querySelector("#bridge-code").value = "";
  bridgePanel.showModal();
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
    await refreshAccount();
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
  showMessage("receive", `Ваш публичный адрес:\n${walletInfo.address}\n\nПриватный ключ остаётся в зашифрованном vault.`);
}

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

document.querySelector("#send-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  sendStatus.textContent = "Проверка комиссии и nonce…";
  try {
    const recipient = document.querySelector("#send-recipient").value.trim();
    if (!NIR_ADDRESS.test(recipient)) throw new Error("Адрес получателя NIR неверен.");
    if (recipient === walletInfo.address) throw new Error("Нельзя отправить перевод на тот же адрес.");
    const amount = parseNir(document.querySelector("#send-amount").value);
    const [account, quoteResponse] = await Promise.all([
      readAccount(),
      fetch(`${NODE_URL}/v1/fees?amount=${encodeURIComponent(amount)}`),
    ]);
    if (!quoteResponse.ok) throw new Error("Узел не смог рассчитать комиссию.");
    const quote = await quoteResponse.json();
    pendingIntent = {
      amount,
      fee: quote.amount,
      networkId: networkInfo.networkId,
      nonce: account.nextNonce,
      recipient,
      requestId: [...crypto.getRandomValues(new Uint8Array(32))]
        .map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
    document.querySelector("#review-recipient").textContent = recipient;
    document.querySelector("#review-amount").textContent = `${formatAtomic(amount)} NIR`;
    document.querySelector("#review-fee").textContent = `${formatAtomic(quote.amount)} NIR · ${quote.percent}`;
    document.querySelector("#review-network").textContent = `${networkInfo.networkId} · ${account.nextNonce}`;
    event.currentTarget.hidden = true;
    document.querySelector("#send-review").hidden = false;
    sendStatus.textContent = quote.requiresExplicitConfirmation ? "Внимание: комиссия выше порога предупреждения." : "";
  } catch (error) {
    sendStatus.textContent = error.message;
  }
});

document.querySelector("#edit-transfer").onclick = () => {
  pendingIntent = null;
  document.querySelector("#send-review").hidden = true;
  document.querySelector("#send-form").hidden = false;
  sendStatus.textContent = "";
};

document.querySelector("#request-signature").onclick = async () => {
  if (!pendingIntent) return;
  const signButton = document.querySelector("#request-signature");
  signButton.disabled = true;
  sendStatus.textContent = "Подтвердите запрос и введите пароль в терминале bridge…";
  try {
    const result = await bridgeRequest("/v1/sign", {
      method: "POST",
      body: JSON.stringify(pendingIntent),
    });
    document.querySelector("#signed-json").value = JSON.stringify(result.transaction, null, 2);
    signedTransaction = result.transaction;
    document.querySelector("#send-review").hidden = true;
    document.querySelector("#signed-result").hidden = false;
    sendStatus.textContent = "Подписано. Автоматическая отправка намеренно отключена.";
    pendingIntent = null;
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
    const healthResponse = await fetch(`${NODE_URL}/health`);
    if (!healthResponse.ok) throw new Error("Локальный узел не отвечает.");
    const currentNetwork = await healthResponse.json();
    if (currentNetwork.valueMode !== "valueless-devnet") {
      throw new Error("Отправка разрешена только в сети без реальной стоимости.");
    }
    if (currentNetwork.networkId !== signedTransaction.networkId) {
      throw new Error("Сеть узла не совпадает с сетью подписанной транзакции.");
    }
    const response = await fetch(`${NODE_URL}/v1/transactions`, {
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
    else showMessage(button.dataset.action);
  });
});
document.querySelector("#panel .close").onclick = () => panel.close();
document.querySelector("#panel .primary").onclick = () => panel.close();
document.querySelectorAll("[data-close]").forEach((button) => {
  button.onclick = () => document.querySelector(`#${button.dataset.close}`).close();
});

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
  } else if (destination === "settings" && !walletInfo) openBridgePanel();
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
async function refreshNodeStatus() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`${NODE_URL}/health`, { signal: controller.signal });
    if (!response.ok) throw new Error("node unavailable");
    networkInfo = await response.json();
    networkButton.textContent = `● Connected · h${networkInfo.height}`;
    networkButton.classList.add("connected");
    networkButton.classList.remove("offline");
    messages.network = ["NIR node подключён", `${networkInfo.networkId}, высота ${networkInfo.height}. Режим: тестовые единицы без реальной стоимости.`];
    await refreshAccount();
  } catch {
    networkInfo = null;
    networkButton.textContent = "○ Node offline";
    networkButton.classList.add("offline");
    networkButton.classList.remove("connected");
    messages.network = ["NIR node не подключён", "Запустите локальный узел на 127.0.0.1:8787. Кошелёк повторит проверку после обновления страницы."];
  } finally {
    clearTimeout(timeout);
  }
}
refreshNodeStatus();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js");
}

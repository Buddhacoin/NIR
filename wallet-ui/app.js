const messages = {
  receive: ["Получить NIR", "Сначала подключите локальный vault, чтобы показать публичный адрес."],
  send: ["Отправить NIR", "Подключите локальный vault. Перед подписью кошелёк покажет адрес, сумму, комиссию и процент комиссии."],
  mine: ["Майнинг интеллекта", "Здесь можно будет выбрать роль, проверить оборудование и получить назначенное задание. Сейчас доступен только локальный демонстрационный режим."],
  history: ["История операций", "Операций пока нет. После подключения узла здесь появятся подтверждённые переводы, комиссии и награды."],
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
const bridgeStatus = document.querySelector("#bridge-status");
const sendStatus = document.querySelector("#send-status");
let bridgeSession = null;
let walletInfo = null;
let networkInfo = null;
let pendingIntent = null;

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
    document.querySelector("#wallet-state").textContent = `Подключён ${walletInfo.address.slice(0, 12)}… · тестовая сеть`;
  } catch {
    document.querySelector("#wallet-state").textContent = "Vault подключён · локальный узел недоступен";
  }
}

function openBridgePanel() {
  bridgeStatus.textContent = "";
  document.querySelector("#bridge-url").value = bridgeSession?.url ?? DEFAULT_BRIDGE_URL;
  document.querySelector("#bridge-token").value = "";
  bridgePanel.showModal();
}

document.querySelector("#bridge-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  bridgeStatus.textContent = "Подключение…";
  const tokenInput = document.querySelector("#bridge-token");
  try {
    const url = exactLoopbackUrl(document.querySelector("#bridge-url").value);
    const token = tokenInput.value.trim();
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("Session token должен содержать 64 шестнадцатеричных символа.");
    bridgeSession = { token, url };
    walletInfo = await bridgeRequest("/v1/wallet");
    tokenInput.value = "";
    bridgeStatus.textContent = `Подключён ${walletInfo.address.slice(0, 16)}…`;
    await refreshAccount();
    setTimeout(() => bridgePanel.open && bridgePanel.close(), 450);
  } catch (error) {
    bridgeSession = null;
    walletInfo = null;
    tokenInput.value = "";
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

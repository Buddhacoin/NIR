import { accountFromPhrase, createPhrase, decryptPhrase, encryptPhrase } from "./crypto.js";
import { hasEnglishTranslation, supportedLanguages, translate } from "./i18n.js";

const extensionStorage = globalThis.browser?.storage?.local ?? globalThis.chrome?.storage?.local;
const STORE_KEY = extensionStorage ? "nirTestWallet" : "nirTestWalletWeb";
const LANGUAGE_KEY = "nirWalletLanguage";
const storage = extensionStorage ?? {
  async get(key) {
    const value = localStorage.getItem(key);
    return { [key]: value === null ? undefined : JSON.parse(value) };
  },
  async set(values) {
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(value));
  },
};
if (!extensionStorage && window.top !== window.self) {
  document.body.textContent = "Откройте NIR Wallet напрямую, а не внутри другого сайта.";
  throw new Error("Embedded wallet refused");
}
const $ = (selector) => document.querySelector(selector);
let language = "ru";
const t = (source) => translate(source, language);
const translatedNodes = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
while (walker.nextNode()) {
  const node = walker.currentNode;
  const source = node.textContent.trim();
  if (hasEnglishTranslation(source)) translatedNodes.push([node, node.textContent, source]);
}
const translatedAttributes = [];
for (const element of document.querySelectorAll("[title], [aria-label]")) {
  for (const name of ["title", "aria-label"]) {
    const source = element.getAttribute(name);
    if (source && hasEnglishTranslation(source)) translatedAttributes.push([element, name, source]);
  }
}
function applyLanguage(next) {
  language = next;
  document.documentElement.lang = next;
  $("#language-switch").value = next;
  for (const [node, original, source] of translatedNodes) node.textContent = original.replace(source, t(source));
  for (const [element, name, source] of translatedAttributes) element.setAttribute(name, t(source));
  if ($("#account-label")) $("#account-label").textContent = `${t("Адрес")} ${selectedIndex + 1}`;
  for (const label of document.querySelectorAll("#confirm-fields label")) {
    const position = Number(label.querySelector("input")?.name.slice(4));
    if (Number.isInteger(position)) label.firstChild.textContent = `${t("Слово №")} ${position + 1}`;
  }
  document.querySelectorAll("#account-list button strong").forEach((title, index) => {
    title.textContent = `${t("Адрес")} ${index + 1}${index === selectedIndex ? " ✓" : ""}`;
  });
  $("#status").textContent = "";
}
let profile = null;
let phrase = null;
let pending = null;
let accountCount = 1;
let selectedIndex = 0;
let busy = false;
let revealed = null;

function screen(name) {
  for (const section of document.querySelectorAll("main > section")) section.hidden = section.id !== name;
  $("#status").textContent = "";
  $("#status").classList.remove("ok");
  if (name !== "reveal") hideRevealed();
}

function status(message, ok = false) {
  $("#status").textContent = message;
  $("#status").classList.toggle("ok", ok);
}

function hideRevealed() {
  revealed = null;
  $("#reveal-grid").replaceChildren();
  $("#reveal-result").hidden = true;
  $("#reveal-form").reset();
}

function phraseGrid(container, value) {
  const cells = value.split(" ").map((word, index) => {
    const cell = document.createElement("span");
    const number = document.createElement("em");
    number.textContent = `${index + 1}.`;
    cell.append(number, document.createTextNode(word));
    return cell;
  });
  container.replaceChildren(...cells);
}

function shortAddress(address) { return `${address.slice(0, 10)}…${address.slice(-8)}`; }

async function currentAccount() {
  if (!phrase) throw new Error("Кошелёк заблокирован");
  return accountFromPhrase(phrase, selectedIndex);
}

async function saveProfile(next) {
  await storage.set({ [STORE_KEY]: next });
  profile = next;
}

async function renderHome() {
  const account = await currentAccount();
  $("#account-label").textContent = `${t("Адрес")} ${selectedIndex + 1}`;
  $("#short-address").textContent = shortAddress(account.address);
  $("#full-address").textContent = account.address;
  screen("home");
}

async function renderAccounts() {
  const rows = [];
  for (let index = 0; index < accountCount; index++) {
    const account = await accountFromPhrase(phrase, index);
    const button = document.createElement("button");
    const title = document.createElement("strong");
    title.textContent = `${t("Адрес")} ${index + 1}${index === selectedIndex ? " ✓" : ""}`;
    const detail = document.createElement("small");
    detail.textContent = shortAddress(account.address);
    button.append(title, detail);
    button.addEventListener("click", async () => {
      selectedIndex = index;
      await saveProfile({ ...profile, selectedIndex });
      await renderHome();
    });
    rows.push(button);
  }
  $("#account-list").replaceChildren(...rows);
  $("#add-account").disabled = accountCount >= 16;
  screen("accounts");
}

async function copy(value, kind) {
  await navigator.clipboard.writeText(value);
  status(t(kind === "phrase" ? "Фраза скопирована. Очистите буфер обмена после использования." : "Адрес скопирован. Очистите буфер обмена после использования."), true);
}

async function run(action) {
  if (busy) return;
  busy = true;
  try { await action(); }
  catch (error) { status(t(error instanceof Error ? error.message : "Не удалось выполнить действие")); }
  finally { busy = false; }
}

function credentials(form) {
  const password = form.elements.password.value;
  if (password !== form.elements.confirmation.value) throw new Error("Пароли не совпадают");
  return password;
}

$("#start-create").addEventListener("click", () => screen("create"));
$("#start-restore").addEventListener("click", () => screen("restore"));
$("#language-switch").addEventListener("change", (event) => {
  const next = event.currentTarget.value;
  if (!supportedLanguages.includes(next)) return;
  applyLanguage(next);
  storage.set({ [LANGUAGE_KEY]: next }).catch(() => status(t("Не удалось выполнить действие")));
});
for (const button of document.querySelectorAll("[data-back]")) {
  button.addEventListener("click", () => screen(button.dataset.back));
}

$("#create-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  run(async () => {
    if (profile) throw new Error("На этом устройстве уже есть кошелёк");
    const password = credentials(form);
    const createdPhrase = await createPhrase();
    const record = await encryptPhrase(createdPhrase, password);
    pending = { phrase: createdPhrase, record };
    form.reset();
    phraseGrid($("#phrase-grid"), createdPhrase);
    screen("backup");
  });
});

$("#copy-phrase").addEventListener("click", () => run(async () => {
  if (!pending) throw new Error("Создание кошелька прервано");
  await copy(pending.phrase, "phrase");
}));

$("#backup-next").addEventListener("click", () => {
  if (!pending) return;
  const fields = [3, 11, 19].map((position) => {
    const label = document.createElement("label");
    label.textContent = `${t("Слово №")} ${position + 1}`;
    const input = document.createElement("input");
    input.name = `word${position}`;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.required = true;
    label.append(input);
    return label;
  });
  $("#confirm-fields").replaceChildren(...fields);
  screen("confirm");
});

$("#confirm-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  run(async () => {
    if (!pending || profile) throw new Error("Создание кошелька прервано");
    const words = pending.phrase.split(" ");
    for (const position of [3, 11, 19]) {
      if (form.elements[`word${position}`].value.trim().toLowerCase() !== words[position]) {
        throw new Error(`${t("Проверьте слово №")} ${position + 1}`);
      }
    }
    await saveProfile({ vault: pending.record, accountCount: 1, selectedIndex: 0 });
    phrase = pending.phrase;
    pending = null;
    $("#phrase-grid").replaceChildren();
    form.reset();
    await renderHome();
  });
});

$("#restore-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  run(async () => {
    const password = credentials(form);
    const record = await encryptPhrase(form.elements.phrase.value, password);
    if (profile && profile.vault.address !== record.address) {
      throw new Error("Это фраза другого кошелька. Существующий кошелёк не заменён.");
    }
    phrase = await decryptPhrase(record, password);
    accountCount = profile?.accountCount ?? 1;
    selectedIndex = profile?.selectedIndex ?? 0;
    await saveProfile({ vault: record, accountCount, selectedIndex });
    form.reset();
    await renderHome();
  });
});

$("#unlock-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  run(async () => {
    if (!profile) throw new Error("На устройстве нет кошелька");
    phrase = await decryptPhrase(profile.vault, form.elements.password.value);
    accountCount = profile.accountCount;
    selectedIndex = profile.selectedIndex;
    form.reset();
    await renderHome();
  });
});

$("#forgot-password").addEventListener("click", () => screen("restore"));
$("#open-accounts").addEventListener("click", () => run(renderAccounts));
$("#add-account").addEventListener("click", () => run(async () => {
  if (accountCount >= 16) throw new Error("Достигнут предел 16 адресов");
  accountCount++;
  selectedIndex = accountCount - 1;
  await saveProfile({ ...profile, accountCount, selectedIndex });
  await renderHome();
}));
$("#copy-address").addEventListener("click", () => run(async () => copy((await currentAccount()).address, "address")));
$("#receive").addEventListener("click", () => screen("receive-view"));
$("#copy-full-address").addEventListener("click", () => run(async () => copy((await currentAccount()).address, "address")));
$("#nav-home").addEventListener("click", () => screen("home"));
$("#nav-settings").addEventListener("click", () => screen("settings"));
$("#show-phrase-form").addEventListener("click", () => screen("reveal"));
$("#lock-wallet").addEventListener("click", () => {
  phrase = null;
  pending = null;
  hideRevealed();
  screen("unlock");
});

$("#reveal-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  run(async () => {
    revealed = await decryptPhrase(profile.vault, form.elements.password.value);
    form.reset();
    phraseGrid($("#reveal-grid"), revealed);
    $("#reveal-result").hidden = false;
    status(t("Не показывайте эти слова никому."), true);
  });
});
$("#copy-revealed").addEventListener("click", () => run(async () => {
  if (!revealed) throw new Error("Сначала введите пароль");
  await copy(revealed, "phrase");
}));

if (storage.setAccessLevel) {
  await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}
try {
  const savedLanguage = (await storage.get(LANGUAGE_KEY))[LANGUAGE_KEY];
  if (supportedLanguages.includes(savedLanguage)) applyLanguage(savedLanguage);
} catch { /* Keep the default language if preferences are unavailable. */ }
let stored;
try { stored = (await storage.get(STORE_KEY))[STORE_KEY]; }
catch {
  screen("unlock");
  status(t("Не удалось прочитать локальные данные. Не удаляйте их; попробуйте открыть кошелёк в этом же браузере."));
  throw new Error("Wallet storage is unavailable or invalid");
}
if (stored !== undefined) {
  if (!stored || typeof stored !== "object" || !stored.vault ||
      !Number.isInteger(stored.accountCount) || stored.accountCount < 1 || stored.accountCount > 16 ||
      !Number.isInteger(stored.selectedIndex) || stored.selectedIndex < 0 ||
      stored.selectedIndex >= stored.accountCount) {
    screen("unlock");
    status(t("Данные кошелька повреждены. Обратитесь за помощью, не удаляйте расширение."));
  } else {
    profile = stored;
    screen("unlock");
  }
} else screen("welcome");

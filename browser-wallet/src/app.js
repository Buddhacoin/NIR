import { accountFromPhrase, createPhrase, decryptPhrase, encryptPhrase } from "./crypto.js";
import { createSessionGuard, reloadAfterPendingWrite } from "./session-guard.js";
import { applyStaticLocale, localize, safeUiError } from "./i18n.js";
import { createLocaleWriteQueue } from "./locale-write-queue.js";

const STORE_KEY = "nirTestWallet";
const LOCALE_KEY = "nirWalletLocale";
const extensionApi = globalThis.browser ?? globalThis.chrome;
const writeLocale = createLocaleWriteQueue((value) => extensionApi.storage.local.set({ [LOCALE_KEY]: value }));
const $ = (selector) => document.querySelector(selector);
let profile = null;
let phrase = null;
let pending = null;
let accountCount = 1;
let selectedIndex = 0;
let busy = false;
let revealed = null;
let sessionGeneration = 0;
let sessionExpired = false;
let profileWrite = null;
let locale = "ru";
let lastStatus = null;

function refreshLocale() {
  applyStaticLocale(locale);
  if ($("#account-label").textContent) {
    $("#account-label").textContent = localize(`Адрес ${selectedIndex + 1}`, locale);
  }
  for (const button of $("#account-list").querySelectorAll("button[data-index]")) {
    const index = Number(button.dataset.index);
    button.querySelector("strong").textContent = localize(`Адрес ${index + 1}${index === selectedIndex ? " ✓" : ""}`, locale);
  }
  for (const label of $("#confirm-fields").querySelectorAll("label[data-position]")) {
    label.firstChild.textContent = localize(`Слово № ${Number(label.dataset.position) + 1}`, locale);
  }
  if (lastStatus) $("#status").textContent = localize(lastStatus, locale);
}

function assertSession(generation) {
  if (sessionExpired || generation !== sessionGeneration) throw new Error("Сеанс кошелька завершён");
}

function clearSensitiveFields() {
  phrase = null;
  pending = null;
  revealed = null;
  for (const form of document.querySelectorAll("form")) form.reset();
  for (const selector of ["#phrase-grid", "#confirm-fields", "#reveal-grid", "#account-list"]) {
    $(selector).replaceChildren();
  }
  for (const selector of ["#full-address", "#short-address"]) $(selector).textContent = "";
  $("#reveal-result").hidden = true;
}

function expireSession() {
  if (sessionExpired) return;
  sessionExpired = true;
  sessionGeneration++;
  clearSensitiveFields();
  screen(profile ? "unlock" : "welcome");
  // Storage writes cannot be cancelled. Keep the UI locked, then reload from
  // the committed encrypted profile rather than racing an in-flight write.
  void reloadAfterPendingWrite(profileWrite, () => window.location.reload());
}

function screen(name) {
  if (sessionExpired && name !== "unlock" && name !== "welcome") return;
  if (name !== "restore") $("#restore-form").reset();
  for (const section of document.querySelectorAll("main > section")) section.hidden = section.id !== name;
  $("#status").textContent = "";
  lastStatus = null;
  $("#status").classList.remove("ok");
  if (name !== "reveal") hideRevealed();
}

function status(message, ok = false) {
  lastStatus = message;
  $("#status").textContent = localize(message, locale);
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
  const generation = sessionGeneration;
  const account = await accountFromPhrase(phrase, selectedIndex);
  assertSession(generation);
  return account;
}

async function saveProfile(next) {
  const generation = sessionGeneration;
  const write = extensionApi.storage.local.set({ [STORE_KEY]: next });
  profileWrite = write;
  try { await write; }
  finally { if (profileWrite === write) profileWrite = null; }
  assertSession(generation);
  profile = next;
}

async function renderHome() {
  const generation = sessionGeneration;
  const account = await currentAccount();
  assertSession(generation);
  $("#account-label").textContent = localize(`Адрес ${selectedIndex + 1}`, locale);
  $("#short-address").textContent = shortAddress(account.address);
  $("#full-address").textContent = account.address;
  screen("home");
}

async function renderAccounts() {
  const generation = sessionGeneration;
  const rows = [];
  for (let index = 0; index < accountCount; index++) {
    const account = await accountFromPhrase(phrase, index);
    assertSession(generation);
    const button = document.createElement("button");
    const title = document.createElement("strong");
    title.textContent = localize(`Адрес ${index + 1}${index === selectedIndex ? " ✓" : ""}`, locale);
    const detail = document.createElement("small");
    detail.textContent = shortAddress(account.address);
    button.append(title, detail);
    button.dataset.index = String(index);
    button.addEventListener("click", () => run(async () => {
      await saveProfile({ ...profile, selectedIndex: index });
      selectedIndex = index;
      await renderHome();
    }));
    rows.push(button);
  }
  $("#account-list").replaceChildren(...rows);
  $("#add-account").disabled = accountCount >= 16;
  screen("accounts");
}

async function copy(value, label) {
  const generation = sessionGeneration;
  await navigator.clipboard.writeText(value);
  assertSession(generation);
  status(`${label} скопирован. Очистите буфер обмена после использования.`, true);
}

async function run(action) {
  if (busy || sessionExpired) return;
  const generation = sessionGeneration;
  busy = true;
  try { await action(() => assertSession(generation)); assertSession(generation); }
  catch (error) {
    if (!sessionExpired) {
      status(safeUiError(error));
    }
  }
  finally { busy = false; }
}

function credentials(form) {
  const password = form.elements.password.value;
  if (password !== form.elements.confirmation.value) throw new Error("Пароли не совпадают");
  return password;
}

$("#start-create").addEventListener("click", () => screen("create"));
$("#start-restore").addEventListener("click", () => screen("restore"));
for (const button of document.querySelectorAll("[data-back]")) {
  button.addEventListener("click", () => {
    if (busy) {
      status("Подождите завершения текущего действия");
      return;
    }
    screen(button.dataset.back);
  });
}

$("#create-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  run(async (assertCurrent) => {
    if (profile) throw new Error("На этом устройстве уже есть кошелёк");
    const password = credentials(form);
    const createdPhrase = await createPhrase();
    assertCurrent();
    const record = await encryptPhrase(createdPhrase, password);
    assertCurrent();
    pending = { phrase: createdPhrase, record };
    form.reset();
    phraseGrid($("#phrase-grid"), createdPhrase);
    screen("backup");
  });
});

$("#copy-phrase").addEventListener("click", () => run(async () => {
  if (!pending) throw new Error("Создание кошелька прервано");
  await copy(pending.phrase, "Фраза");
}));

$("#backup-next").addEventListener("click", () => {
  if (!pending) return;
  const fields = [3, 11, 19].map((position) => {
    const label = document.createElement("label");
    label.textContent = `Слово № ${position + 1}`;
    label.dataset.position = String(position);
    label.textContent = localize(label.textContent, locale);
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
  run(async (assertCurrent) => {
    if (!pending || profile) throw new Error("Создание кошелька прервано");
    const words = pending.phrase.split(" ");
    for (const position of [3, 11, 19]) {
      if (form.elements[`word${position}`].value.trim().toLowerCase() !== words[position]) {
        throw new Error(`Проверьте слово № ${position + 1}`);
      }
    }
    await saveProfile({ vault: pending.record, accountCount: 1, selectedIndex: 0 });
    assertCurrent();
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
  run(async (assertCurrent) => {
    const password = credentials(form);
    const record = await encryptPhrase(form.elements.phrase.value, password);
    assertCurrent();
    if (profile && profile.vault.address !== record.address) {
      throw new Error("Это фраза другого кошелька. Существующий кошелёк не заменён.");
    }
    const restoredPhrase = await decryptPhrase(record, password);
    assertCurrent();
    phrase = restoredPhrase;
    // A phrase reproduces all first 16 addresses, but the old device's
    // accountCount is not part of the phrase. Expose them all on clean restore
    // so an existing secondary address cannot appear to be lost.
    const nextAccountCount = profile?.accountCount ?? 16;
    const nextSelectedIndex = profile?.selectedIndex ?? 0;
    await saveProfile({ vault: record, accountCount: nextAccountCount,
      selectedIndex: nextSelectedIndex });
    assertCurrent();
    accountCount = nextAccountCount;
    selectedIndex = nextSelectedIndex;
    form.reset();
    await renderHome();
  });
});

$("#unlock-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  run(async (assertCurrent) => {
    if (!profile) throw new Error("На устройстве нет кошелька");
    const unlockedPhrase = await decryptPhrase(profile.vault, form.elements.password.value);
    assertCurrent();
    phrase = unlockedPhrase;
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
  const nextAccountCount = accountCount + 1;
  const nextSelectedIndex = nextAccountCount - 1;
  await saveProfile({ ...profile, accountCount: nextAccountCount,
    selectedIndex: nextSelectedIndex });
  accountCount = nextAccountCount;
  selectedIndex = nextSelectedIndex;
  await renderHome();
}));
$("#copy-address").addEventListener("click", () => run(async () => copy((await currentAccount()).address, "Адрес")));
$("#receive").addEventListener("click", () => screen("receive-view"));
$("#copy-full-address").addEventListener("click", () => run(async () => copy((await currentAccount()).address, "Адрес")));
$("#nav-home").addEventListener("click", () => screen("home"));
$("#nav-settings").addEventListener("click", () => screen("settings"));
$("#show-phrase-form").addEventListener("click", () => screen("reveal"));
$("#lock-wallet").addEventListener("click", expireSession);

$("#reveal-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  run(async (assertCurrent) => {
    const revealedPhrase = await decryptPhrase(profile.vault, form.elements.password.value);
    assertCurrent();
    revealed = revealedPhrase;
    form.reset();
    phraseGrid($("#reveal-grid"), revealed);
    $("#reveal-result").hidden = false;
    status("Не показывайте эти слова никому.", true);
  });
});
$("#copy-revealed").addEventListener("click", () => run(async () => {
  if (!revealed) throw new Error("Сначала введите пароль");
  await copy(revealed, "Фраза");
}));

if (extensionApi.storage.local.setAccessLevel) {
  await extensionApi.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}
const settings = await extensionApi.storage.local.get([STORE_KEY, LOCALE_KEY]);
locale = settings[LOCALE_KEY] === "en" ? "en" : "ru";
refreshLocale();
for (const language of ["ru", "en"]) {
  $(`#locale-${language}`).addEventListener("click", async () => {
    locale = language;
    refreshLocale();
    try { await writeLocale(language); }
    catch { if (locale === language) status("Не удалось сохранить язык интерфейса"); }
  });
}
const stored = settings[STORE_KEY];
if (stored !== undefined) {
  if (!stored || typeof stored !== "object" || !stored.vault ||
      !Number.isInteger(stored.accountCount) || stored.accountCount < 1 || stored.accountCount > 16 ||
      !Number.isInteger(stored.selectedIndex) || stored.selectedIndex < 0 ||
      stored.selectedIndex >= stored.accountCount) {
    screen("unlock");
    status("Данные кошелька повреждены. Обратитесь за помощью, не удаляйте расширение.");
  } else {
    profile = stored;
    screen("unlock");
  }
} else screen("welcome");

const sessionGuard = createSessionGuard({ idleMs: 5 * 60_000, onLock: expireSession });
for (const name of ["pointerdown", "keydown"]) {
  window.addEventListener(name, (event) => {
    if (event.isTrusted && !sessionGuard.activity()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}
window.addEventListener("blur", () => sessionGuard.background());
window.addEventListener("focus", () => sessionGuard.resume());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) sessionGuard.background();
  else sessionGuard.resume();
});

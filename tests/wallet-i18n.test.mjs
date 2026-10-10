import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { translateWalletText, WALLET_LANGUAGES } from "../wallet-ui/i18n.js";

const html = readFileSync(new URL("../wallet-ui/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../wallet-ui/app.js", import.meta.url), "utf8");
const native = readFileSync(new URL("../macos/wallet-onboarding.m", import.meta.url), "utf8");
const launcher = readFileSync(new URL("../macos/wallet-launcher.m", import.meta.url), "utf8");

test("RU/EN selector and all static wallet copy have translations", () => {
  assert.deepEqual(WALLET_LANGUAGES, ["ru", "en"]);
  assert.match(html, /<select id="language" aria-label="Язык \/ Language">/);
  for (const [, raw] of html.matchAll(/>([^<>]+)</g)) {
    const copy = raw.trim();
    if (!/[А-Яа-яЁё]/.test(copy) || copy === "Русский" || copy === "Язык / Language" ||
        copy.startsWith("npm run ")) continue;
    assert.notEqual(translateWalletText(copy, "en"), copy, `Untranslated static copy: ${copy}`);
  }
});

test("locale never rewrites values, addresses, proof IDs or unknown errors", () => {
  for (const id of ["balance-value", "transaction-list", "contacts-list",
    "verified-request-note", "offline-signed-summary", "receive-address"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*data-i18n-ignore`));
  }
  for (const value of ["5.00000000", "—", `nir1${"a".repeat(64)}`, "abcdef012345", "error: invalid proof"]) {
    assert.equal(translateWalletText(value, "en"), value);
  }
  assert.equal(translateWalletText("Баланс не подтверждён · узлы недоступны", "en"),
    "Balance not verified · nodes unavailable");
  assert.equal(translateWalletText("Кворум подтвердил баланс · блок 123", "en"),
    "Quorum verified balance · block 123");
  assert.equal(translateWalletText("7 переводов", "en"), "7 transfers");
  assert.equal(translateWalletText("1.50000000 NIR · блок 123", "en"),
    "1.50000000 NIR · block 123");
  assert.match(app, /row\.dataset\.i18nIgnore = "";/);
  assert.doesNotMatch(html, /id="asset-list"[^>]*data-i18n-ignore/);
});

test("critical dynamic wallet copy is English and native warnings are translated", () => {
  for (const [, value] of app.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
    if (/[А-Яа-яЁё]/.test(value)) {
      assert.notEqual(translateWalletText(value, "en"), value,
        `Untranslated literal in app.js: ${value}`);
    }
  }
  for (const value of [
    "Кворум подтвердил баланс · блок 7",
    "Баланс не подтверждён · узлы недоступны",
    "Доказательства устарели · проверено на блоке 7, текущий блок 8",
    "3 операций доказаны заголовками финализированных блоков. 2 неподтверждённых ответов скрыто.",
    "Сеть: nir-test",
    "Сеть не подтверждена; транзакция не отправлена.",
    "Пароль и приватный ключ не вводятся в этой странице. Закрытие приложения удаляет session token из памяти окна.",
  ]) assert.doesNotMatch(translateWalletText(value, "en"), /[А-Яа-яЁё]/);
  assert.match(native, /NIRTranslate\(recovery \?\s*@"Для этого адреса нужны И код/);
  assert.match(native, /NIRTranslate\(@"Копия остаётся на том же диске"\)/);
  assert.match(native, /NIRSetEnglish\(self\.languageMenu\.indexOfSelectedItem == 1\)/);
  assert.match(launcher, /NIRTrustedLanguageMessage\(message\.name, message\.frameInfo\.isMainFrame/);
  assert.match(launcher, /localStorage\.setItem\('nir-language'/);
});

test("switching language while verified then offline cannot restore stale balance", () => {
  const source = app.slice(app.indexOf("const languageControl ="), app.indexOf("const localApp ="));
  const textNode = (text, skip = false) => ({ data: text, parentElement: { closest: () => skip } });
  const balance = textNode("5.00000000", true);
  const state = textNode("Кворум подтвердил баланс · блок 7");
  const network = textNode("● 2/3 · h7");
  const untrustedMemo = textNode("Получить", true);
  const untrustedAssetName = textNode("Баланс", true);
  const nodes = [balance, state, network, untrustedMemo, untrustedAssetName];
  const control = { value: "ru", addEventListener(_type, handler) { this.onchange = handler; } };
  const storage = new Map();
  const document = {
    documentElement: { lang: "ru" },
    body: {
      querySelectorAll: () => [],
    },
    querySelector: (selector) => selector === "#language" ? control : null,
    createTreeWalker: () => ({ currentNode: null, index: -1, nextNode() {
      this.index += 1;
      this.currentNode = nodes[this.index];
      return Boolean(this.currentNode);
    } }),
  };
  const context = {
    document, NodeFilter: { SHOW_TEXT: 4 }, WeakMap, translateWalletText,
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    MutationObserver: class { observe() {} },
  };
  runInNewContext(`${source}\nglobalThis.setLanguageForTest = setLanguage; globalThis.localizeForTest = localizeDocument;`, context);
  context.setLanguageForTest("en");
  assert.equal(state.data, "Quorum verified balance · block 7");
  assert.equal(balance.data, "5.00000000");
  assert.equal(network.data, "● 2/3 · h7");
  assert.equal(untrustedMemo.data, "Получить");
  assert.equal(untrustedAssetName.data, "Баланс");
  assert.equal(storage.get("nir-language"), "en");

  // The data path clears its own number before reporting an offline state.
  balance.data = "—";
  state.data = "Баланс не подтверждён · узлы недоступны";
  network.data = "○ Узлы недоступны";
  context.localizeForTest();
  assert.equal(balance.data, "—");
  assert.equal(state.data, "Balance not verified · nodes unavailable");
  assert.equal(network.data, "○ Nodes unavailable");
  assert.equal(untrustedMemo.data, "Получить");

  context.setLanguageForTest("ru");
  assert.equal(balance.data, "—");
  assert.equal(state.data, "Баланс не подтверждён · узлы недоступны");
  assert.equal(network.data, "○ Узлы недоступны");
  assert.equal(untrustedAssetName.data, "Баланс");
  assert.equal(storage.get("nir-language"), "ru");
});

test("verified simulation keeps verifier risk and role bytes exact across RU to EN", () => {
  const source = app.slice(app.indexOf("function renderSimulation("), app.indexOf("async function simulateIntent("));
  class Element {
    constructor(tagName) { this.tagName = tagName; this.dataset = {}; this.children = []; this.textContent = ""; }
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    querySelector(selector) { return selector === ".simulation-fields" ? this.fields : this.risks; }
  }
  const root = new Element("section");
  root.fields = new Element("dl"); root.risks = new Element("ul");
  const context = {
    document: { querySelector: () => root, createElement: (tag) => new Element(tag) },
    BigInt, formatAtomic: () => "0",
  };
  runInNewContext(`${source}\nglobalThis.renderSimulationForTest = renderSimulation;`, context);
  context.renderSimulationForTest("#simulation", {
    type: "transfer", networkId: "nir-test", stateHeight: 7,
    authority: [{ role: "Получить", address: "nir1test" }],
    fee: { amount: "0", payer: "ресурс сети" },
    balance: [{ role: "Получить", address: "nir1test", delta: "1" }],
    resources: [{ role: "Баланс", details: "Получить" }],
    assets: [], nonces: [{ role: "Получить", address: "nir1test", before: 0, after: 1 }],
    risks: ["Получить"],
  });
  const rows = root.fields.children;
  assert.equal(rows[2].children[1].textContent, "Получить: nir1test");
  assert.equal(rows[2].children[1].dataset.i18nIgnore, "");
  for (const row of rows) {
    assert.equal(row.children[1].dataset.i18nIgnore, "");
    for (const child of row.children) {
      if (child.dataset.i18nIgnore === "") continue;
      child.textContent = translateWalletText(child.textContent, "en");
    }
  }
  assert.equal(rows[2].children[1].textContent, "Получить: nir1test");
  assert.equal(rows[4].children[0].textContent, "Баланс: Получить");
  assert.equal(rows[4].children[0].dataset.i18nIgnore, "");
  assert.equal(rows[5].children[1].textContent, "Получить");
  assert.equal(root.risks.children[0].textContent, "Получить");
  assert.equal(root.risks.children[0].dataset.i18nIgnore, "");
  assert.equal(rows[0].children[0].textContent, "Operation");
});

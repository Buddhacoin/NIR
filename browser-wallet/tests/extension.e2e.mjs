import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { staticTranslationTargets } from "../src/i18n.js";

const extension = resolve(import.meta.dirname, "../dist");

test("Chromium extension creates, locks, unlocks and restores a phrase wallet without pairing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-browser-wallet-test-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(directory, {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15000 });
    const workerUrl = new URL(worker.url());
    const extensionOrigin = `${workerUrl.protocol}//${workerUrl.host}`;
    let onboarding;
    for (let attempt = 0; attempt < 100; attempt++) {
      onboarding = context.pages().find((candidate) => candidate.url() === `${extensionOrigin}/wallet.html`);
      if (onboarding) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(onboarding, "installation should open the wallet onboarding screen");
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.goto(`${extensionOrigin}/wallet.html`);
    for (const target of staticTranslationTargets) {
      assert.ok(await page.locator(target.split("@")[0]).count(), `missing translation target: ${target}`);
    }
    assert.equal(await page.locator("body").evaluate((element) => element.getBoundingClientRect().width), 390);
    assert.ok(await page.locator("header").evaluate((element) => element.scrollWidth <= element.clientWidth),
      "language switch and test badge must fit the 390px portrait header");
    await page.getByRole("button", { name: "English" }).click();
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    assert.equal(await page.locator(".notice").textContent(), "Local test version · no real funds");
    await page.getByRole("button", { name: "Create wallet" }).click();
    assert.equal(await page.locator("#create h1").textContent(), "Create a password");
    await page.locator("#create-form [name=password]").fill("aaaaaaaaaaaa");
    await page.locator("#create-form [name=confirmation]").fill("aaaaaaaaaaaa");
    await page.locator("#create-form button[type=submit]").click();
    assert.equal(await page.locator("#status").textContent(),
      "Password: at least 12 characters, including 4 distinct ones");
    await page.locator("#create-form [name=password]").fill("keep my unfinished password");
    await page.getByRole("button", { name: "Русский" }).click();
    assert.equal(await page.locator("#create-form [name=password]").inputValue(),
      "keep my unfinished password", "locale change must not reset a pending form");
    await page.locator("#create [data-back=welcome]").click();
    await page.getByRole("button", { name: "Создать кошелёк" }).click();
    await page.locator("#create-form [name=password]").fill("correct horse battery staple");
    await page.locator("#create-form [name=confirmation]").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Продолжить" }).click();
    await page.locator("#backup").waitFor({ state: "visible" });
    const words = await page.locator("#phrase-grid span").allTextContents();
    assert.equal(words.length, 24);
    await page.getByRole("button", { name: "English" }).click();
    assert.deepEqual(await page.locator("#phrase-grid span").allTextContents(), words,
      "changing locale must not replace or persist the recovery phrase");
    assert.equal(await page.locator("#backup .warning").textContent(),
      "If you switch windows or are inactive for 5 minutes, the phrase disappears. You will need to start again.");
    await page.getByRole("button", { name: "I saved the words" }).click();
    assert.equal(await page.locator("#confirm-fields label").first().textContent(), "Word #4");
    await page.getByRole("button", { name: "Русский" }).click();
    for (const position of [3, 11, 19]) {
      await page.locator(`#confirm-fields [name=word${position}]`).fill(words[position].replace(/^\d+\./, ""));
    }
    await page.getByRole("button", { name: "Создать кошелёк" }).click();
    await page.locator("#home").waitFor({ state: "visible" });
    if (process.env.NIR_BROWSER_WALLET_SCREENSHOT) {
      await page.setViewportSize({ width: 390, height: 640 });
      await page.screenshot({ path: process.env.NIR_BROWSER_WALLET_SCREENSHOT });
    }
    const stored = await page.evaluate(() => chrome.storage.local.get("nirTestWallet"));
    assert.equal(JSON.stringify(stored).includes(words.map((word) => word.replace(/^\d+\./, "")).join(" ")), false);
    const firstAddress = await page.locator("#full-address").textContent();
    assert.match(firstAddress, /^nir1[0-9a-f]{64}$/);
    await page.getByRole("button", { name: "Выбрать адрес" }).click();
    await page.evaluate(() => {
      window.__originalStorageSet = chrome.storage.local.set;
      chrome.storage.local.set = () => Promise.reject(new Error("simulated storage failure"));
    });
    await page.getByRole("button", { name: "+ Добавить адрес" }).click();
    await page.waitForFunction(() => document.querySelector("#status")?.textContent.length > 0);
    assert.equal((await page.evaluate(() => chrome.storage.local.get("nirTestWallet"))).nirTestWallet.accountCount, 1);
    await page.evaluate(() => { chrome.storage.local.set = window.__originalStorageSet; });
    await page.getByRole("button", { name: "+ Добавить адрес" }).click();
    await page.locator("#home").waitFor({ state: "visible" });
    assert.equal(await page.locator("#account-label").textContent(), "Адрес 2");
    const secondAddress = await page.locator("#full-address").textContent();
    assert.notEqual(secondAddress, firstAddress);
    const profileBeforeLocale = (await page.evaluate(() => chrome.storage.local.get("nirTestWallet"))).nirTestWallet;
    await page.getByRole("button", { name: "English" }).click();
    assert.equal(await page.locator("#account-label").textContent(), "Address 2");
    assert.deepEqual((await page.evaluate(() => chrome.storage.local.get("nirTestWallet"))).nirTestWallet,
      profileBeforeLocale, "changing language must not modify the encrypted wallet profile");
    await page.getByRole("button", { name: "Русский" }).click();
    await page.getByRole("button", { name: "Настройки" }).click();
    await page.getByRole("button", { name: "Показать фразу" }).click();
    await page.locator("#reveal-form [name=password]").fill("wrong password 123");
    await page.locator("#reveal-form button[type=submit]").click();
    assert.equal(await page.locator("#reveal-result").isVisible(), false);
    await page.getByRole("button", { name: "English" }).click();
    assert.match(await page.locator("#status").textContent(), /Wrong password or damaged wallet data/);
    await page.locator("#reveal-form [name=password]").fill("correct horse battery staple");
    await page.locator("#reveal-form button[type=submit]").click();
    await page.locator("#reveal-result").waitFor({ state: "visible" });
    assert.deepEqual(await page.locator("#reveal-grid span").allTextContents(), words);
    await page.getByRole("button", { name: "Русский" }).click();
    await page.locator("#reveal [data-back=settings]").click();
    await page.getByRole("button", { name: "Заблокировать кошелёк" }).click();
    await page.locator("#unlock").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "English" }).click();
    assert.deepEqual(Object.keys(await page.evaluate(() => chrome.storage.local.get(null))).sort(),
      ["nirTestWallet", "nirWalletLocale"], "language setting must remain separate from encrypted profile");
    await page.reload();
    await page.locator("#unlock").waitFor({ state: "visible" });
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    assert.equal(await page.locator("#unlock h1").textContent(), "Welcome back!");
    await page.locator("#unlock-form [name=password]").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.locator("#home").waitFor({ state: "visible" });
    assert.equal(await page.locator("#account-label").textContent(), "Address 2");
    await page.evaluate(() => chrome.storage.local.remove("nirTestWallet"));
    await page.reload();
    await page.locator("#welcome").waitFor({ state: "visible" });
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    await page.getByRole("button", { name: "I have a recovery phrase" }).click();
    await page.locator("#restore-form [name=phrase]").fill("not a valid recovery phrase");
    await page.locator("#restore-form [name=password]").fill("a new device password 123");
    await page.locator("#restore-form [name=confirmation]").fill("a new device password 123");
    await page.getByRole("button", { name: "Restore" }).click();
    assert.equal(await page.locator("#status").textContent(), "Enter 24 valid English recovery words");
    await page.locator("#restore-form [name=phrase]").fill(words.map((word) => word.replace(/^\d+\./, "")).join(" "));
    await page.locator("#restore-form [name=password]").fill("a new device password 123");
    await page.locator("#restore-form [name=confirmation]").fill("a new device password 123");
    await page.evaluate(() => {
      window.__originalStorageSet = chrome.storage.local.set;
      chrome.storage.local.set = () => Promise.reject(new Error("simulated restore storage failure"));
    });
    await page.getByRole("button", { name: "Restore" }).click();
    await page.waitForFunction(() => document.querySelector("#status")?.textContent !==
      "Enter 24 valid English recovery words");
    assert.equal(await page.locator("#restore").isVisible(), true);
    assert.equal((await page.evaluate(() => chrome.storage.local.get("nirTestWallet"))).nirTestWallet, undefined);
    await page.evaluate(() => { chrome.storage.local.set = window.__originalStorageSet; });
    await page.getByRole("button", { name: "Restore" }).click();
    await page.locator("#home").waitFor({ state: "visible" });
    assert.equal(await page.locator("#full-address").textContent(), firstAddress);
    await page.getByRole("button", { name: "Select address" }).click();
    await page.waitForFunction(() => document.querySelectorAll("#account-list button").length === 16);
    assert.equal(await page.locator("#account-list button").count(), 16);
    await page.locator("#account-list button").nth(1).click();
    await page.waitForFunction((expected) => document.querySelector("#full-address")?.textContent === expected,
      secondAddress);
    assert.equal(await page.locator("#full-address").textContent(), secondAddress);
    await page.getByRole("button", { name: "Русский" }).click();
    assert.equal(await page.locator("#account-label").textContent(), "Адрес 2");
    assert.deepEqual(failures, []);
  } finally {
    await context?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

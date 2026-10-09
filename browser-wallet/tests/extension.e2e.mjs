import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

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
    await page.getByRole("button", { name: "Создать кошелёк" }).click();
    await page.locator("#create-form [name=password]").fill("correct horse battery staple");
    await page.locator("#create-form [name=confirmation]").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Продолжить" }).click();
    await page.locator("#backup").waitFor({ state: "visible" });
    const words = await page.locator("#phrase-grid span").allTextContents();
    assert.equal(words.length, 24);
    await page.getByRole("button", { name: "Я сохранил слова" }).click();
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
    await page.getByRole("button", { name: "+ Добавить адрес" }).click();
    await page.locator("#home").waitFor({ state: "visible" });
    assert.equal(await page.locator("#account-label").textContent(), "Адрес 2");
    assert.notEqual(await page.locator("#full-address").textContent(), firstAddress);
    await page.getByRole("button", { name: "Настройки" }).click();
    await page.getByRole("button", { name: "Показать фразу" }).click();
    await page.locator("#reveal-form [name=password]").fill("wrong password 123");
    await page.locator("#reveal-form button[type=submit]").click();
    assert.equal(await page.locator("#reveal-result").isVisible(), false);
    await page.locator("#reveal-form [name=password]").fill("correct horse battery staple");
    await page.locator("#reveal-form button[type=submit]").click();
    await page.locator("#reveal-result").waitFor({ state: "visible" });
    await page.locator("#reveal [data-back=settings]").click();
    await page.getByRole("button", { name: "Заблокировать кошелёк" }).click();
    await page.locator("#unlock").waitFor({ state: "visible" });
    await page.reload();
    await page.locator("#unlock").waitFor({ state: "visible" });
    await page.locator("#unlock-form [name=password]").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Разблокировать" }).click();
    await page.locator("#home").waitFor({ state: "visible" });
    assert.equal(await page.locator("#account-label").textContent(), "Адрес 2");
    await page.evaluate(() => chrome.storage.local.remove("nirTestWallet"));
    await page.reload();
    await page.locator("#welcome").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "У меня есть фраза восстановления" }).click();
    await page.locator("#restore-form [name=phrase]").fill(words.map((word) => word.replace(/^\d+\./, "")).join(" "));
    await page.locator("#restore-form [name=password]").fill("a new device password 123");
    await page.locator("#restore-form [name=confirmation]").fill("a new device password 123");
    await page.getByRole("button", { name: "Восстановить" }).click();
    await page.locator("#home").waitFor({ state: "visible" });
    assert.equal(await page.locator("#full-address").textContent(), firstAddress);
    assert.deepEqual(failures, []);
  } finally {
    await context?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

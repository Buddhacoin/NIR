import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { chromium, firefox, webkit } from "playwright";

const root = resolve(import.meta.dirname, "../dist-web");
const allowed = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/nir-icon.png", ["nir-icon.png", "image/png"]],
]);

const browserTypes = [chromium, webkit, ...(process.env.NIR_TEST_FIREFOX ? [firefox] : [])];
for (const browserType of browserTypes) test(`${browserType.name()} web preview creates, locks, unlocks and restores local test addresses`, async () => {
  const server = createServer((request, response) => {
    const asset = allowed.get(new URL(request.url, "http://localhost").pathname);
    if (!asset) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store" });
    response.end(readFileSync(resolve(root, asset[0])));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await browserType.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    const externalRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (!request.url().startsWith(`${origin}/`)) externalRequests.push(request.url());
    });
    await page.goto(origin);
    await page.locator("#welcome").waitFor({ state: "visible" });
    assert.match(await page.locator(".notice").textContent(), /без реальных средств/);
    await page.getByRole("button", { name: "Создать кошелёк" }).click();
    await page.locator("#create-form [name=password]").fill("correct horse battery staple");
    await page.locator("#create-form [name=confirmation]").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Продолжить" }).click();
    await page.locator("#backup").waitFor({ state: "visible" });
    const words = (await page.locator("#phrase-grid span").allTextContents())
      .map((word) => word.replace(/^\d+\./, ""));
    assert.equal(words.length, 24);
    await page.getByRole("button", { name: "Я сохранил слова" }).click();
    for (const position of [3, 11, 19]) {
      await page.locator(`#confirm-fields [name=word${position}]`).fill(words[position]);
    }
    await page.getByRole("button", { name: "Создать кошелёк" }).click();
    await page.locator("#home").waitFor({ state: "visible" });
    const address = await page.locator("#full-address").textContent();
    assert.match(address, /^nir1[0-9a-f]{64}$/);
    const persisted = await page.evaluate(() => localStorage.getItem("nirTestWalletWeb"));
    assert.equal(persisted.includes(words.join(" ")), false);
    await page.reload();
    await page.locator("#unlock").waitFor({ state: "visible" });
    await page.locator("#unlock-form [name=password]").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Разблокировать" }).click();
    await page.locator("#home").waitFor({ state: "visible" });
    assert.equal(await page.locator("#full-address").textContent(), address);
    await page.evaluate(() => localStorage.removeItem("nirTestWalletWeb"));
    await page.reload();
    await page.locator("#welcome").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "У меня есть фраза восстановления" }).click();
    await page.locator("#restore-form [name=phrase]").fill(words.join(" "));
    await page.locator("#restore-form [name=password]").fill("another device password 123");
    await page.locator("#restore-form [name=confirmation]").fill("another device password 123");
    await page.getByRole("button", { name: "Восстановить" }).click();
    await page.locator("#home").waitFor({ state: "visible" });
    assert.equal(await page.locator("#full-address").textContent(), address);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
  } finally {
    await browser?.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { chromium } from "playwright";

const output = process.argv[2];
if (!output || !isAbsolute(output)) throw new Error("Provide an absolute output PNG path");

const profile = mkdtempSync(join(tmpdir(), "nir-store-screenshot-"));
const extension = resolve(import.meta.dirname, "../dist");
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15000 });
  const workerUrl = new URL(worker.url());
  const origin = `${workerUrl.protocol}//${workerUrl.host}`;
  const page = context.pages().find((candidate) => candidate.url() === `${origin}/wallet.html`) ?? await context.newPage();
  await page.goto(`${origin}/wallet.html`);
  await page.locator("#welcome").waitFor({ state: "visible" });
  await page.screenshot({ path: output });
} finally {
  await context?.close();
  rmSync(profile, { recursive: true, force: true });
}

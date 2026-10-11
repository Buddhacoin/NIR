import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import test from "node:test";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UI_ROOT = new URL("../wallet-ui/", import.meta.url).pathname;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function closeChrome(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function contentType(path) {
  return ({ ".css": "text/css", ".html": "text/html", ".js": "text/javascript",
    ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json" })[
    extname(path)] ?? "application/octet-stream";
}

async function chromeDebugPort(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Chrome DevTools endpoint did not start")), 10_000);
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      const matched = /DevTools listening on ws:\/\/127\.0\.0\.1:([0-9]+)\//.exec(output);
      if (matched) {
        clearTimeout(timeout);
        resolve(Number(matched[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before DevTools startup: ${code}`));
    });
  });
}

async function pageSocket(port, expectedUrl) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find(({ type, url }) => type === "page" && url === expectedUrl);
      if (page) return new WebSocket(page.webSocketDebuggerUrl);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Chrome page target was not available");
}

function cdp(socket) {
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  };
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { reject, resolve });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", {
    awaitPromise: true, expression, returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

test("real Chromium enforces wallet CSP, inert rendering and frame refusal", {
  skip: !existsSync(CHROME), timeout: 30_000,
}, async () => {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://wallet.local").pathname;
    if (pathname === "/frame.html") {
      const body = `<iframe id="wallet-frame" src="/index.html"></iframe>`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
      return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const path = normalize(join(UI_ROOT, relative));
    if (!path.startsWith(UI_ROOT)) {
      response.writeHead(404); response.end(); return;
    }
    try {
      const body = readFileSync(path);
      response.writeHead(200, { "cache-control": "no-store", "content-type": contentType(path) });
      response.end(body);
    } catch {
      response.writeHead(404); response.end();
    }
  });
  const profile = mkdtempSync(join(tmpdir(), "nir-wallet-browser-test-"));
  let chrome;
  let socket;
  try {
    await listen(server);
    const origin = `http://127.0.0.1:${server.address().port}`;
    chrome = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--remote-debugging-port=0", `--user-data-dir=${profile}`, `${origin}/index.html`,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const port = await chromeDebugPort(chrome);
    socket = await pageSocket(port, `${origin}/index.html`);
    if (socket.readyState !== WebSocket.OPEN) {
      await new Promise((resolve, reject) => {
        socket.onopen = resolve; socket.onerror = reject;
      });
    }
    const send = cdp(socket);
    await send("Runtime.enable");
    await send("Page.enable");
    // Chrome can expose the target URL before its first document commits.
    // The transient about:blank page is also "complete"; wait for our origin.
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        const loaded = await evaluate(send,
          `location.origin === ${JSON.stringify(origin)} && document.readyState === "complete"`);
        if (loaded) break;
      } catch { /* Navigation can replace the current execution context. */ }
      if (Date.now() >= deadline) throw new Error("Chromium wallet document did not load");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const direct = await evaluate(send, `({
      balancePresent: Boolean(document.querySelector("#balance-value")),
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? "",
      secretKeys: Object.keys(localStorage).filter(key => /token|password|private|seed/i.test(key)),
    })`);
    assert.equal(direct.balancePresent, true);
    assert.match(direct.csp, /script-src 'self'/);
    assert.deepEqual(direct.secretKeys, []);

    const inlineExecuted = await evaluate(send, `(async () => {
      globalThis.__nirInlineXss = false;
      const script = document.createElement("script");
      script.textContent = "globalThis.__nirInlineXss = true";
      document.body.append(script);
      await new Promise(resolve => setTimeout(resolve, 50));
      return globalThis.__nirInlineXss;
    })()`);
    assert.equal(inlineExecuted, false);

    const inert = await evaluate(send, `(async () => {
      const { normalizeContact } = await import("/address-book.js");
      const contact = normalizeContact({
        address: "nir1${"a".repeat(64)}", label: "<img src=x onerror=globalThis.__nirDomXss=true>",
        networkId: "nir-browser-test",
      }, 1);
      globalThis.__nirDomXss = false;
      const label = document.createElement("b"); label.textContent = contact.label; document.body.append(label);
      await new Promise(resolve => setTimeout(resolve, 25));
      return { executed: globalThis.__nirDomXss, images: label.querySelectorAll("img").length,
        text: label.textContent };
    })()`);
    assert.equal(inert.executed, false);
    assert.equal(inert.images, 0);
    assert.match(inert.text, /<img/);

    await send("Page.navigate", { url: `${origin}/?local-demo=1&local-app=1` });
    const macDeadline = Date.now() + 5_000;
    while (true) {
      try {
        const rendered = await evaluate(send,
          `location.search === "?local-demo=1&local-app=1" && document.querySelector('[data-action="mine"]')?.textContent.includes("О майнинге")`);
        if (rendered) break;
      } catch { /* Navigation can replace the execution context. */ }
      if (Date.now() >= macDeadline) throw new Error("Chromium local Mac mode did not render");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const macCopy = await evaluate(send, `(() => {
      document.querySelector('[data-action="mine"]').click();
      return {
        onboardingSteps: document.querySelector("#onboarding ol").children.length,
        onboardingHidden: getComputedStyle(document.querySelector("#onboarding")).display,
        nativeError: document.querySelector("#native-connection-error").textContent,
        nativeErrorHidden: document.querySelector("#native-connection-error").hidden,
        bootstrapPresent: Object.hasOwn(window, "__nirNativeBootstrap"),
        setupHidden: getComputedStyle(document.querySelector("#setup-panel .setup-steps")).display,
        title: document.querySelector("#onboarding-title").textContent,
        connect: document.querySelector('#onboarding [data-action="connect"]').textContent,
        balance: document.querySelector("#balance-value").textContent,
        balanceStatus: document.querySelector("#wallet-state").textContent,
        nodes: document.querySelector(".network").textContent,
        bridge: document.querySelector("#bridge-panel > p").textContent,
        mining: document.querySelector("#panel-copy").textContent,
      };
    })()`);
    assert.equal(macCopy.onboardingSteps, 0);
    assert.equal(macCopy.onboardingHidden, "none");
    assert.equal(macCopy.nativeErrorHidden, false);
    assert.match(macCopy.nativeError, /откройте NIR Wallet снова/);
    assert.equal(macCopy.bootstrapPresent, false);
    assert.equal(macCopy.setupHidden, "none");
    assert.equal(macCopy.title, "Подключите защищённый файл кошелька");
    assert.equal(macCopy.connect, "Подключить кошелёк");
    assert.equal(macCopy.balance, "—");
    assert.doesNotMatch(macCopy.balanceStatus, /Кворум подтвердил баланс/);
    assert.doesNotMatch(macCopy.nodes, /Nodes|Local testnet/);
    assert.match(macCopy.bridge, /автоматически/);
    assert.match(macCopy.mining, /не начисляет NIR/);
    const settingsPage = await evaluate(send, `(() => {
      document.querySelector('[data-nav="settings"]').click();
      const page = document.querySelector('#settings-panel');
      const pageRect = page.getBoundingClientRect();
      const shellRect = document.querySelector('.shell').getBoundingClientRect();
      return { open: page.open, modal: page.matches(':modal'),
        homeHidden: document.querySelector('#home-page')?.hidden ?? false,
        backdrop: getComputedStyle(page, '::backdrop').backgroundColor,
        inFlow: getComputedStyle(page).position === 'static' &&
          pageRect.left >= shellRect.left && pageRect.right <= shellRect.right,
        headingFocused: document.activeElement === page.querySelector('h2') };
    })()`);
    assert.deepEqual(settingsPage, { open: true, modal: false, homeHidden: true,
      backdrop: "rgba(0, 0, 0, 0)", inFlow: true, headingFocused: true });
    const pageNavigation = await evaluate(send, `(async () => {
      document.querySelector('#settings-setup').click();
      const setup = document.querySelector('#setup-panel');
      const openedSetup = setup.open && !setup.hidden && !setup.matches(':modal') &&
        document.querySelector('#settings-panel').hidden;
      setup.querySelector('.close').click();
      await new Promise(resolve => setTimeout(resolve, 50));
      const backToSettings = !document.querySelector('#settings-panel').hidden &&
        document.querySelector('#settings-panel').open && !setup.open;
      document.querySelector('[data-nav="home"]').click();
      const home = !document.querySelector('#home-page').hidden &&
        !document.querySelector('#settings-panel').open;
      document.querySelector('[data-nav="history"]').click();
      const history = document.querySelector('#home-page').dataset.view === 'history' &&
        getComputedStyle(document.querySelector('.balance')).display === 'none' &&
        document.querySelector('#history .title h2').textContent === 'История операций';
      document.querySelector('[data-nav="mine"]').click();
      const mine = document.querySelector('#panel').open && !document.querySelector('#panel').matches(':modal') &&
        document.querySelector('#home-page').hidden;
      document.querySelector('[data-nav="home"]').click();
      document.querySelector('[data-action="receive"]').click();
      const connect = !document.querySelector('#bridge-panel').open &&
        document.querySelector('#wallet-state').textContent.includes('закройте и откройте NIR Wallet снова');
      document.querySelector('[data-nav="settings"]').click();
      document.querySelector('[data-nav="home"]').click();
      document.querySelector('[data-nav="settings"]').click();
      await new Promise(resolve => setTimeout(resolve, 50));
      const rapidReopen = document.querySelector('#settings-panel').open &&
        !document.querySelector('#settings-panel').hidden && document.querySelector('#home-page').hidden;
      return { openedSetup, backToSettings, home, history, mine, connect, rapidReopen };
    })()`);
    assert.deepEqual(pageNavigation, { openedSetup: true, backToSettings: true,
      home: true, history: true, mine: true, connect: true, rapidReopen: true });

    await send("Page.navigate", { url: `${origin}/frame.html` });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const framed = await evaluate(send, `(async () => {
      const frame = document.querySelector("#wallet-frame");
      await new Promise(resolve => {
        if (frame.contentDocument?.readyState === "complete") resolve();
        else frame.addEventListener("load", resolve, { once: true });
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      return { balancePresent: Boolean(frame.contentDocument.querySelector("#balance-value")),
        text: frame.contentDocument.documentElement.textContent };
    })()`);
    assert.equal(framed.balancePresent, false);
    assert.match(framed.text, /cannot run inside a frame/);
  } finally {
    socket?.close();
    await closeChrome(chrome);
    await close(server).catch(() => {});
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { rmSync(profile, { recursive: true, force: true }); break; }
      catch (error) {
        if ((error.code !== "ENOTEMPTY" && error.code !== "EBUSY") || attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

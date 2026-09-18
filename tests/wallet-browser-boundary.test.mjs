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

async function pageSocket(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find(({ type }) => type === "page");
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
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
    socket = await pageSocket(port);
    if (socket.readyState !== WebSocket.OPEN) {
      await new Promise((resolve, reject) => {
        socket.onopen = resolve; socket.onerror = reject;
      });
    }
    const send = cdp(socket);
    await send("Runtime.enable");
    await send("Page.enable");
    await evaluate(send, `new Promise(resolve => {
      const done = () => resolve(document.readyState);
      if (document.readyState === "complete") done(); else addEventListener("load", done, { once: true });
    })`);

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
    rmSync(profile, { recursive: true, force: true });
  }
});

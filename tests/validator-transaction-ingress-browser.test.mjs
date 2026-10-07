import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTransfer, transactionId } from "../blockchain/chain.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import { initializeDistributedDevnet, ValidatorReplica } from "../blockchain/distributed-node.mjs";
import { certificateSha256 } from "../blockchain/http-client.mjs";
import { createValidatorTransactionIngressServer, WALLET_EXTENSION_ORIGIN }
  from "../blockchain/validator-transaction-ingress.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
function chromeForTesting() {
  if (process.env.NIR_CHROME_FOR_TESTING) return process.env.NIR_CHROME_FOR_TESTING;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return null;
  for (const name of readdirSync(cache).filter((value) => value.startsWith("chromium-")).sort().reverse()) {
    const binary = join(cache, name, "chrome-mac-arm64/Google Chrome for Testing.app",
      "Contents/MacOS/Google Chrome for Testing");
    if (existsSync(binary)) return binary;
  }
  return null;
}
const EXTENSION_CHROME = chromeForTesting();
const WALLET_CSP = readFileSync(new URL("../wallet-ui/index.html", import.meta.url), "utf8")
  .match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server?.listening) return;
  const done = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await done;
}

async function closeChrome(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

async function chromeDebugPort(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Chrome DevTools endpoint did not start")), 10_000);
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      const matched = /DevTools listening on ws:\/\/127\.0\.0\.1:([0-9]+)\//.exec(output);
      if (matched) { clearTimeout(timeout); resolve(Number(matched[1])); }
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

async function browserSocket(port) {
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return new WebSocket(info.webSocketDebuggerUrl);
}

async function openSocket(socket) {
  if (socket.readyState !== WebSocket.OPEN) {
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  }
  return cdp(socket);
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
  const result = await send("Runtime.evaluate", { awaitPromise: true, expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function waitPageOrigin(send, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (await evaluate(send, "document.readyState === 'complete' ? location.origin : null") === expected) {
        return;
      }
    } catch { /* The prior execution context may be disappearing during navigation. */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Chrome did not navigate to ${expected}`);
}

test("Chromium preflights only the configured wallet origin before queued validator ingress", {
  skip: !existsSync(CHROME), timeout: 30_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-browser-ingress-"));
  const profile = mkdtempSync(join(tmpdir(), "nir-browser-ingress-profile-"));
  const servers = [];
  let chrome; let socket;
  try {
    const keyPath = join(root, "key.pem"); const certPath = join(root, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"],
    { stdio: "ignore" });
    const cert = readFileSync(certPath); const key = readFileSync(keyPath);
    const pin = certificateSha256(new X509Certificate(cert).raw);
    const layout = initializeDistributedDevnet(join(root, "network"), { tlsCertificateSha256: pin });
    const replicas = layout.validatorDirectories.slice(0, 2)
      .map((directory) => new ValidatorReplica(directory));
    const peerUrls = Array(4).fill("https://127.0.0.1:1");
    for (let index = 0; index < replicas.length; index += 1) {
      const server = createValidatorHttpServer(replicas[index], {
        tls: { cert, key }, peerUrls: () => peerUrls,
      });
      servers.push(server);
      const base = await listen(server);
      peerUrls[index] = base.replace("http:", "https:");
    }
    const page = "<!doctype html><meta charset=utf-8><title>Local wallet origin</title>";
    const pageServer = () => createHttpServer((request, response) => {
      response.writeHead(200, { "content-security-policy": WALLET_CSP,
        "content-type": "text/html; charset=utf-8" });
      response.end(page);
    });
    const walletServer = pageServer(); servers.push(walletServer);
    const walletOrigin = await listen(walletServer);
    const foreignServer = pageServer(); servers.push(foreignServer);
    const foreignOrigin = await listen(foreignServer);
    const ingress = createValidatorTransactionIngressServer({
      expectedNetworkId: replicas[0].networkId, tlsCertificateSha256: pin,
      upstreamOrigin: peerUrls[0], walletOrigin,
    });
    const requests = [];
    ingress.on("request", (request) => requests.push({ method: request.method,
      origin: request.headers.origin, path: request.url }));
    servers.push(ingress);
    const ingressOrigin = await listen(ingress);
    const wallet = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "TREASURY-DEV-KEY.json")));
    const signed = createTransfer({ wallet, networkId: replicas[0].networkId,
      recipient: generateWallet().address, amount: "1000000", nonce: 0 });
    chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run",
      "--no-default-browser-check", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, `${walletOrigin}/index.html`],
    { stdio: ["ignore", "ignore", "pipe"] });
    const port = await chromeDebugPort(chrome);
    socket = await pageSocket(port, `${walletOrigin}/index.html`);
    if (socket.readyState !== WebSocket.OPEN) {
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    }
    const send = cdp(socket);
    await send("Runtime.enable"); await send("Page.enable");
    await waitPageOrigin(send, walletOrigin);
    const expression = `(async () => {
      const response = await fetch(${JSON.stringify(`${ingressOrigin}/v1/transactions`)}, {
        method: "POST", headers: { "content-type": "application/json" },
        body: ${JSON.stringify(JSON.stringify(signed))},
      });
      return { status: response.status, body: await response.json() };
    })()`;
    const accepted = await evaluate(send, expression);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.status, "queued");
    assert.equal(accepted.body.transactionId, transactionId(signed));
    assert.deepEqual(requests.map(({ method, origin, path }) => [method, origin, path]), [
      ["OPTIONS", walletOrigin, "/v1/transactions"],
      ["POST", walletOrigin, "/v1/transactions"],
    ]);
    assert.deepEqual(replicas.map((replica) => replica.mempoolSize), [1, 1]);
    assert.deepEqual(replicas.map((replica) => replica.height), [0, 0]);

    await send("Page.navigate", { url: `${foreignOrigin}/index.html` });
    await waitPageOrigin(send, foreignOrigin);
    const blocked = await evaluate(send, `(async () => {
      try { await fetch(${JSON.stringify(`${ingressOrigin}/v1/transactions`)}, {
        method: "POST", headers: { "content-type": "application/json" },
        body: ${JSON.stringify(JSON.stringify(signed))},
      }); return false; }
      catch (error) { return error.name === "TypeError"; }
    })()`);
    assert.equal(blocked, true);
    assert.deepEqual(requests.slice(2).map(({ method, origin }) => [method, origin]),
      [["OPTIONS", foreignOrigin]]);
    assert.deepEqual(replicas.map((replica) => replica.mempoolSize), [1, 1]);
    assert.deepEqual(replicas.map((replica) => replica.height), [0, 0]);
  } finally {
    socket?.close();
    await closeChrome(chrome);
    await Promise.all(servers.map(close));
    rmSync(profile, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("unpacked pinned extension submits directly while a foreign browser origin cannot forward", {
  skip: !EXTENSION_CHROME || !existsSync(EXTENSION_CHROME), timeout: 40_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-extension-ingress-"));
  const profile = mkdtempSync(join(tmpdir(), "nir-extension-ingress-profile-"));
  const servers = [];
  let chrome; let socket; let browser;
  try {
    const keyPath = join(root, "key.pem"); const certPath = join(root, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"],
    { stdio: "ignore" });
    const cert = readFileSync(certPath); const key = readFileSync(keyPath);
    const pin = certificateSha256(new X509Certificate(cert).raw);
    const layout = initializeDistributedDevnet(join(root, "network"), { tlsCertificateSha256: pin });
    const replicas = layout.validatorDirectories.slice(0, 2)
      .map((directory) => new ValidatorReplica(directory));
    const peerUrls = Array(4).fill("https://127.0.0.1:1");
    for (let index = 0; index < replicas.length; index += 1) {
      const server = createValidatorHttpServer(replicas[index], {
        tls: { cert, key }, peerUrls: () => peerUrls,
      });
      servers.push(server);
      peerUrls[index] = (await listen(server)).replace("http:", "https:");
    }
    const foreignServer = createHttpServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><meta charset=utf-8><title>Foreign page</title>");
    });
    servers.push(foreignServer);
    const foreignOrigin = await listen(foreignServer);
    const ingress = createValidatorTransactionIngressServer({
      expectedNetworkId: replicas[0].networkId, tlsCertificateSha256: pin,
      upstreamOrigin: peerUrls[0], walletOrigin: WALLET_EXTENSION_ORIGIN,
    });
    const requests = [];
    ingress.on("request", (request) => requests.push({ method: request.method,
      origin: request.headers.origin, path: request.url,
      requestedMethod: request.headers["access-control-request-method"],
      requestedHeaders: request.headers["access-control-request-headers"] }));
    servers.push(ingress);
    const ingressOrigin = await listen(ingress);
    const wallet = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "TREASURY-DEV-KEY.json")));
    const signed = createTransfer({ wallet, networkId: replicas[0].networkId,
      recipient: generateWallet().address, amount: "1000000", nonce: 0 });
    const extensionPage = `${WALLET_EXTENSION_ORIGIN}/index.html`;
    const walletUi = fileURLToPath(new URL("../wallet-ui/", import.meta.url));
    chrome = spawn(EXTENSION_CHROME, ["--headless=new", "--disable-gpu", "--no-first-run",
      "--no-default-browser-check", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, `--disable-extensions-except=${walletUi}`,
      `--load-extension=${walletUi}`, extensionPage],
    { stdio: ["ignore", "ignore", "pipe"] });
    const port = await chromeDebugPort(chrome);
    browser = await browserSocket(port);
    const browserSend = await openSocket(browser);
    socket = await pageSocket(port, extensionPage);
    const send = await openSocket(socket);
    await send("Runtime.enable"); await send("Page.enable");
    await waitPageOrigin(send, WALLET_EXTENSION_ORIGIN);
    const request = `window.__nirIngressResult = "pending";
      fetch(${JSON.stringify(`${ingressOrigin}/v1/transactions`)}, {
        method: "POST", headers: { "content-type": "application/json" },
        body: ${JSON.stringify(JSON.stringify(signed))},
      }).then(async (response) => { window.__nirIngressResult =
        { status: response.status, body: await response.json() }; })
        .catch((error) => { window.__nirIngressResult = { error: error.toString() }; });
      window.__nirIngressResult`;
    assert.equal(await evaluate(send, request), "pending");
    // Headless Chrome cannot answer the runtime local-network permission prompt.
    for (const name of ["local-network", "loopback-network"]) {
      await browserSend("Browser.setPermission", {
        origin: WALLET_EXTENSION_ORIGIN, embeddedOrigin: ingressOrigin,
        permission: { name }, setting: "granted",
      });
    }
    let accepted = "pending";
    for (let attempt = 0; attempt < 100 && accepted === "pending"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      accepted = await evaluate(send, "window.__nirIngressResult");
    }
    assert.equal(accepted.status, 202);
    assert.deepEqual(Object.keys(accepted.body).sort(),
      ["gossipedPeers", "status", "transactionId"]);
    assert.equal(accepted.body.status, "queued");
    assert.equal(accepted.body.transactionId, transactionId(signed));
    assert.ok(Number.isSafeInteger(accepted.body.gossipedPeers));
    assert.ok(accepted.body.gossipedPeers >= 1);
    assert.deepEqual(requests, [{ method: "POST", origin: WALLET_EXTENSION_ORIGIN,
      path: "/v1/transactions", requestedMethod: undefined, requestedHeaders: undefined }]);
    assert.deepEqual(replicas.map((replica) => replica.mempoolSize), [1, 1]);
    assert.deepEqual(replicas.map((replica) => replica.height), [0, 0]);

    await send("Page.navigate", { url: `${foreignOrigin}/index.html` });
    await waitPageOrigin(send, foreignOrigin);
    const blocked = await evaluate(send, `(async () => {
      try { await fetch(${JSON.stringify(`${ingressOrigin}/v1/transactions`)}, {
        method: "POST", headers: { "content-type": "application/json" },
        body: ${JSON.stringify(JSON.stringify(signed))},
      }); return false; }
      catch (error) { return error.name === "TypeError"; }
    })()`);
    assert.equal(blocked, true);
    assert.deepEqual(requests.slice(1).map(({ method, origin }) => [method, origin]),
      [["OPTIONS", foreignOrigin]]);
    assert.deepEqual(replicas.map((replica) => replica.mempoolSize), [1, 1]);
  } finally {
    socket?.close(); browser?.close();
    await closeChrome(chrome);
    await Promise.all(servers.map(close));
    rmSync(profile, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

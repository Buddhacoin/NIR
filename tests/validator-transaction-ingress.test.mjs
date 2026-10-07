import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTransfer, transactionId } from "../blockchain/chain.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import { initializeDistributedDevnet, ValidatorReplica } from "../blockchain/distributed-node.mjs";
import { certificateSha256 } from "../blockchain/http-client.mjs";
import { createValidatorTransactionIngressServer, validateValidatorTransactionIngressConfig,
  WALLET_EXTENSION_ORIGIN }
  from "../blockchain/validator-transaction-ingress.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";

test("checkpoint certificate gate blocks transaction forwarding and rejects asynchronous bypass", async () => {
  const tls = fixture(); const servers = [];
  try {
    let reached = 0;
    const upstream = createHttpsServer({ cert: tls.cert, key: tls.key }, (request, response) => {
      reached += 1; request.resume(); response.writeHead(500); response.end("upstream reached");
    });
    servers.push(upstream);
    const upstreamOrigin = `https://127.0.0.1:${await listen(upstream)}`;
    let gate = () => { throw new Error("stale witness evidence"); };
    const ingress = createValidatorTransactionIngressServer({
      expectedNetworkId: "nir-distributed-devnet", tlsCertificateSha256: tls.pin,
      upstreamOrigin,
    }, { checkpointCertificateGate: () => gate() });
    servers.push(ingress);
    const endpoint = `http://127.0.0.1:${await listen(ingress)}/v1/transactions`;
    const signed = createTransfer({ wallet: generateWallet(),
      networkId: "nir-distributed-devnet", recipient: generateWallet().address,
      amount: "1000000", nonce: 0 });
    const submit = () => fetch(endpoint, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
    assert.equal((await submit()).status, 503);
    assert.equal(reached, 0);
    gate = () => Promise.resolve({ checkpointHeight: 10 });
    assert.equal((await submit()).status, 503);
    assert.equal(reached, 0);
    gate = () => ({ checkpointHeight: 10 });
    assert.equal((await submit()).status, 502);
    assert.equal(reached, 1);
  } finally {
    await Promise.all(servers.map(close));
    rmSync(tls.directory, { recursive: true, force: true });
  }
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function close(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "nir-transaction-ingress-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"],
  { stdio: "ignore" });
  const cert = readFileSync(certPath);
  return {
    directory, cert, key: readFileSync(keyPath),
    pin: certificateSha256(new X509Certificate(cert).raw),
  };
}

test("loopback transaction ingress queues a signed transfer on two real validators without finality", async () => {
  const tls = fixture();
  const servers = [];
  try {
    const layout = initializeDistributedDevnet(join(tls.directory, "network"), {
      tlsCertificateSha256: tls.pin,
    });
    const replicas = layout.validatorDirectories.slice(0, 2)
      .map((directory) => new ValidatorReplica(directory));
    const peerUrls = ["https://127.0.0.1:1", "https://127.0.0.1:1",
      "https://127.0.0.1:1", "https://127.0.0.1:1"];
    for (let index = 0; index < replicas.length; index += 1) {
      const server = createValidatorHttpServer(replicas[index], {
        tls: { cert: tls.cert, key: tls.key }, peerUrls: () => peerUrls,
      });
      servers.push(server);
      peerUrls[index] = `https://127.0.0.1:${await listen(server)}`;
    }
    const ingress = createValidatorTransactionIngressServer({
      expectedNetworkId: replicas[0].networkId, tlsCertificateSha256: tls.pin,
      upstreamOrigin: peerUrls[0], walletOrigin: "http://127.0.0.1:8765",
    });
    servers.push(ingress);
    const base = `http://127.0.0.1:${await listen(ingress)}`;
    const preflight = await fetch(`${base}/v1/transactions`, {
      method: "OPTIONS", headers: { origin: "http://127.0.0.1:8765",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:8765");
    assert.equal(preflight.headers.get("access-control-allow-methods"), "POST");
    assert.equal(preflight.headers.get("access-control-allow-headers"), "content-type");
    assert.deepEqual(replicas.map((replica) => replica.mempoolSize), [0, 0]);
    const wallet = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "TREASURY-DEV-KEY.json")));
    const signed = createTransfer({ wallet, networkId: replicas[0].networkId,
      recipient: generateWallet().address, amount: "1000000", nonce: 0 });
    const submit = async (payload) => fetch(`${base}/v1/transactions`, {
      method: "POST", headers: { origin: "http://127.0.0.1:8765",
        "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const first = await submit(signed);
    assert.equal(first.status, 202);
    assert.equal(first.headers.get("access-control-allow-origin"), "http://127.0.0.1:8765");
    const receipt = await first.json();
    assert.equal(receipt.status, "queued");
    assert.equal(receipt.transactionId, transactionId(signed));
    assert.ok(receipt.gossipedPeers >= 1);
    assert.deepEqual(replicas.map((replica) => replica.mempoolSize), [1, 1]);
    assert.deepEqual(replicas.map((replica) => replica.height), [0, 0]);

    const duplicate = await submit(signed);
    assert.equal(duplicate.status, 202);
    assert.equal((await duplicate.json()).status, "known");
    const invalid = await submit({ ...signed, signature: "tampered" });
    assert.equal(invalid.status, 400);
    const wrongNetwork = await submit({ ...signed, networkId: "foreign-devnet" });
    assert.equal(wrongNetwork.status, 400);
    assert.deepEqual(replicas.map((replica) => replica.mempoolSize), [1, 1]);
    const admin = await fetch(`${base}/v1/blocks/produce`, { method: "POST" });
    assert.equal(admin.status, 404);
    assert.deepEqual(replicas.map((replica) => replica.height), [0, 0]);
  } finally {
    await Promise.all(servers.map(close));
    rmSync(tls.directory, { recursive: true, force: true });
  }
});

test("ingress rejects every non-exact route and method before reaching its upstream", async () => {
  const tls = fixture();
  const servers = [];
  try {
    let reached = 0;
    const upstream = createHttpsServer({ cert: tls.cert, key: tls.key }, (request, response) => {
      reached += 1;
      request.resume();
      response.writeHead(500); response.end("unexpected upstream request");
    });
    servers.push(upstream);
    const upstreamOrigin = `https://127.0.0.1:${await listen(upstream)}`;
    const ingress = createValidatorTransactionIngressServer({
      expectedNetworkId: "nir-distributed-devnet", tlsCertificateSha256: tls.pin,
      upstreamOrigin, walletOrigin: "http://127.0.0.1:8765",
    });
    servers.push(ingress);
    const base = `http://127.0.0.1:${await listen(ingress)}`;
    for (const [method, path] of [["POST", "/v1/blocks/produce"], ["POST", "/v1/sync"],
      ["POST", "/v1/gossip/transactions"], ["GET", "/v1/transactions"],
      ["POST", "/v1/transactions?admin=1"],
      ["POST", "/v1//transactions"], ["POST", "/V1/transactions"]]) {
      const response = await fetch(`${base}${path}`, { method });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
    assert.equal(reached, 0);
    for (const [path, method, headers] of [
      ["/v1/blocks/produce", "POST", { origin: "http://127.0.0.1:8765" }],
      ["/v1/sync", "OPTIONS", { origin: "http://127.0.0.1:8765",
        "access-control-request-method": "POST", "access-control-request-headers": "content-type" }],
      ["/v1/transactions", "OPTIONS", { origin: "http://127.0.0.1:8765",
        "access-control-request-method": "DELETE", "access-control-request-headers": "content-type" }],
      ["/v1/transactions", "OPTIONS", { origin: "http://127.0.0.1:8765",
        "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-admin" }],
      ["/v1/transactions", "OPTIONS", { origin: "http://evil.invalid",
        "access-control-request-method": "POST", "access-control-request-headers": "content-type" }],
    ]) {
      const response = await fetch(`${base}${path}`, { method, headers });
      assert.ok([403, 404].includes(response.status), `${method} ${path}`);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    assert.equal(reached, 0);
    const origin = await fetch(`${base}/v1/transactions`, {
      method: "POST", headers: { origin: "https://example.invalid", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(origin.status, 403);
    assert.equal(reached, 0);
    const tooLarge = await fetch(`${base}/v1/transactions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ networkId: "nir-distributed-devnet", data: "x".repeat(65_536) }),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(reached, 0);
    const wrongPin = createValidatorTransactionIngressServer({
      expectedNetworkId: "nir-distributed-devnet", tlsCertificateSha256: "0".repeat(64),
      upstreamOrigin,
    });
    servers.push(wrongPin);
    const wrongPinBase = `http://127.0.0.1:${await listen(wrongPin)}`;
    const pinned = await fetch(`${wrongPinBase}/v1/transactions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ networkId: "nir-distributed-devnet" }),
    });
    assert.equal(pinned.status, 502);
    assert.equal(reached, 0, "TLS mismatch must be rejected before sending an upstream HTTP request");
  } finally {
    await Promise.all(servers.map(close));
    rmSync(tls.directory, { recursive: true, force: true });
  }
});

test("ingress strips extra upstream fields and rejects an upstream height claim", async () => {
  const tls = fixture();
  const servers = [];
  try {
    const transaction = { networkId: "nir-distributed-devnet" };
    const id = transactionId(transaction);
    let includeHeight = false;
    const upstream = createHttpsServer({ cert: tls.cert, key: tls.key }, (request, response) => {
      request.resume();
      request.on("end", () => {
        const body = JSON.stringify({
          status: "queued", transactionId: id, gossipedPeers: 1,
          receipt: { untrusted: true }, inclusionCertificate: { untrusted: true },
          futureField: "must-not-leak", ...(includeHeight ? { height: 7 } : {}),
        });
        response.writeHead(202, { "content-type": "application/json" });
        response.end(body);
      });
    });
    servers.push(upstream);
    const upstreamOrigin = `https://127.0.0.1:${await listen(upstream)}`;
    const ingress = createValidatorTransactionIngressServer({
      expectedNetworkId: transaction.networkId, tlsCertificateSha256: tls.pin,
      upstreamOrigin,
    });
    servers.push(ingress);
    const base = `http://127.0.0.1:${await listen(ingress)}`;
    const submit = () => fetch(`${base}/v1/transactions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(transaction),
    });
    const accepted = await submit();
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), {
      status: "queued", transactionId: id, gossipedPeers: 1,
    });
    includeHeight = true;
    const rejected = await submit();
    assert.equal(rejected.status, 502);
    assert.deepEqual(await rejected.json(), { error: "validator ingress response is invalid" });
  } finally {
    await Promise.all(servers.map(close));
    rmSync(tls.directory, { recursive: true, force: true });
  }
});

test("only the pinned extension origin can forward a direct JSON POST", async () => {
  const tls = fixture();
  const servers = [];
  try {
    const transaction = { networkId: "nir-distributed-devnet" };
    let forwarded = 0;
    const upstream = createHttpsServer({ cert: tls.cert, key: tls.key }, (request, response) => {
      forwarded += 1;
      request.resume();
      request.on("end", () => {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "queued", transactionId: transactionId(transaction),
          gossipedPeers: 0 }));
      });
    });
    servers.push(upstream);
    const upstreamOrigin = `https://127.0.0.1:${await listen(upstream)}`;
    const ingress = createValidatorTransactionIngressServer({
      expectedNetworkId: transaction.networkId, tlsCertificateSha256: tls.pin,
      upstreamOrigin, walletOrigin: WALLET_EXTENSION_ORIGIN,
    });
    servers.push(ingress);
    const base = `http://127.0.0.1:${await listen(ingress)}`;
    const accepted = await fetch(`${base}/v1/transactions`, {
      method: "POST", headers: { origin: WALLET_EXTENSION_ORIGIN,
        "content-type": "application/json" }, body: JSON.stringify(transaction),
    });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.headers.get("access-control-allow-origin"), WALLET_EXTENSION_ORIGIN);
    assert.equal((await accepted.json()).transactionId, transactionId(transaction));
    assert.equal(forwarded, 1);
    for (const origin of ["https://evil.invalid", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "http://127.0.0.1:8765"]) {
      const denied = await fetch(`${base}/v1/transactions`, {
        method: "POST", headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(transaction),
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get("access-control-allow-origin"), null);
      assert.equal(forwarded, 1);
    }
  } finally {
    await Promise.all(servers.map(close));
    rmSync(tls.directory, { recursive: true, force: true });
  }
});

test("ingress upstream must be an exact pinned loopback HTTPS origin", () => {
  const base = { expectedNetworkId: "nir-distributed-devnet",
    tlsCertificateSha256: "a".repeat(64), upstreamOrigin: "https://127.0.0.1:8443" };
  assert.deepEqual(validateValidatorTransactionIngressConfig(base), { ...base, walletOrigin: null });
  assert.equal(validateValidatorTransactionIngressConfig({ ...base,
    walletOrigin: "http://127.0.0.1:8765" }).walletOrigin, "http://127.0.0.1:8765");
  assert.equal(validateValidatorTransactionIngressConfig({ ...base,
    walletOrigin: WALLET_EXTENSION_ORIGIN }).walletOrigin, WALLET_EXTENSION_ORIGIN);
  for (const walletOrigin of ["http://localhost:8765", "https://127.0.0.1:8765",
    "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:8765/path",
    "http://evil.invalid:8765", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    `${WALLET_EXTENSION_ORIGIN}/`, `${WALLET_EXTENSION_ORIGIN}/path`,
    "chrome-extension://*", "chrome-extension://ojfgigpdjamebbiiihianbcjpabgdhnn"]) {
    assert.throws(() => validateValidatorTransactionIngressConfig({ ...base, walletOrigin }),
      /exact local wallet or pinned extension origin/);
  }
  for (const upstreamOrigin of ["http://127.0.0.1:8443", "https://example.com:8443",
    "https://localhost:8443", "https://127.0.0.1:8443/v1/transactions",
    "https://127.0.0.1:8443?x=1", "https://user@127.0.0.1:8443"] ) {
    assert.throws(() => validateValidatorTransactionIngressConfig({ ...base, upstreamOrigin }),
      /loopback HTTPS upstream origin/);
  }
});

test("transaction ingress CLI refuses public listener addresses", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../blockchain/validator-transaction-ingress-cli.mjs", import.meta.url)),
    "https://127.0.0.1:8443", "a".repeat(64), "nir-distributed-devnet", "8789", "0.0.0.0",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /explicit loopback host/);
});

test("ceremony-bound CLI rejects a missing external anchor before port or upstream POST", async () => {
  const tls = fixture();
  const upstream = createHttpsServer({ cert: tls.cert, key: tls.key }, (request, response) => {
    posts += Number(request.method === "POST");
    request.resume(); response.writeHead(500); response.end();
  });
  let posts = 0;
  try {
    const upstreamPort = await listen(upstream);
    const probe = createTcpServer();
    const port = await new Promise((resolve) => probe.listen(0, "127.0.0.1",
      () => resolve(probe.address().port)));
    await close(probe);
    const cli = fileURLToPath(new URL("../blockchain/validator-transaction-ingress-cli.mjs",
      import.meta.url));
    const child = spawn(process.execPath, [cli, "--ceremony", join(tls.directory, "registry"),
      join(tls.directory, "missing-anchor.json"), `nir1${"a".repeat(64)}`,
      "a".repeat(64), `nir1${"b".repeat(64)}`,
      `https://127.0.0.1:${upstreamPort}`, tls.pin, "nir-test-devnet", String(port)],
    { stdio: "ignore" });
    const status = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(status, 1);
    assert.equal(posts, 0);
    const available = createTcpServer();
    await new Promise((resolve) => available.listen(port, "127.0.0.1", resolve));
    await close(available);
  } finally {
    await close(upstream);
    rmSync(tls.directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initializeDistributedDevnet, ValidatorReplica } from "../blockchain/distributed-node.mjs";
import { HttpIngressGuard } from "../blockchain/http-ingress.mjs";
import { createNodeHttpServer } from "../blockchain/node-service.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createValidatorAdmissionProofResponseAuth,
  verifyValidatorAdmissionProofResponseAuth }
  from "../blockchain/validator-admission-proof-auth.mjs";
import { requestJson } from "../blockchain/http-client.mjs";

function nodeFixture(overrides = {}) {
  return {
    height: 0,
    networkId: "nir-http-ingress-test",
    tipHash: "0".repeat(64),
    account: () => ({}),
    feeQuote: () => ({}),
    submitTransaction: async () => ({ accepted: true }),
    faucet: async () => ({ accepted: true }),
    ...overrides,
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  await server.gracefulShutdown(200);
}

function rawRequest(url, { body = "", headers = {}, method = "POST", path = "/v1/transactions" } = {}) {
  const target = new URL(path, url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(target, { headers, method }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        status: response.statusCode,
      }));
    });
    request.on("error", reject);
    if (body.length > 0) request.write(body);
    request.end();
  });
}

test("node ingress rejects oversized declarations and compressed/deep JSON before dispatch", async () => {
  let submitted = 0;
  const server = createNodeHttpServer(nodeFixture({
    submitTransaction: async () => { submitted += 1; return { accepted: true }; },
  }), { httpIngress: { maxBodyBytes: 1_024 } });
  const url = await listen(server);
  try {
    const oversized = await rawRequest(url, {
      body: "x".repeat(1_025),
      headers: { "content-length": "1025", "content-type": "application/json" },
    });
    assert.equal(oversized.status, 413);
    assert.match(oversized.body.error, /too large/);

    const compressed = await rawRequest(url, {
      body: "{}",
      headers: { "content-encoding": "gzip", "content-length": "2" },
    });
    assert.equal(compressed.status, 415);

    const deep = `${"[".repeat(66)}0${"]".repeat(66)}`;
    const nested = await rawRequest(url, {
      body: deep, headers: { "content-length": String(Buffer.byteLength(deep)) },
    });
    assert.equal(nested.status, 400);
    assert.equal(submitted, 0);

    const metrics = await fetch(`${url}/metrics`).then((response) => response.json());
    assert.equal(metrics.httpIngress.bodyTooLarge, 1);
    assert.equal(metrics.httpIngress.encodingRejected, 1);
    assert.ok(metrics.httpIngress.malformed >= 1);
    assert.equal(metrics.httpIngress.active, 1);
    assert.equal(Object.hasOwn(metrics.httpIngress, "addresses"), false);
  } finally {
    await close(server);
  }
});

test("wide JSON is rejected by node count without an unbounded spread", async () => {
  let submitted = 0;
  const server = createNodeHttpServer(nodeFixture({
    submitTransaction: async () => { submitted += 1; return { accepted: true }; },
  }), { httpIngress: { maxBodyBytes: 32 * 1024, maxJsonNodes: 100 } });
  const url = await listen(server);
  try {
    for (const body of [
      JSON.stringify(Array.from({ length: 200 }, (_, index) => index)),
      JSON.stringify(Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`k${index}`, index]))),
    ]) {
      const response = await rawRequest(url, {
        body, headers: { "content-length": String(Buffer.byteLength(body)) },
      });
      assert.equal(response.status, 400);
      assert.match(response.body.error, /shape/);
    }
    assert.equal(submitted, 0);
  } finally {
    await close(server);
  }
});

test("invalid or rewound admission clocks fail closed", () => {
  let now = Number.NaN;
  const guard = new HttpIngressGuard({ clock: () => now });
  const request = { socket: { remoteAddress: "127.0.0.1" }, url: "/health" };
  assert.throws(() => guard.begin(request), /admission is unavailable/);
  now = 10;
  guard.begin(request)();
  now = 9;
  assert.throws(() => guard.begin(request), /admission is unavailable/);
});

test("HTTP client abort signal destroys an in-flight request", async () => {
  const server = createHttpServer((_request, response) => {
    setTimeout(() => { if (!response.destroyed) response.end("{}"); }, 500).unref();
  });
  const url = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  try {
    const controller = new AbortController();
    const pending = requestJson(url, { signal: controller.signal, timeoutMs: 1_000 });
    controller.abort();
    await assert.rejects(() => pending, /aborted/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("slow request body expires without occupying ingress indefinitely", async () => {
  const server = createNodeHttpServer(nodeFixture(), {
    httpIngress: { bodyIdleTimeoutMs: 30, requestTimeoutMs: 500 },
  });
  await listen(server);
  try {
    const response = await new Promise((resolve, reject) => {
      const socket = connect(server.address().port, "127.0.0.1");
      let received = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(
        "POST /v1/transactions HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{",
      ));
      socket.on("data", (chunk) => {
        received += chunk;
        if (received.includes("request body timed out")) {
          socket.destroy(); resolve(received);
        }
      });
      socket.on("error", reject);
      socket.setTimeout(1_000, () => { socket.destroy(); reject(new Error("slow-body response timed out")); });
    });
    assert.match(response, /HTTP\/1\.1 408/);
    const metrics = await fetch(`http://127.0.0.1:${server.address().port}/metrics`)
      .then((value) => value.json());
    assert.equal(metrics.httpIngress.bodyTimeout, 1);
    assert.equal(metrics.httpIngress.active, 1);
  } finally {
    await close(server);
  }
});

test("validator P2P ingress rejects unauthenticated oversized bodies before crypto scheduling", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-http-validator-ingress-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const validator = new ValidatorReplica(layout.validatorDirectories[0]);
  let authenticationRuns = 0;
  const authenticationScheduler = {
    metrics: () => ({ active: 0, queued: 0 }),
    run: async (_identity, operation) => { authenticationRuns += 1; return operation(); },
  };
  const server = createValidatorHttpServer(validator, {
    authenticationScheduler,
    httpIngress: { maxBodyBytes: 512 },
  });
  const url = await listen(server);
  try {
    const response = await rawRequest(url, {
      body: "x".repeat(513),
      headers: { "content-length": "513" },
      path: "/v1/p2p/health",
    });
    assert.equal(response.status, 413);
    assert.equal(authenticationRuns, 0);
    const metrics = await fetch(`${url}/metrics`).then((value) => value.json());
    assert.equal(metrics.httpIngress.bodyTooLarge, 1);
    assert.equal(JSON.stringify(metrics).includes(validator.address), false);
  } finally {
    await close(server);
    validator.closeSecurityState();
    rmSync(temporary, { force: true, recursive: true });
  }
});

test("validator exposes one consensus-authenticated atomic admission proof bundle", async () => {
  const wallet = generateWallet(); const transactionId = "a".repeat(64);
  const bundle = { finalityProofs: [], format: "nir-validator-admission-proof-bundle-v1",
    handoffs: [], inclusion: {}, version: 1 };
  const result = { bundle, format: "nir-validator-admission-proof-source-result-v1",
    status: "found", version: 1 };
  const validator = { address: wallet.address, certificateMode: "test", height: 4,
    mempoolSize: 0, networkId: "nir-proof-service-test", pendingProtocolUpgrade: null,
    protocolVersion: 32, tipHash: "b".repeat(64),
    async validatorAdmissionProofBundle(request) {
      assert.deepEqual(request, { chainIdentityGenesisHash: "d".repeat(64),
        checkpointHash: "e".repeat(64), fromHeight: 3, transactionId }); return result;
    },
    authenticateValidatorAdmissionProofResponse(clientNonce, request, value) {
      return createValidatorAdmissionProofResponseAuth({ clientNonce,
        networkId: this.networkId, request, result: value, wallet });
    } };
  const server = createValidatorHttpServer(validator); const url = await listen(server);
  try {
    const clientNonce = "c".repeat(64); const path =
      `/v1/public/validator-admission-finality?chainIdentityGenesisHash=${"d".repeat(64)}&checkpointHash=${"e".repeat(64)}&clientNonce=${clientNonce}&fromHeight=3&transactionId=${transactionId}`;
    const response = await rawRequest(url, { method: "GET", path });
    assert.equal(response.status, 200);
    assert.deepEqual(verifyValidatorAdmissionProofResponseAuth(response.body.auth, {
      clientNonce, networkId: validator.networkId, request: {
        chainIdentityGenesisHash: "d".repeat(64), checkpointHash: "e".repeat(64),
        fromHeight: 3, transactionId },
      result: response.body.result, validator: publicWallet(wallet),
    }), result);
    const duplicate = await rawRequest(url, { method: "GET", path: `${path}&fromHeight=3` });
    assert.equal(duplicate.status, 400);
  } finally { await close(server); }
});

test("per-address admission drops duplicate unauthenticated floods before expensive dispatch", async () => {
  let submitted = 0;
  const server = createNodeHttpServer(nodeFixture({
    submitTransaction: async () => { submitted += 1; return { accepted: true }; },
  }), { httpIngress: { burst: 1, requestsPerMinute: 1 } });
  const url = await listen(server);
  try {
    const body = '{"nonce":1}';
    const first = await rawRequest(url, {
      body, headers: { "content-length": String(body.length) },
    });
    const duplicate = await rawRequest(url, {
      body, headers: { "content-length": String(body.length) },
    });
    assert.equal(first.status, 202);
    assert.equal(duplicate.status, 429);
    assert.match(duplicate.body.error, /rate limit/);
    assert.equal(submitted, 1);
    assert.equal(server.maxConnections, 128);
    assert.equal(server.maxHeadersCount, 64);
    assert.equal(server.maxRequestsPerSocket, 100);
  } finally {
    await close(server);
  }
});

test("internal errors are redacted while graceful shutdown remains bounded", async () => {
  const server = createNodeHttpServer(nodeFixture({
    submitTransaction: async () => { throw new Error("EACCES /Users/operator/private/vault.json"); },
  }));
  const url = await listen(server);
  const body = "{}";
  const rejected = await rawRequest(url, {
    body, headers: { "content-length": String(body.length) },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, "request rejected");
  assert.doesNotMatch(JSON.stringify(rejected.body), /operator|vault|EACCES/);
  await server.gracefulShutdown(200);
  assert.equal(server.listening, false);
});

test("unexpected non-path secrets are also redacted", async () => {
  const server = createNodeHttpServer(nodeFixture({
    submitTransaction: async () => { throw new Error("database token hunter2 unavailable"); },
  }));
  const url = await listen(server);
  try {
    const body = "{}";
    const rejected = await rawRequest(url, {
      body, headers: { "content-length": String(body.length) },
    });
    assert.equal(rejected.body.error, "request rejected");
    assert.doesNotMatch(JSON.stringify(rejected.body), /hunter2|database|token/);
  } finally {
    await close(server);
  }
});

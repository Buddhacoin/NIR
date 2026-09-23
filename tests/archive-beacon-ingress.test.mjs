import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSignedHistoryArchive } from "../blockchain/archive-sync.mjs";
import { createHistoryArchiveHttpServer } from "../blockchain/archive-service.mjs";
import { createBeaconHttpServer } from "../blockchain/beacon-http-service.mjs";
import {
  createBeaconShareRequest, validateBeaconRequesterPolicy,
} from "../blockchain/beacon-request-auth.mjs";
import { openBeaconStateStore } from "../blockchain/beacon-state-store.mjs";
import { loadBlockStore } from "../blockchain/block-store.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { initializeDevnet, PersistentDevNode } from "../blockchain/node-store.mjs";
import { certificateSha256, requestJson } from "../blockchain/http-client.mjs";
import { createFallbackBeaconShare } from "../blockchain/operators.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (server.listening) await server.gracefulShutdown(300);
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function request(url, { body = "", headers = {}, method = "GET", path = "/" } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(new URL(path, url), { headers, method }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        headers: response.headers,
        status: response.statusCode,
      }));
    });
    outgoing.on("error", reject);
    if (body.length > 0) outgoing.write(body);
    outgoing.end();
  });
}

function archiveFixture() {
  const temporary = mkdtempSync(join(tmpdir(), "nir-archive-ingress-"));
  const directory = join(temporary, "node");
  initializeDevnet(directory);
  new PersistentDevNode(directory);
  const genesis = JSON.parse(readFileSync(join(directory, "genesis.json"), "utf8"));
  const { chain } = loadBlockStore(directory, genesis);
  const archive = createSignedHistoryArchive(directory, chain, generateWallet());
  return { archive, temporary };
}

function beaconFixture(options = {}) {
  const wallet = generateWallet();
  const requester = generateWallet();
  const issued = new Map();
  const nonces = new Map();
  let persists = 0;
  const server = createBeaconHttpServer({
    issued,
    networkId: "nir-beacon-ingress-test",
    nonces,
    persist: async (...arguments_) => {
      persists += 1;
      return options.persist?.(...arguments_);
    },
    requesters: new Map([[requester.address, { ...publicWallet(requester), operatorId: "requester-one" }]]),
    wallet,
  }, { ...options, persist: undefined });
  return { issued, networkId: "nir-beacon-ingress-test", nonces,
    persists: () => persists, requester, server, wallet };
}

function beaconBody(fixture, fields = {}, options = {}) {
  return JSON.stringify(createBeaconShareRequest({
    beaconAddress: fixture.wallet.address,
    candidateId: fields.candidateId ?? "a".repeat(64),
    generation: fields.generation ?? 0,
    networkId: fields.networkId ?? fixture.networkId,
    purpose: fields.purpose ?? "fallback",
    round: fields.round ?? 1,
  }, options.wallet ?? fixture.requester, options));
}

test("archive rejects request bodies and ranges and releases aborted downloads", async () => {
  const { archive, temporary } = archiveFixture();
  const server = createHistoryArchiveHttpServer(archive);
  const url = await listen(server);
  try {
    const body = "x".repeat(32);
    const withBody = await request(url, {
      body,
      headers: { "content-length": String(body.length) },
      path: "/v1/history-archive/manifest",
    });
    assert.equal(withBody.status, 413);

    const range = await request(url, {
      headers: { range: "bytes=0-15" },
      path: "/v1/history-archive/chunks/0",
    });
    assert.equal(range.status, 416);
    assert.equal(range.headers["accept-ranges"], "none");

    await new Promise((resolve, reject) => {
      const outgoing = httpRequest(new URL("/v1/history-archive/chunks/0", url), (response) => {
        response.once("data", () => { response.destroy(); resolve(); });
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.httpIngressMetrics().active, 0);
    assert.equal(server.maxConnections, 64);
    assert.equal(server.maxRequestsPerSocket, 100);
  } finally {
    await close(server);
    rmSync(temporary, { force: true, recursive: true });
  }
});

test("archive keeps a large slow download admitted until abort", async () => {
  const size = 12 * 1024 * 1024;
  const archive = {
    chunks: [{ data: "A".repeat(Math.ceil(size / 3) * 4), index: 0 }],
    manifest: {
      archiveHash: "a".repeat(64),
      chunks: [{ index: 0, sha3_256: "b".repeat(64), size }],
      height: 1,
      networkId: "nir-large-archive-test",
    },
    signature: "signed-public-archive",
    signer: { address: "nir1" + "c".repeat(64) },
  };
  const server = createHistoryArchiveHttpServer(archive);
  const url = await listen(server);
  try {
    const response = await new Promise((resolve, reject) => {
      const outgoing = httpRequest(new URL("/v1/history-archive/chunks/0", url));
      outgoing.on("response", resolve);
      outgoing.on("error", reject);
      outgoing.end();
    });
    response.pause();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(server.httpIngressMetrics().active, 1);
    response.destroy();
    await waitFor(() => server.httpIngressMetrics().active === 0);
    assert.equal(server.httpIngressMetrics().active, 0);
  } finally {
    await close(server);
  }
});

test("archive duplicate flood is bounded before repeated download dispatch", async () => {
  const { archive, temporary } = archiveFixture();
  const server = createHistoryArchiveHttpServer(archive, {
    httpIngress: { burst: 2, requestsPerMinute: 1 },
  });
  const url = await listen(server);
  try {
    assert.equal((await request(url, { path: "/v1/history-archive/manifest" })).status, 200);
    assert.equal((await request(url, { path: "/v1/history-archive/manifest" })).status, 200);
    const flooded = await request(url, { path: "/v1/history-archive/manifest" });
    assert.equal(flooded.status, 429);
    assert.equal(server.httpIngressMetrics().rateRejected, 1);
  } finally {
    await close(server);
    rmSync(temporary, { force: true, recursive: true });
  }
});

test("beacon validates exact signed shape and rejects a replayed durable nonce", async () => {
  const fixture = beaconFixture({ maxIssuedShares: 1 });
  const url = await listen(fixture.server);
  try {
    const payload = beaconBody(fixture);
    const first = await request(url, {
      body: payload,
      headers: { "content-length": String(Buffer.byteLength(payload)) },
      method: "POST",
      path: "/v1/share",
    });
    const replay = await request(url, {
      body: payload,
      headers: { "content-length": String(Buffer.byteLength(payload)) },
      method: "POST",
      path: "/v1/share",
    });
    assert.equal(first.status, 200);
    assert.equal(replay.status, 409);
    assert.equal(fixture.persists(), 1);

    const parsedExtra = JSON.parse(beaconBody(fixture, {}, { nonce: "1".repeat(64) }));
    parsedExtra.extra = true;
    const extra = JSON.stringify(parsedExtra);
    const malformed = await request(url, {
      body: extra,
      headers: { "content-length": String(Buffer.byteLength(extra)) },
      method: "POST",
      path: "/v1/share",
    });
    assert.equal(malformed.status, 400);
    assert.equal(fixture.persists(), 1);

    const second = beaconBody(fixture, { candidateId: "b".repeat(64) }, { nonce: "2".repeat(64) });
    const exhausted = await request(url, {
      body: second,
      headers: { "content-length": String(Buffer.byteLength(second)) },
      method: "POST",
      path: "/v1/share",
    });
    assert.equal(exhausted.status, 503);
    assert.equal(fixture.issued.size, 1);
    const metrics = fixture.server.httpIngressMetrics();
    assert.deepEqual(metrics.beacon, {
      capacityRejected: 1, issuedShares: 1, sharesCreated: 1, sharesReplayed: 0,
    });
    assert.deepEqual(metrics.antiReplay, {
      activeNonces: 1, generation: 0, highWater: 0, maxNonces: 100_000,
    });
    assert.equal(JSON.stringify(metrics).includes(fixture.wallet.address), false);
  } finally {
    await close(fixture.server);
  }
});

test("a rotated beacon never reuses a generationless persisted share", async () => {
  const fixture = beaconFixture();
  const candidateId = "d".repeat(64);
  fixture.issued.set(`fallback:${candidateId}:1`, createFallbackBeaconShare({
    wallet: fixture.wallet, networkId: fixture.networkId, candidateId,
    generation: 0, round: 1, value: "1".repeat(64),
  }));
  const url = await listen(fixture.server);
  try {
    const payload = beaconBody(fixture, { candidateId, generation: 1 });
    const response = await request(url, {
      body: payload,
      headers: { "content-length": String(Buffer.byteLength(payload)) },
      method: "POST",
      path: "/v1/share",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.generation, 1);
    assert.equal(fixture.issued.has(`fallback:1:${candidateId}:1`), true);
  } finally {
    await close(fixture.server);
  }
});

test("beacon rejects oversized and slow bodies before share generation", async () => {
  const oversizedFixture = beaconFixture({ httpIngress: { maxBodyBytes: 128 } });
  const oversizedUrl = await listen(oversizedFixture.server);
  try {
    const body = "x".repeat(129);
    const rejected = await request(oversizedUrl, {
      body,
      headers: { "content-length": String(body.length) },
      method: "POST",
      path: "/v1/share",
    });
    assert.equal(rejected.status, 413);
    assert.equal(oversizedFixture.persists(), 0);
  } finally {
    await close(oversizedFixture.server);
  }

  const slowFixture = beaconFixture({
    httpIngress: { bodyIdleTimeoutMs: 30, requestTimeoutMs: 500 },
  });
  await listen(slowFixture.server);
  try {
    const response = await new Promise((resolve, reject) => {
      const socket = connect(slowFixture.server.address().port, "127.0.0.1");
      let received = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(
        "POST /v1/share HTTP/1.1\r\nHost: localhost\r\nContent-Length: 80\r\n\r\n{",
      ));
      socket.on("data", (chunk) => {
        received += chunk;
        if (received.includes("request body timed out")) {
          socket.destroy(); resolve(received);
        }
      });
      socket.on("error", reject);
      socket.setTimeout(1_000, () => { socket.destroy(); reject(new Error("slow beacon request did not expire")); });
    });
    assert.match(response, /HTTP\/1\.1 408/);
    assert.equal(slowFixture.persists(), 0);
    assert.equal(slowFixture.server.httpIngressMetrics().httpIngress.bodyTimeout, 1);
  } finally {
    await close(slowFixture.server);
  }
});

test("beacon authenticated replay flood is nonce- and rate-bounded", async () => {
  const fixture = beaconFixture({ httpIngress: { burst: 2, requestsPerMinute: 1 } });
  const url = await listen(fixture.server);
  try {
    const body = beaconBody(fixture, {
      candidateId: "c".repeat(64), purpose: "progress", round: 2,
    });
    const send = () => request(url, {
      body,
      headers: { "content-length": String(Buffer.byteLength(body)) },
      method: "POST",
      path: "/v1/share",
    });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 409);
    assert.equal((await send()).status, 429);
    assert.equal(fixture.persists(), 1);
    assert.equal(fixture.server.httpIngressMetrics().httpIngress.rateRejected, 1);
  } finally {
    await close(fixture.server);
  }
});

test("beacon rejects forged, misbound, expired, future, and unauthorized envelopes before shares", async () => {
  const fixture = beaconFixture();
  const url = await listen(fixture.server);
  try {
    const outsider = generateWallet();
    const cases = [
      (() => { const value = JSON.parse(beaconBody(fixture, {}, { nonce: "3".repeat(64) }));
        value.signature = "0".repeat(value.signature.length); return JSON.stringify(value); })(),
      beaconBody(fixture, { networkId: "wrong-network" }, { nonce: "4".repeat(64) }),
      beaconBody(fixture, {}, { clock: () => Date.now() - 120_000, nonce: "5".repeat(64) }),
      beaconBody(fixture, {}, { clock: () => Date.now() + 120_000, nonce: "6".repeat(64) }),
    ];
    const unauthorized = beaconBody(fixture, {}, { nonce: "7".repeat(64), wallet: outsider });
    assert.equal((await request(url, {
      body: unauthorized, headers: { "content-length": String(Buffer.byteLength(unauthorized)) },
      method: "POST", path: "/v1/share",
    })).status, 400);
    assert.equal(fixture.server.httpIngressMetrics().authentication.started, 0);
    const wrongBeacon = createBeaconShareRequest({
      beaconAddress: generateWallet().address, candidateId: "a".repeat(64),
      networkId: fixture.networkId, purpose: "fallback", round: 1,
    }, fixture.requester, { nonce: "8".repeat(64) });
    cases.push(JSON.stringify(wrongBeacon));
    for (const body of cases) {
      const rejected = await request(url, {
        body, headers: { "content-length": String(Buffer.byteLength(body)) },
        method: "POST", path: "/v1/share",
      });
      assert.equal(rejected.status, 400);
    }
    assert.equal(fixture.persists(), 0);
    assert.equal(fixture.issued.size, 0);
  } finally { await close(fixture.server); }
});

test("requester policy rejects beacon keys and duplicated operators", () => {
  const beacon = generateWallet();
  const requester = generateWallet();
  const base = {
    beaconAddress: beacon.address,
    format: "nir-beacon-requester-policy-v1",
    networkId: "nir-policy-test",
    requesters: [{ ...publicWallet(requester), operatorId: "requester-one" }],
    reservedAddresses: [beacon.address],
    reservedOperatorIds: ["beacon-operator"],
  };
  assert.equal(validateBeaconRequesterPolicy(base, {
    beaconAddress: beacon.address, networkId: base.networkId,
  }).size, 1);
  assert.throws(() => validateBeaconRequesterPolicy({
    ...base, requesters: [{ ...publicWallet(beacon), operatorId: "requester-one" }],
  }, { beaconAddress: beacon.address, networkId: base.networkId }), /reserved/);
  assert.throws(() => validateBeaconRequesterPolicy({
    ...base, requesters: [{ ...publicWallet(requester), operatorId: "beacon-operator" }],
  }, { beaconAddress: beacon.address, networkId: base.networkId }), /reserved/);
  assert.throws(() => validateBeaconRequesterPolicy({
    ...base,
    requesters: [base.requesters[0], { ...publicWallet(generateWallet()), operatorId: "requester-one" }],
  }, { beaconAddress: beacon.address, networkId: base.networkId }), /duplicated/);
});

test("beacon optional TLS 1.3 endpoint honors certificate pin and incomplete TLS fails closed", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-beacon-tls-"));
  const keyPath = join(temporary, "key.pem");
  const certPath = join(temporary, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"],
  { stdio: "ignore" });
  const key = readFileSync(keyPath); const cert = readFileSync(certPath);
  const fingerprint = certificateSha256(new X509Certificate(cert).raw);
  const fixture = beaconFixture({ tls: { cert, key } });
  try {
    await listen(fixture.server);
    const url = `https://127.0.0.1:${fixture.server.address().port}/health`;
    assert.equal((await requestJson(url, { tlsCertificateSha256: fingerprint })).status, 200);
    await assert.rejects(() => requestJson(url, { tlsCertificateSha256: "0".repeat(64) }),
      /certificate pin mismatch/);
    assert.throws(() => beaconFixture({ tls: { cert } }), /key and certificate/);
  } finally {
    await close(fixture.server); rmSync(temporary, { force: true, recursive: true });
  }
});

test("concurrent duplicate beacon requests wait for one durable commit and share its failure", async () => {
  let rejectPersist;
  const persistence = new Promise((_resolve, reject) => { rejectPersist = reject; });
  let randomCalls = 0;
  const fixture = beaconFixture({
    persist: () => persistence,
    randomBytesImpl: () => { randomCalls += 1; return Buffer.alloc(32, 7); },
  });
  const url = await listen(fixture.server);
  try {
    const body = beaconBody(fixture, { candidateId: "d".repeat(64), round: 3 });
    const send = () => request(url, {
      body,
      headers: { "content-length": String(Buffer.byteLength(body)) },
      method: "POST",
      path: "/v1/share",
    });
    const first = send();
    const duplicate = send();
    await waitFor(() => fixture.persists() === 1);
    assert.equal(randomCalls, 1);
    assert.equal(fixture.persists(), 1);
    rejectPersist(new Error("simulated ambiguous persistence failure"));
    assert.equal((await first).status, 400);
    assert.equal((await duplicate).status, 409);
    assert.equal(fixture.issued.size, 0);
    assert.equal(randomCalls, 1);
    const poisonedBody = beaconBody(fixture, { candidateId: "d".repeat(64), round: 3 }, {
      nonce: "6".repeat(64),
    });
    const poisoned = await request(url, {
      body: poisonedBody,
      headers: { "content-length": String(Buffer.byteLength(poisonedBody)) },
      method: "POST", path: "/v1/share",
    });
    assert.equal(poisoned.status, 503);
    assert.match(poisoned.body.error, /operator recovery/);
    assert.equal(randomCalls, 1);
  } finally {
    await close(fixture.server);
  }
});

test("beacon state is append-only, restartable, private, and rejects symlinks", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-beacon-state-"));
  const vaultPath = join(temporary, "operator.nirvault.json");
  const address = "nir1" + "e".repeat(64);
  const networkId = "nir-beacon-state-test";
  let store;
  try {
    store = openBeaconStateStore({ address, networkId, vaultPath });
    store.append(`fallback:${"f".repeat(64)}:1`, { candidateId: "f".repeat(64), round: 1 });
    const path = store.path;
    assert.throws(() => openBeaconStateStore({ address, networkId, vaultPath }), /EEXIST/);
    store.close(); store = null;
    assert.equal(statSync(path).mode & 0o777, 0o600);
    store = openBeaconStateStore({ address, networkId, vaultPath });
    assert.equal(store.issued.size, 1);
    store.appendNonce({
      expiresAt: Date.now() + 1_000, replayKey: `${address}:${"1".repeat(64)}`,
      verifiedAt: Date.now(),
    });
    store.close(); store = null;
    store = openBeaconStateStore({ address, networkId, vaultPath });
    assert.equal(store.nonces.has(`${address}:${"1".repeat(64)}`), true);
    store.close(); store = null;

    const linkedVault = join(temporary, "linked.nirvault.json");
    const linkedState = `${linkedVault}.beacon-state.log`;
    const target = join(temporary, "attacker-state");
    writeFileSync(target, "{}\n", { mode: 0o600 });
    symlinkSync(target, linkedState);
    assert.throws(() => openBeaconStateStore({ address, networkId, vaultPath: linkedVault }));

    const legacyVault = join(temporary, "legacy.nirvault.json");
    const legacyKey = `fallback:${"7".repeat(64)}:2`;
    writeFileSync(`${legacyVault}.beacon-state.json`, JSON.stringify({
      address, networkId, shares: { [legacyKey]: { candidateId: "7".repeat(64), round: 2 } },
    }), { mode: 0o600 });
    const migrated = openBeaconStateStore({ address, networkId, vaultPath: legacyVault });
    assert.equal(migrated.issued.has(legacyKey), true);
    assert.match(migrated.path, /\.beacon-state\.log$/);
    migrated.close();

    chmodSync(path, 0o644);
    assert.throws(() => openBeaconStateStore({ address, networkId, vaultPath }), /unsafe/);
  } finally {
    store?.close();
    rmSync(temporary, { force: true, recursive: true });
  }
});

test("beacon state descriptor rejects an operator-root replacement before append", () => {
  const outer = mkdtempSync(join(tmpdir(), "nir-beacon-root-swap-"));
  const operatorRoot = join(outer, "operator");
  const movedRoot = join(outer, "operator-original");
  mkdirSync(operatorRoot, { mode: 0o700 });
  const vaultPath = join(operatorRoot, "operator.nirvault.json");
  const address = "nir1" + "9".repeat(64);
  let store;
  try {
    store = openBeaconStateStore({ address, networkId: "nir-root-swap", vaultPath });
    renameSync(operatorRoot, movedRoot);
    mkdirSync(operatorRoot, { mode: 0o700 });
    const replacementMarker = join(operatorRoot, "untouched");
    writeFileSync(replacementMarker, "attacker-controlled", { mode: 0o600 });
    assert.throws(() => store.append(
      `fallback:${"8".repeat(64)}:1`, { candidateId: "8".repeat(64), round: 1 },
    ), /parent changed/);
    assert.equal(readFileSync(replacementMarker, "utf8"), "attacker-controlled");
    assert.equal(store.issued.size, 0);
  } finally {
    store?.close();
    rmSync(outer, { force: true, recursive: true });
  }
});

test("durable beacon nonce rejects the same signed envelope after restart", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-beacon-replay-restart-"));
  const wallet = generateWallet(); const requester = generateWallet();
  const networkId = "nir-beacon-replay-restart";
  const vaultPath = join(temporary, "beacon.nirvault.json");
  const requesters = new Map([[requester.address,
    { ...publicWallet(requester), operatorId: "restart-requester" }]]);
  const envelope = JSON.stringify(createBeaconShareRequest({
    beaconAddress: wallet.address, candidateId: "6".repeat(64), networkId,
    purpose: "fallback", round: 1,
  }, requester, { nonce: "5".repeat(64) }));
  let store; let server;
  const start = async () => {
    store = openBeaconStateStore({ address: wallet.address, networkId, vaultPath });
    const persist = (record) => record.type === "nonce"
      ? store.appendNonce({ expiresAt: record.auth.expiresAt, replayKey: record.auth.replayKey,
        verifiedAt: record.auth.verifiedAt })
      : store.appendShareAndNonce(record.key, record.share,
        { expiresAt: record.auth.expiresAt, replayKey: record.auth.replayKey,
          verifiedAt: record.auth.verifiedAt });
    server = createBeaconHttpServer({
      issued: store.issued, networkId, nonces: store.nonces, persist, requesters, wallet,
    }, { timeHighWater: () => store.highWater });
    return listen(server);
  };
  try {
    let url = await start();
    assert.equal((await request(url, {
      body: envelope, headers: { "content-length": String(Buffer.byteLength(envelope)) },
      method: "POST", path: "/v1/share",
    })).status, 200);
    await close(server); store.close(); store = null;
    url = await start();
    assert.equal((await request(url, {
      body: envelope, headers: { "content-length": String(Buffer.byteLength(envelope)) },
      method: "POST", path: "/v1/share",
    })).status, 409);
  } finally {
    if (server?.listening) await close(server);
    store?.close(); rmSync(temporary, { force: true, recursive: true });
  }
});

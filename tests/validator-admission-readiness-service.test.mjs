import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { connect as tlsConnect } from "node:tls";

import { canonicalJson, generateWallet, hashObject, publicWallet, signObject }
  from "../blockchain/crypto.mjs";
import {
  createValidatorAdmissionReadinessChallenge,
  createValidatorAdmissionReadinessContext,
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN,
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN,
  VALIDATOR_ADMISSION_READINESS_CHALLENGE_DOMAIN,
  verifyValidatorAdmissionReadinessCandidateResponse,
} from "../blockchain/validator-admission-readiness-auth.mjs";
import { respondToValidatorAdmissionReadinessChallenge }
  from "../blockchain/validator-admission-readiness-responder.mjs";
import {
  createValidatorAdmissionReadinessServer,
  VALIDATOR_ADMISSION_READINESS_CHALLENGE_PATH,
  VALIDATOR_ADMISSION_READINESS_MAX_BODY_BYTES,
} from "../blockchain/validator-admission-readiness-service.mjs";
import {
  VALIDATOR_ADMISSION_READINESS_OBSERVER_CONTEXT_PATH,
  VALIDATOR_ADMISSION_READINESS_OBSERVER_RECEIPT_PATH,
} from "../blockchain/validator-admission-readiness-observer-routes.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";

const temporary = mkdtempSync(join(tmpdir(), "nir-readiness-service-"));
const keyPath = join(temporary, "tls-key.pem");
const certPath = join(temporary, "tls-cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"],
{ stdio: "ignore" });
const tls = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
const tlsCertificateSha256 = createHash("sha256").update(new X509Certificate(tls.cert).raw)
  .digest("hex");
after(() => rmSync(temporary, { force: true, recursive: true }));

function fixture() {
  const candidate = generateWallet();
  const transport = generateWallet();
  const observerWallets = Array.from({ length: 4 }, generateWallet);
  const validators = observerWallets.map((wallet, index) => ({ ...publicWallet(wallet),
    operatorId: `observer-${index}` }));
  const context = createValidatorAdmissionReadinessContext({
    admission: { admissionId: "a".repeat(64), ...publicWallet(candidate),
      endpoint: "https://candidate.example", operatorId: "candidate-one",
      tlsCertificateSha256, transport: publicWallet(transport) },
    chainIdentityGenesisHash: "c".repeat(64), checkpoint: { blockHash: "d".repeat(64),
      height: 100, stateRoot: "e".repeat(64), validatorSetId: validatorSetId(validators) },
    expiresAtHeight: 116, networkId: "nir-readiness-service-test", nonce: 4,
  });
  const challenge = createValidatorAdmissionReadinessChallenge({
    challengeNonce: "f".repeat(64), context, observerWallet: observerWallets[0], validators,
  });
  return { candidate, challenge, context, observerWallets, transport, validators };
}

function signer(wallet, calls, label, implementation = null) {
  const method = label === "transport" ? "signReadinessTransport" : "signReadinessConsensus";
  const domain = label === "transport"
    ? VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN
    : VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN;
  return { ...publicWallet(wallet), [method]: async ({ signal, signingInput }) => {
    calls.push(label);
    if (implementation) return implementation(signingInput, domain, { signal });
    return signObject(signingInput, wallet, domain);
  } };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `https://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  if (server.listening) await server.gracefulShutdown(300);
}

function request(base, { body = null, headers = {}, method = "POST",
  path = VALIDATOR_ADMISSION_READINESS_CHALLENGE_PATH,
  maxVersion = "TLSv1.3", minVersion = "TLSv1.3" } = {}) {
  const encoded = body === null ? null : Buffer.from(typeof body === "string" ? body
    : canonicalJson(body));
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(new URL(path, base), { headers: encoded ? {
      "content-length": String(encoded.length), "content-type": "application/json", ...headers,
    } : headers, maxVersion, method, minVersion, rejectUnauthorized: false }, (response) => {
      const chunks = [];
      const protocol = response.socket.getProtocol();
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ body: JSON.parse(raw), protocol, raw,
          status: response.statusCode });
      });
    });
    outgoing.on("error", reject);
    if (encoded) outgoing.write(encoded);
    outgoing.end();
  });
}

function rawTlsRequest(base, bytes) {
  const endpoint = new URL(base);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = tlsConnect({ host: endpoint.hostname, port: Number(endpoint.port),
      rejectUnauthorized: false }, () => socket.write(bytes));
    const timer = setTimeout(() => {
      socket.destroy(); reject(new Error("raw TLS response timed out"));
    }, 1_000);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

test("pure responder verifies before sequential transport and consensus signing", async () => {
  const values = fixture(); const calls = [];
  const options = { challenge: values.challenge, context: values.context,
    consensusSigner: signer(values.candidate, calls, "consensus"),
    transportSigner: signer(values.transport, calls, "transport"), validators: values.validators };
  const response = await respondToValidatorAdmissionReadinessChallenge(options);
  assert.deepEqual(calls, ["transport", "consensus"]);
  assert.deepEqual(verifyValidatorAdmissionReadinessCandidateResponse(response,
    { validators: values.validators }), response);

  calls.length = 0;
  const invalid = structuredClone(values.challenge); invalid.challengeNonce = "0".repeat(64);
  await assert.rejects(() => respondToValidatorAdmissionReadinessChallenge({ ...options,
    challenge: invalid }), /challenge signature/);
  assert.deepEqual(calls, []);

  const wrongSigner = generateWallet();
  for (const invalidTransportSignature of [
    () => "AAAA",
    () => "A".repeat(8_000),
    (payload, domain) => signObject(payload, wrongSigner, domain),
  ]) {
    calls.length = 0;
    await assert.rejects(() => respondToValidatorAdmissionReadinessChallenge({ ...options,
      transportSigner: signer(values.transport, calls, "transport", invalidTransportSignature),
    }), /candidate transport response/);
    assert.deepEqual(calls, ["transport"]);
  }
});

test("HTTPS responder is TLS 1.3 only, canonical, fixed-path, and replay safe", async () => {
  const values = fixture(); const calls = [];
  const server = createValidatorAdmissionReadinessServer({
    consensusSigner: signer(values.candidate, calls, "consensus"),
    transportSigner: signer(values.transport, calls, "transport"),
    validators: values.validators,
  }, { tls });
  const base = await listen(server);
  try {
    const payload = { challenge: values.challenge, context: values.context };
    const accepted = await request(base, { body: payload });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.protocol, "TLSv1.3");
    assert.equal(accepted.raw, canonicalJson(accepted.body));
    assert.deepEqual(calls, ["transport", "consensus"]);
    assert.deepEqual(verifyValidatorAdmissionReadinessCandidateResponse(accepted.body,
      { validators: values.validators }), accepted.body);

    assert.equal((await request(base, { body: payload })).status, 400);
    assert.deepEqual(calls, ["transport", "consensus"]);
    assert.equal((await request(base, { body: payload, path: "/wrong" })).status, 404);
    assert.equal((await request(base, { method: "GET" })).status, 405);
    assert.equal((await request(base, { body: `${canonicalJson(payload)}\n` })).status, 400);
    assert.equal((await request(base, { body: { ...payload, extra: true } })).status, 400);
    await assert.rejects(() => request(base, { body: payload, maxVersion: "TLSv1.2",
      minVersion: "TLSv1.2" }), /protocol|tlsv1 alert/i);
  } finally { await close(server); }
});

test("production activation gate rejects before body parsing and opens exactly once", async () => {
  const values = fixture(); const calls = [];
  const server = createValidatorAdmissionReadinessServer({
    consensusSigner: signer(values.candidate, calls, "consensus"),
    transportSigner: signer(values.transport, calls, "transport"),
    validators: values.validators,
  }, { active: false, tls });
  const base = await listen(server);
  try {
    const ingressBefore = server.validatorAdmissionReadinessMetrics().httpIngress;
    const raw = await rawTlsRequest(base,
      `POST ${VALIDATOR_ADMISSION_READINESS_CHALLENGE_PATH} HTTP/1.1\r\n` +
      "Host: 127.0.0.1\r\nContent-Type: application/json\r\n" +
      "Content-Length: 999999999\r\nConnection: keep-alive\r\n\r\n");
    assert.match(raw, /^HTTP\/1\.1 503 /);
    assert.match(raw.toLowerCase(), /connection: close/);
    assert.deepEqual(server.validatorAdmissionReadinessMetrics().httpIngress, ingressBefore);
    assert.deepEqual(calls, []);
    const before = await request(base, { body: "not-canonical-or-json" });
    assert.equal(before.status, 503);
    assert.equal(before.body.error, "validator admission readiness service is not active");
    assert.deepEqual(calls, []);
    assert.equal(server.validatorAdmissionReadinessMetrics().activated, false);
    assert.equal(server.validatorAdmissionReadinessActivate(), true);
    assert.equal(server.validatorAdmissionReadinessMetrics().activated, true);
    assert.throws(() => server.validatorAdmissionReadinessActivate(), /already active/);
    const accepted = await request(base, { body: { challenge: values.challenge,
      context: values.context } });
    assert.equal(accepted.status, 200);
    assert.deepEqual(calls, ["transport", "consensus"]);
  } finally { await close(server); }
  assert.equal(server.validatorAdmissionReadinessMetrics().activated, false);
  assert.equal(server.validatorAdmissionReadinessMetrics().closed, true);
  assert.throws(() => server.validatorAdmissionReadinessActivate(), /closed/);
});

test("close deactivates first, aborts an in-flight signer and permits no late response", async () => {
  const values = fixture(); const calls = [];
  let startedResolve; let abortedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const aborted = new Promise((resolve) => { abortedResolve = resolve; });
  const transportSigner = signer(values.transport, calls, "transport",
    (_payload, _domain, { signal }) => new Promise((_resolve, reject) => {
      startedResolve();
      signal.addEventListener("abort", () => {
        abortedResolve(true); reject(signal.reason ?? new Error("aborted"));
      }, { once: true });
    }));
  const server = createValidatorAdmissionReadinessServer({
    consensusSigner: signer(values.candidate, calls, "consensus"), transportSigner,
    validators: values.validators,
  }, { active: false, responseTimeoutMs: 1_000, tls });
  const base = await listen(server);
  server.validatorAdmissionReadinessActivate();
  const pending = request(base, { body: { challenge: values.challenge,
    context: values.context } });
  await started;
  const closed = new Promise((resolve, reject) => server.close((error) =>
    error ? reject(error) : resolve()));
  assert.equal(server.validatorAdmissionReadinessMetrics().activated, false);
  assert.equal(server.validatorAdmissionReadinessMetrics().closed, true);
  assert.equal(await Promise.race([aborted,
    new Promise((resolve) => setTimeout(() => resolve(false), 200))]), true);
  await assert.rejects(pending);
  await closed;
  assert.deepEqual(calls, ["transport"]);
  assert.throws(() => server.validatorAdmissionReadinessActivate(), /closed/);
});

test("inactive observers and malformed or oversized requests never reach a signer", async () => {
  const values = fixture(); const calls = [];
  const outsider = generateWallet();
  const unsigned = { challengeNonce: "1".repeat(64), contextHash: values.context.contextHash,
    format: "nir-validator-admission-readiness-observer-challenge-v1",
    observer: outsider.address, version: 1 };
  const challengeHash = hashObject(unsigned, "VALIDATOR_READY_CHALLENGE_HASH_V1");
  const inactiveChallenge = { ...unsigned, challengeHash,
    signature: signObject({ ...unsigned, challengeHash }, outsider,
      VALIDATOR_ADMISSION_READINESS_CHALLENGE_DOMAIN) };
  const server = createValidatorAdmissionReadinessServer({
    consensusSigner: signer(values.candidate, calls, "consensus"),
    transportSigner: signer(values.transport, calls, "transport"), validators: values.validators,
  }, { bodyIdleTimeoutMs: 20, tls });
  const base = await listen(server);
  try {
    assert.equal((await request(base, { body: { challenge: inactiveChallenge,
      context: values.context } })).status, 400);
    const wrongPinContext = structuredClone(values.context);
    wrongPinContext.tlsCertificateSha256 = "0".repeat(64);
    const { contextHash: _contextHash, ...wrongPinPayload } = wrongPinContext;
    wrongPinContext.contextHash = hashObject(wrongPinPayload, "VALIDATOR_READY_CONTEXT_V1");
    const wrongPinChallenge = createValidatorAdmissionReadinessChallenge({
      challengeNonce: "2".repeat(64), context: wrongPinContext,
      observerWallet: values.observerWallets[0], validators: values.validators,
    });
    assert.equal((await request(base, { body: { challenge: wrongPinChallenge,
      context: wrongPinContext } })).status, 400);
    assert.equal((await request(base, { body: "not-json" })).status, 400);
    const oversized = await request(base, { body: "{}", headers: {
      "content-length": String(VALIDATOR_ADMISSION_READINESS_MAX_BODY_BYTES + 1),
    } });
    assert.equal(oversized.status, 413);
    assert.deepEqual(calls, []);
  } finally { await close(server); }
});

test("one request per context-observer is active and signer time is bounded", async () => {
  const values = fixture(); const calls = [];
  let release; let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const transportSigner = signer(values.transport, calls, "transport", async (payload, domain) => {
    started(); await gate; return signObject(payload, values.transport, domain);
  });
  const server = createValidatorAdmissionReadinessServer({
    consensusSigner: signer(values.candidate, calls, "consensus"), transportSigner,
    validators: values.validators,
  }, { responseTimeoutMs: 1_000, tls });
  const base = await listen(server);
  try {
    const body = { challenge: values.challenge, context: values.context };
    const first = request(base, { body });
    await startedPromise;
    const duplicate = await request(base, { body });
    assert.equal(duplicate.status, 400);
    release();
    assert.equal((await first).status, 200);
    assert.deepEqual(calls, ["transport", "consensus"]);
  } finally { release(); await close(server); }

  const timeoutCalls = [];
  const timeoutServer = createValidatorAdmissionReadinessServer({
    consensusSigner: signer(values.candidate, timeoutCalls, "consensus"),
    transportSigner: signer(values.transport, timeoutCalls, "transport", () =>
      new Promise(() => {})), validators: values.validators,
  }, { responseTimeoutMs: 20, tls });
  const timeoutBase = await listen(timeoutServer);
  try {
    const result = await request(timeoutBase, { body: { challenge: values.challenge,
      context: values.context } });
    assert.equal(result.status, 408);
    assert.deepEqual(timeoutCalls, ["transport"]);
    assert.equal(timeoutServer.validatorAdmissionReadinessMetrics().active, 0);
  } finally { await close(timeoutServer); }
});

test("client disconnect aborts an active signer without consensus signing or late writes", async () => {
  const values = fixture(); const calls = []; const unhandled = [];
  let signerStarted; let signerAborted;
  const started = new Promise((resolve) => { signerStarted = resolve; });
  const aborted = new Promise((resolve) => { signerAborted = resolve; });
  const transportSigner = signer(values.transport, calls, "transport",
    (_payload, _domain, { signal }) => new Promise((_resolve, reject) => {
      signerStarted();
      signal.addEventListener("abort", () => {
        signerAborted(signal.aborted);
        setTimeout(() => reject(new Error("late signer rejection")), 5);
      }, { once: true });
    }));
  const server = createValidatorAdmissionReadinessServer({
    consensusSigner: signer(values.candidate, calls, "consensus"), transportSigner,
    validators: values.validators,
  }, { responseTimeoutMs: 1_000, tls });
  const base = await listen(server);
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const body = Buffer.from(canonicalJson({ challenge: values.challenge,
      context: values.context }));
    const outgoing = httpsRequest(new URL(VALIDATOR_ADMISSION_READINESS_CHALLENGE_PATH, base), {
      headers: { "content-length": String(body.length), "content-type": "application/json" },
      method: "POST", minVersion: "TLSv1.3", rejectUnauthorized: false,
    });
    outgoing.on("error", () => {}); outgoing.end(body);
    await started;
    outgoing.destroy();
    assert.equal(await Promise.race([aborted,
      new Promise((resolve) => setTimeout(() => resolve(false), 200))]), true);
    for (let attempt = 0; attempt < 40 &&
         server.validatorAdmissionReadinessMetrics().active !== 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(server.validatorAdmissionReadinessMetrics().active, 0);
    assert.deepEqual(calls, ["transport"]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await close(server);
  }
});

test("body idle timeout and ingress rate limit are enforced over real TLS", async () => {
  const values = fixture(); const calls = [];
  const server = createValidatorAdmissionReadinessServer({
    consensusSigner: signer(values.candidate, calls, "consensus"),
    transportSigner: signer(values.transport, calls, "transport"), validators: values.validators,
  }, { bodyIdleTimeoutMs: 20, burst: 1, requestsPerMinute: 1, tls });
  const base = await listen(server);
  try {
    const timedOut = await new Promise((resolve, reject) => {
      const outgoing = httpsRequest(new URL(VALIDATOR_ADMISSION_READINESS_CHALLENGE_PATH, base), {
        headers: { "content-length": "100", "content-type": "application/json" },
        method: "POST", minVersion: "TLSv1.3", rejectUnauthorized: false,
      }, (response) => {
        const chunks = []; response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          outgoing.destroy();
          resolve({ body: JSON.parse(Buffer.concat(chunks)), status: response.statusCode });
        });
      });
      outgoing.on("error", reject); outgoing.write("{");
    });
    assert.equal(timedOut.status, 408);
    const limited = await request(base, { body: { challenge: values.challenge,
      context: values.context } });
    assert.equal(limited.status, 429);
    assert.deepEqual(calls, []);
  } finally { await close(server); }
});

test("validator service exposes strict TLS-only observer context and receipt routes", async () => {
  const values = fixture(); const expectedReceipt = { receipt: "observer-signed" };
  const calls = [];
  const validator = {
    validatorAdmissionReadinessContext(address) {
      calls.push(["context", address]);
      assert.equal(address, values.context.candidate.address);
      return values.context;
    },
    async observeValidatorAdmissionReadiness(context, { signal }) {
      calls.push(["observe", context]);
      assert.equal(signal.aborted, false);
      assert.deepEqual(context, values.context);
      return expectedReceipt;
    },
  };
  const server = createValidatorHttpServer(validator, { tls });
  const base = await listen(server);
  try {
    const contextPath = `${VALIDATOR_ADMISSION_READINESS_OBSERVER_CONTEXT_PATH}?address=${
      values.context.candidate.address}`;
    const context = await request(base, { method: "GET", path: contextPath });
    assert.equal(context.status, 200); assert.equal(context.protocol, "TLSv1.3");
    assert.deepEqual(context.body, values.context);
    assert.equal((await request(base, { method: "GET",
      path: `${contextPath}&extra=1` })).status, 400);
    assert.equal((await request(base, { method: "GET",
      path: `${contextPath}&address=${values.context.candidate.address}` })).status, 400);
    assert.equal((await request(base, { method: "GET",
      path: VALIDATOR_ADMISSION_READINESS_OBSERVER_CONTEXT_PATH })).status, 400);

    const receipt = await request(base, { body: { context: values.context },
      path: VALIDATOR_ADMISSION_READINESS_OBSERVER_RECEIPT_PATH });
    assert.equal(receipt.status, 200); assert.deepEqual(receipt.body, expectedReceipt);
    assert.equal((await request(base, { body: { context: values.context, extra: true },
      path: VALIDATOR_ADMISSION_READINESS_OBSERVER_RECEIPT_PATH })).status, 400);
    assert.equal((await request(base, { body: { context: values.context },
      path: `${VALIDATOR_ADMISSION_READINESS_OBSERVER_RECEIPT_PATH}?extra=1` })).status, 400);
    assert.equal((await request(base, { method: "GET",
      path: VALIDATOR_ADMISSION_READINESS_OBSERVER_RECEIPT_PATH })).status, 404);
    await assert.rejects(() => request(base, { method: "GET", path: contextPath,
      maxVersion: "TLSv1.2", minVersion: "TLSv1.2" }), /protocol|tlsv1 alert/i);
    assert.deepEqual(calls.map(([name]) => name), ["context", "observe"]);
  } finally { await close(server); }

  const plaintext = createValidatorHttpServer(validator);
  await new Promise((resolve, reject) => {
    plaintext.once("error", reject); plaintext.listen(0, "127.0.0.1", resolve);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${plaintext.address().port}${
      VALIDATOR_ADMISSION_READINESS_OBSERVER_CONTEXT_PATH}?address=${
      values.context.candidate.address}`);
    assert.equal(response.status, 400);
  } finally { await close(plaintext); }
});

test("validator observer receipt route aborts orchestration on client disconnect", async () => {
  const values = fixture(); let startedResolve; let abortedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const aborted = new Promise((resolve) => { abortedResolve = resolve; });
  const validator = {
    async observeValidatorAdmissionReadiness(_context, { signal }) {
      startedResolve();
      return new Promise((_, reject) => signal.addEventListener("abort", () => {
        abortedResolve(signal.aborted); reject(new Error("observer request aborted"));
      }, { once: true }));
    },
  };
  const server = createValidatorHttpServer(validator, { tls });
  const base = await listen(server); const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const body = Buffer.from(canonicalJson({ context: values.context }));
    const outgoing = httpsRequest(new URL(
      VALIDATOR_ADMISSION_READINESS_OBSERVER_RECEIPT_PATH, base), {
      headers: { "content-length": String(body.length), "content-type": "application/json" },
      method: "POST", minVersion: "TLSv1.3", rejectUnauthorized: false,
    });
    outgoing.on("error", () => {}); outgoing.end(body);
    await started; outgoing.destroy();
    assert.equal(await Promise.race([aborted,
      new Promise((resolve) => setTimeout(() => resolve(false), 200))]), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await close(server);
  }
});

test("runtime import boundary has no join, wallet, vault, CLI, or general node service", () => {
  for (const filename of ["validator-admission-readiness-responder.mjs",
    "validator-admission-readiness-service.mjs"]) {
    const source = readFileSync(join(process.cwd(), "blockchain", filename), "utf8");
    assert.doesNotMatch(source,
      /(?:validator-join|wallet-files|vault|distributed-node|node-store|validator-service|\.\.\/)/);
    assert.doesNotMatch(source, /(?:Path|privateKey|readFile|writeFile|process\.env)/);
  }
});

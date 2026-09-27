import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createValidatorAdmissionReadinessCandidateResponse,
  createValidatorAdmissionReadinessChallenge,
  createValidatorAdmissionReadinessContext,
  createValidatorAdmissionReadinessReceipt,
} from "../blockchain/validator-admission-readiness-auth.mjs";
import {
  fetchValidatorAdmissionReadinessContext,
  createValidatorAdmissionReadinessObserverClient,
  requestValidatorAdmissionReadinessReceipt,
  VALIDATOR_ADMISSION_READINESS_OBSERVER_CONTEXT_PATH,
  VALIDATOR_ADMISSION_READINESS_OBSERVER_RECEIPT_PATH,
} from "../blockchain/validator-admission-readiness-observer-client.mjs";
import { collectValidatorAdmissionReadinessCertificate }
  from "../blockchain/validator-admission-readiness-collector.mjs";
import {
  createCertificateRecord, EMPTY_CERTIFICATE_RECORD_HASH,
} from "../blockchain/certificate-lifecycle.mjs";
import { canonicalJson, generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { certificateSha256 } from "../blockchain/http-client.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function fixture(pin) {
  const observers = Array.from({ length: 4 }, generateWallet);
  const validators = observers.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `observer-client-${index}`,
  }));
  const candidate = generateWallet(); const transport = generateWallet();
  const context = createValidatorAdmissionReadinessContext({
    admission: { admissionId: "1".repeat(64), ...publicWallet(candidate),
      endpoint: "https://candidate.example", operatorId: "observer-client-candidate",
      tlsCertificateSha256: "2".repeat(64), transport: publicWallet(transport) },
    chainIdentityGenesisHash: "3".repeat(64), checkpoint: { blockHash: "4".repeat(64),
      height: 100, stateRoot: "5".repeat(64), validatorSetId: validatorSetId(validators) },
    expiresAtHeight: 116, networkId: "nir-observer-client-test", nonce: 7,
  });
  const challenge = createValidatorAdmissionReadinessChallenge({
    challengeNonce: "6".repeat(64), context, observerWallet: observers[0], validators,
  });
  const candidateResponse = createValidatorAdmissionReadinessCandidateResponse({ candidateWallet:
    candidate, challenge, context, transportWallet: transport, validators });
  const receipt = createValidatorAdmissionReadinessReceipt({ candidateResponse,
    observerWallet: observers[0], validators });
  const otherChallenge = createValidatorAdmissionReadinessChallenge({
    challengeNonce: "9".repeat(64), context, observerWallet: observers[1], validators,
  });
  const otherResponse = createValidatorAdmissionReadinessCandidateResponse({ candidateWallet:
    candidate, challenge: otherChallenge, context, transportWallet: transport, validators });
  const otherReceipt = createValidatorAdmissionReadinessReceipt({ candidateResponse: otherResponse,
    observerWallet: observers[1], validators });
  const certificateHistory = [createCertificateRecord({ activationHeight: 1,
    certificate: { serial: "1a", sha256: pin }, networkId: context.networkId,
    operation: "issue", overlapUntilHeight: 1, peerRegistryHash: "7".repeat(64),
    previousRecordHash: EMPTY_CERTIFICATE_RECORD_HASH, sequence: 0,
    topologyHistoryHash: "8".repeat(64), validatorAddress: observers[0].address,
  }, observers.slice(0, 3))];
  return { certificateContext: { networkId: context.networkId, validators },
    certificateHistory, context, observers, otherReceipt, receipt, validators };
}

test("observer client uses exact pinned-TLS routes and verifies context and receipt", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-observer-client-"));
  const keyPath = join(temporary, "key.pem"); const certPath = join(temporary, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout",
    keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const key = readFileSync(keyPath); const cert = readFileSync(certPath);
  const pin = certificateSha256(new X509Certificate(cert).raw);
  const values = fixture(pin); const requests = [];
  let mode = "success";
  const server = createServer({ cert, key, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" },
    (request, response) => {
      requests.push({ method: request.method, url: request.url });
      if (mode === "redirect") {
        response.writeHead(302, { location: "https://127.0.0.1/elsewhere" });
        return response.end(canonicalJson({ redirect: true }));
      }
      if (mode === "oversize") {
        response.writeHead(200); return response.end("x".repeat(256 * 1024 + 1));
      }
      if (mode === "error") {
        response.writeHead(503); return response.end(canonicalJson({ error: "unavailable" }));
      }
      if (request.method === "GET") {
        response.writeHead(200); return response.end(canonicalJson(values.context));
      }
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        assert.equal(Buffer.concat(chunks).toString("utf8"), canonicalJson({ context: values.context }));
        response.writeHead(200); response.end(canonicalJson(values.receipt));
      });
    });
  try {
    const port = await listen(server);
    const peer = { url: `https://127.0.0.1:${port}`,
      validatorAddress: values.observers[0].address };
    const common = { certificateContext: values.certificateContext,
      certificateHistory: values.certificateHistory, height: 100, peer };
    const { height: _height, ...receiptCommon } = common;
    assert.deepEqual(await fetchValidatorAdmissionReadinessContext({ ...common,
      candidateAddress: values.context.candidate.address }), values.context);
    assert.deepEqual(await requestValidatorAdmissionReadinessReceipt({ ...receiptCommon,
      context: values.context, validator: values.validators[0] }), values.receipt);
    assert.deepEqual(requests, [
      { method: "GET", url: `${VALIDATOR_ADMISSION_READINESS_OBSERVER_CONTEXT_PATH}?address=${values.context.candidate.address}` },
      { method: "POST", url: VALIDATOR_ADMISSION_READINESS_OBSERVER_RECEIPT_PATH },
    ]);

    mode = "redirect";
    await assert.rejects(fetchValidatorAdmissionReadinessContext({ ...common,
      candidateAddress: values.context.candidate.address }), /status is invalid/);
    mode = "oversize";
    await assert.rejects(fetchValidatorAdmissionReadinessContext({ ...common,
      candidateAddress: values.context.candidate.address }), /too large/);
    mode = "error";
    await assert.rejects(requestValidatorAdmissionReadinessReceipt({ ...receiptCommon,
      context: values.context, validator: values.validators[0] }), /status is invalid/);

    const wrongHistory = [createCertificateRecord({ activationHeight: 1,
      certificate: { serial: "2b", sha256: "f".repeat(64) },
      networkId: values.context.networkId, operation: "issue", overlapUntilHeight: 1,
      peerRegistryHash: "7".repeat(64), previousRecordHash: EMPTY_CERTIFICATE_RECORD_HASH,
      sequence: 0, topologyHistoryHash: "8".repeat(64),
      validatorAddress: values.observers[0].address }, values.observers.slice(0, 3))];
    await assert.rejects(fetchValidatorAdmissionReadinessContext({ ...common,
      certificateHistory: wrongHistory,
      candidateAddress: values.context.candidate.address }), /pin mismatch/);
  } finally {
    await close(server); rmSync(temporary, { recursive: true, force: true });
  }
});

test("observer client rejects plaintext, malformed origins, missing pins, and caller overrides", async () => {
  const values = fixture("a".repeat(64));
  const base = { certificateContext: values.certificateContext,
    certificateHistory: values.certificateHistory, height: 100,
    peer: { url: "https://validator.example", validatorAddress: values.observers[0].address } };
  for (const url of ["http://validator.example", "https://user@validator.example",
    "https://validator.example/path", "https://validator.example?pin=x",
    "https://validator.example/#fragment"]) {
    await assert.rejects(fetchValidatorAdmissionReadinessContext({ ...base,
      candidateAddress: values.context.candidate.address, peer: { ...base.peer, url } }),
    /canonical HTTPS origin/);
  }
  await assert.rejects(fetchValidatorAdmissionReadinessContext({ ...base,
    candidateAddress: values.context.candidate.address, certificateHistory: [] }),
  /no active authenticated TLS certificate/);
  await assert.rejects(fetchValidatorAdmissionReadinessContext({ ...base,
    candidateAddress: values.context.candidate.address,
    tlsCertificateSha256: "a".repeat(64) }), /unknown fields/);
});

test("observer client rejects malformed authenticated payloads and bounds custom requests", async () => {
  const values = fixture("a".repeat(64));
  const base = { certificateContext: values.certificateContext,
    certificateHistory: values.certificateHistory, height: 100,
    peer: { url: "https://validator.example", validatorAddress: values.observers[0].address } };
  const { height: _height, ...receiptBase } = base;
  await assert.rejects(fetchValidatorAdmissionReadinessContext({ ...base,
    candidateAddress: values.context.candidate.address,
    request: async () => ({ body: { malformed: true }, ok: true, status: 200 }) }),
  /unknown or missing fields/);
  const wrongReceipt = structuredClone(values.receipt);
  wrongReceipt.observationAttestation.validator = values.observers[1].address;
  await assert.rejects(requestValidatorAdmissionReadinessReceipt({ ...receiptBase,
    context: values.context, validator: values.validators[0],
    request: async () => ({ body: wrongReceipt, ok: true, status: 200 }) }), /receipt is invalid/);
  await assert.rejects(requestValidatorAdmissionReadinessReceipt({ ...receiptBase,
    context: values.context, validator: values.validators[0],
    request: async () => ({ body: values.otherReceipt, ok: true, status: 200 }) }),
  /observer is mismatched/);
  await assert.rejects(fetchValidatorAdmissionReadinessContext({ ...base,
    candidateAddress: values.context.candidate.address, request: () => new Promise(() => {}),
    timeoutMs: 20 }), /timed out/);
  const controller = new AbortController();
  const pending = fetchValidatorAdmissionReadinessContext({ ...base,
    candidateAddress: values.context.candidate.address, request: () => new Promise(() => {}),
    signal: controller.signal, timeoutMs: 1_000 });
  controller.abort();
  await assert.rejects(pending, /was aborted/);
});

test("observer client binds contexts and peers to the exact certificate validator state", async () => {
  const values = fixture("a".repeat(64));
  const peer = { url: "https://validator.example",
    validatorAddress: values.observers[0].address };
  const response = async () => ({ body: values.context, ok: true, status: 200 });
  await assert.rejects(fetchValidatorAdmissionReadinessContext({
    candidateAddress: values.context.candidate.address,
    certificateContext: { ...values.certificateContext, networkId: "other-network" },
    certificateHistory: values.certificateHistory, height: 100, peer, request: response,
  }), /certificate state is mismatched/);
  const substituted = [...values.validators];
  substituted[substituted.length - 1] = { ...publicWallet(generateWallet()),
    operatorId: "substituted-observer" };
  await assert.rejects(fetchValidatorAdmissionReadinessContext({
    candidateAddress: values.context.candidate.address,
    certificateContext: { networkId: values.context.networkId, validators: substituted },
    certificateHistory: values.certificateHistory, height: 100, peer, request: response,
  }), /certificate state is mismatched/);
  await assert.rejects(fetchValidatorAdmissionReadinessContext({
    candidateAddress: values.context.candidate.address,
    certificateContext: values.certificateContext,
    certificateHistory: values.certificateHistory, height: 100,
    peer: { ...peer, validatorAddress: generateWallet().address }, request: response,
  }), /peer membership is invalid/);
  await assert.rejects(requestValidatorAdmissionReadinessReceipt({
    certificateContext: values.certificateContext,
    certificateHistory: values.certificateHistory, context: values.context, peer,
    request: async () => ({ body: values.receipt, ok: true, status: 200 }),
    validator: { ...values.validators[0], operatorId: "mutated-operator" },
  }), /peer membership is invalid/);
});

test("observer client factory composes caller and collection abort signals", async () => {
  const values = fixture("a".repeat(64));
  const peer = { url: "https://validator.example",
    validatorAddress: values.observers[0].address };
  const never = () => new Promise(() => {});
  const outer = new AbortController();
  const outerClient = createValidatorAdmissionReadinessObserverClient({
    certificateContext: values.certificateContext, certificateHistory: values.certificateHistory,
    request: never, signal: outer.signal, timeoutMs: 1_000,
  });
  const outerPending = outerClient.requestReceipt({ context: values.context, peer,
    validator: values.validators[0] });
  outer.abort();
  await assert.rejects(outerPending, /was aborted/);

  const perCall = new AbortController();
  const client = createValidatorAdmissionReadinessObserverClient({
    certificateContext: values.certificateContext, certificateHistory: values.certificateHistory,
    request: never, timeoutMs: 1_000,
  });
  const callPending = client.requestReceipt({ context: values.context, peer,
    signal: perCall.signal, validator: values.validators[0] });
  perCall.abort();
  await assert.rejects(callPending, /was aborted/);
});

test("real collector and observer client return exact quorum and cancel hanging minority sockets",
  async () => {
    const temporary = mkdtempSync(join(tmpdir(), "nir-observer-quorum-"));
    const wallets = Array.from({ length: 7 }, generateWallet);
    const validators = wallets.map((wallet, index) => ({ ...publicWallet(wallet),
      operatorId: `observer-integration-${index}` }))
      .sort((left, right) => left.address.localeCompare(right.address));
    const walletByAddress = new Map(wallets.map((wallet) => [wallet.address, wallet]));
    const candidate = generateWallet(); const transport = generateWallet();
    const context = createValidatorAdmissionReadinessContext({
      admission: { admissionId: "a".repeat(64), ...publicWallet(candidate),
        endpoint: "https://candidate.example", operatorId: "integration-candidate",
        tlsCertificateSha256: "b".repeat(64), transport: publicWallet(transport) },
      chainIdentityGenesisHash: "c".repeat(64), checkpoint: { blockHash: "d".repeat(64),
        height: 100, stateRoot: "e".repeat(64), validatorSetId: validatorSetId(validators) },
      expiresAtHeight: 116, networkId: "nir-observer-integration", nonce: 4,
    });
    const receipts = new Map(validators.map((validator, index) => {
      const observerWallet = walletByAddress.get(validator.address);
      const challenge = createValidatorAdmissionReadinessChallenge({
        challengeNonce: String(index + 1).padStart(64, "0"), context, observerWallet, validators,
      });
      const candidateResponse = createValidatorAdmissionReadinessCandidateResponse({
        candidateWallet: candidate, challenge, context, transportWallet: transport, validators,
      });
      return [validator.address, createValidatorAdmissionReadinessReceipt({ candidateResponse,
        observerWallet, validators })];
    }));
    const certificateHistory = []; const peers = []; const servers = [];
    const hanging = new Set(validators.slice(-2).map(({ address }) => address));
    const cancelled = new Set();
    try {
      for (const [index, validator] of validators.entries()) {
        const keyPath = join(temporary, `key-${index}.pem`);
        const certPath = join(temporary, `cert-${index}.pem`);
        execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout",
          keyPath, "-out", certPath, "-days", "1", "-subj", `/CN=observer-${index}`],
        { stdio: "ignore" });
        const key = readFileSync(keyPath); const cert = readFileSync(certPath);
        const pin = certificateSha256(new X509Certificate(cert).raw);
        certificateHistory.push(createCertificateRecord({ activationHeight: 1,
          certificate: { serial: (index + 1).toString(16), sha256: pin },
          networkId: context.networkId, operation: "issue", overlapUntilHeight: 1,
          peerRegistryHash: "1".repeat(64), previousRecordHash: EMPTY_CERTIFICATE_RECORD_HASH,
          sequence: 0, topologyHistoryHash: "2".repeat(64),
          validatorAddress: validator.address }, wallets.slice(0, 5)));
        const server = createServer({ cert, key, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" },
          (request, response) => {
            request.resume();
            request.on("end", () => {
              if (hanging.has(validator.address)) {
                response.once("close", () => cancelled.add(validator.address));
                return;
              }
              response.writeHead(200); response.end(canonicalJson(receipts.get(validator.address)));
            });
          });
        servers.push(server);
        const port = await listen(server);
        peers.push({ url: `https://127.0.0.1:${port}`, validatorAddress: validator.address });
      }
      const client = createValidatorAdmissionReadinessObserverClient({
        certificateContext: { networkId: context.networkId, validators }, certificateHistory,
        timeoutMs: 2_000,
      });
      const certificate = await collectValidatorAdmissionReadinessCertificate({
        collectReceipt: client.requestReceipt, concurrency: 7, context, peers,
        requestTimeoutMs: 1_000, validators,
      });
      assert.deepEqual(certificate.receipts.map(({ observationAttestation }) =>
        observationAttestation.validator), validators.slice(0, 5).map(({ address }) => address));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual([...cancelled].sort(), [...hanging].sort());
    } finally {
      await Promise.all(servers.map(close));
      rmSync(temporary, { recursive: true, force: true });
    }
  });

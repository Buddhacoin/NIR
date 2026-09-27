import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createTlsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { certificateSha256 } from "../blockchain/http-client.mjs";
import { canonicalJson, generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  createValidatorAdmissionReadinessCandidateResponse,
  createValidatorAdmissionReadinessChallenge,
  createValidatorAdmissionReadinessContext,
} from "../blockchain/validator-admission-readiness-auth.mjs";
import {
  isForbiddenValidatorReadinessAddress,
  probeValidatorAdmissionReadiness,
  VALIDATOR_ADMISSION_READINESS_MAX_BODY_BYTES,
  VALIDATOR_ADMISSION_READINESS_PATH,
} from "../blockchain/validator-admission-readiness-probe.mjs";
import { VALIDATOR_ADMISSION_READINESS_CHALLENGE_PATH }
  from "../blockchain/validator-admission-readiness-service.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";

const localResolver = (_hostname, _options, callback) => callback(null,
  [{ address: "127.0.0.1", family: 4 }]);

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function readinessFixture(endpoint, tlsCertificateSha256) {
  const candidateWallet = generateWallet(); const transportWallet = generateWallet();
  const observerWallets = Array.from({ length: 4 }, generateWallet);
  const validators = observerWallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `probe-observer-${index}`,
  }));
  const context = createValidatorAdmissionReadinessContext({
    admission: { admissionId: "1".repeat(64), ...publicWallet(candidateWallet), endpoint,
      operatorId: "probe-candidate", tlsCertificateSha256,
      transport: publicWallet(transportWallet) },
    chainIdentityGenesisHash: "2".repeat(64), checkpoint: { blockHash: "3".repeat(64),
      height: 100, stateRoot: "4".repeat(64), validatorSetId: validatorSetId(validators) },
    expiresAtHeight: 116, networkId: "nir-readiness-probe-test", nonce: 7,
  });
  const challenge = createValidatorAdmissionReadinessChallenge({
    challengeNonce: "5".repeat(64), context, observerWallet: observerWallets[0], validators,
  });
  return { candidateWallet, challenge, context, transportWallet, validators };
}

test("SSRF policy rejects non-public IPv4, IPv6, mapped, multicast, and reserved ranges", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1",
    "172.16.0.1", "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::",
    "::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "100::1", "2001::1",
    "2001:db8::1", "2002:7f00:1::", "3ffe::1", "3fff::", "3fff::1",
    "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff", "fc00::1", "fe80::1", "ff02::1",
  ]) assert.equal(isForbiddenValidatorReadinessAddress(address), true, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111",
    "2001:4860:4860::8888", "3fff:1000::", "3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]) {
    assert.equal(isForbiddenValidatorReadinessAddress(address), false, address);
  }
  assert.equal(isForbiddenValidatorReadinessAddress("not-an-address"), true);
});

test("probe uses one pinned DNS result, TLS 1.3 leaf pin, fixed path, and verified response", async () => {
  assert.equal(VALIDATOR_ADMISSION_READINESS_PATH,
    VALIDATOR_ADMISSION_READINESS_CHALLENGE_PATH);
  const temporary = mkdtempSync(join(tmpdir(), "nir-readiness-probe-"));
  let mode = "success"; let values; let observedPath; let observedMethod; let observedProtocol;
  const keyPath = join(temporary, "key.pem"); const certPath = join(temporary, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout",
    keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const key = readFileSync(keyPath); const cert = readFileSync(certPath);
  const pin = certificateSha256(new X509Certificate(cert).raw);
  const server = createTlsServer({ cert, key, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" },
    (request, response) => {
      observedPath = request.url; observedMethod = request.method;
      observedProtocol = request.socket.getProtocol();
      if (mode === "redirect") {
        response.writeHead(302, { location: "https://127.0.0.1/metadata" }); response.end(); return;
      }
      if (mode === "oversize") {
        response.writeHead(200, { "content-length": VALIDATOR_ADMISSION_READINESS_MAX_BODY_BYTES + 1 });
        response.end("x".repeat(VALIDATOR_ADMISSION_READINESS_MAX_BODY_BYTES + 1)); return;
      }
      if (mode === "slow") return;
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const supplied = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const candidateResponse = createValidatorAdmissionReadinessCandidateResponse({
          candidateWallet: values.candidateWallet, challenge: supplied.challenge,
          context: supplied.context, transportWallet: values.transportWallet,
          validators: values.validators,
        });
        response.writeHead(200, { "content-type": "application/json" });
        if (mode === "noncanonical") response.end(JSON.stringify(candidateResponse, null, 2));
        else if (mode === "tampered") response.end(canonicalJson({ ...candidateResponse,
          responseHash: "0".repeat(64) }));
        else response.end(canonicalJson(candidateResponse));
      });
    });
  try {
    const port = await listen(server);
    values = readinessFixture(`https://localhost:${port}`, pin);
    await assert.rejects(() => probeValidatorAdmissionReadiness({ ...values,
      resolver: localResolver }), /forbidden address/);

    let resolutions = 0;
    const rebindAttempt = (_hostname, _options, callback) => {
      resolutions += 1;
      callback(null, [{ address: resolutions === 1 ? "127.0.0.1" : "127.0.0.2", family: 4 }]);
    };
    const result = await probeValidatorAdmissionReadiness({ ...values,
      allowPrivateNetworkForTesting: true, resolver: rebindAttempt });
    assert.equal(result.contextHash, values.context.contextHash);
    assert.equal(result.challengeHash, values.challenge.challengeHash);
    assert.equal(resolutions, 1, "the dial must not perform a second DNS lookup");
    assert.equal(observedPath, VALIDATOR_ADMISSION_READINESS_PATH);
    assert.equal(observedMethod, "POST");
    assert.equal(observedProtocol, "TLSv1.3");

    const wrongPin = readinessFixture(`https://localhost:${port}`, "f".repeat(64));
    await assert.rejects(() => probeValidatorAdmissionReadiness({ ...wrongPin,
      allowPrivateNetworkForTesting: true, resolver: localResolver }), /pin mismatch/);

    mode = "redirect";
    await assert.rejects(() => probeValidatorAdmissionReadiness({ ...values,
      allowPrivateNetworkForTesting: true, resolver: localResolver }), /status is invalid/);
    mode = "oversize";
    await assert.rejects(() => probeValidatorAdmissionReadiness({ ...values,
      allowPrivateNetworkForTesting: true, resolver: localResolver }), /response is too large/);
    mode = "noncanonical";
    await assert.rejects(() => probeValidatorAdmissionReadiness({ ...values,
      allowPrivateNetworkForTesting: true, resolver: localResolver }), /not canonical JSON/);
    mode = "tampered";
    await assert.rejects(() => probeValidatorAdmissionReadiness({ ...values,
      allowPrivateNetworkForTesting: true, resolver: localResolver }), /candidate .*response/);
    mode = "slow";
    await assert.rejects(() => probeValidatorAdmissionReadiness({ ...values,
      allowPrivateNetworkForTesting: true, connectTimeoutMs: 20, resolver: localResolver,
      totalTimeoutMs: 40 }), /timed out/);
    const controller = new AbortController();
    const aborted = probeValidatorAdmissionReadiness({ ...values,
      allowPrivateNetworkForTesting: true, connectTimeoutMs: 100, resolver: localResolver,
      signal: controller.signal, totalTimeoutMs: 1_000 });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(aborted, /was aborted/);
  } finally {
    await close(server); rmSync(temporary, { recursive: true, force: true });
  }
});

test("probe rejects mixed DNS answers and bounds a stalled TLS connect", async () => {
  const publicValues = readinessFixture("https://candidate.example", "a".repeat(64));
  const mixedResolver = (_hostname, _options, callback) => callback(null, [
    { address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 },
  ]);
  await assert.rejects(() => probeValidatorAdmissionReadiness({ ...publicValues,
    resolver: mixedResolver }), /forbidden address/);

  const sockets = new Set();
  const stalled = createTcpServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  });
  try {
    const port = await listen(stalled);
    const values = readinessFixture(`https://localhost:${port}`, "b".repeat(64));
    await assert.rejects(() => probeValidatorAdmissionReadiness({ ...values,
      allowPrivateNetworkForTesting: true, connectTimeoutMs: 20, resolver: localResolver,
      totalTimeoutMs: 200 }), /connect timed out/);
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(stalled);
  }
});

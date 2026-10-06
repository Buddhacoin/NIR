import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DistributedCoordinator,
  initializeDistributedDevnet,
  ValidatorReplica,
} from "../blockchain/distributed-node.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import { certificateSha256, requestJson } from "../blockchain/http-client.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";

test("a mismatched pinned TLS peer receives no request body", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-pinned-tls-no-leak-"));
  let server;
  try {
    const keyPath = join(temporary, "key.pem");
    const certPath = join(temporary, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"],
    { stdio: "ignore" });
    let requests = 0; let receivedBytes = 0;
    server = createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) },
      (request, response) => {
        requests += 1;
        request.on("data", (chunk) => { receivedBytes += chunk.length; });
        request.on("end", () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
        });
      });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `https://127.0.0.1:${server.address().port}/signed`;
    await assert.rejects(() => requestJson(url, {
      body: { signedEnvelope: "must-not-reach-wrong-peer" },
      tlsCertificateSha256: "0".repeat(64),
    }), /certificate pin mismatch/);
    const mutablePins = ["0".repeat(64)];
    const pending = requestJson(url, { body: { signedEnvelope: "no-pin-swap" },
      tlsCertificateSha256Pins: mutablePins });
    mutablePins[0] = certificateSha256(new X509Certificate(readFileSync(certPath)).raw);
    await assert.rejects(pending, /certificate pin mismatch/);
    assert.equal(requests, 0);
    assert.equal(receivedBytes, 0);
  } finally {
    if (server) await close(server);
    rmSync(temporary, { recursive: true, force: true });
  }
});

async function close(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

test("validator HTTPS terminates TLS and enforces its on-chain certificate pin", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-validator-tls-test-"));
  let server;
  try {
    const keyPath = join(temporary, "tls-key.pem");
    const certPath = join(temporary, "tls-cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
    ], { stdio: "ignore" });
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);
    const fingerprint = certificateSha256(new X509Certificate(cert).raw);
    const layout = initializeDistributedDevnet(join(temporary, "network"), {
      tlsCertificateSha256: fingerprint,
    });
    const validator = new ValidatorReplica(layout.validatorDirectories[0]);
    assert.ok(validator.peerUrls.every((url) => url.startsWith("https://")));
    assert.equal(validator.peerTlsCertificateSha256(0), fingerprint);
    server = createValidatorHttpServer(validator, { tls: { cert, key } });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `https://127.0.0.1:${server.address().port}/health`;

    const response = await requestJson(url, { tlsCertificateSha256: fingerprint });
    assert.equal(response.status, 200);
    assert.equal(response.body.address, validator.address);
    await assert.rejects(() => requestJson(url, {
      tlsCertificateSha256: `${fingerprint[0] === "a" ? "b" : "a"}${fingerprint.slice(1)}`,
    }), /certificate pin mismatch/);
    await assert.rejects(() => requestJson("http://127.0.0.1:1/health", {
      tlsCertificateSha256: fingerprint,
    }), /plaintext HTTP/);
    const overlapResponse = await requestJson(url, {
      tlsCertificateSha256Pins: ["f".repeat(64), fingerprint],
    });
    assert.equal(overlapResponse.status, 200);
    await assert.rejects(() => requestJson(url, {
      tlsCertificateSha256Pins: [],
    }), /pin set is invalid/);
    await assert.rejects(() => requestJson(url, {
      tlsCertificateSha256Pins: ["f".repeat(64)],
    }), /certificate pin mismatch/);
  } finally {
    if (server) await close(server);
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("validator refuses an incomplete TLS server configuration", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-validator-tls-config-test-"));
  try {
    const layout = initializeDistributedDevnet(join(temporary, "network"));
    const validator = new ValidatorReplica(layout.validatorDirectories[0]);
    assert.throws(() => createValidatorHttpServer(validator, {
      tls: { cert: "certificate-without-a-key" },
    }), /TLS key and certificate/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("the coordinator finalizes through four certificate-pinned HTTPS validators", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-full-tls-network-test-"));
  const servers = [];
  try {
    const keyPath = join(temporary, "tls-key.pem");
    const certPath = join(temporary, "tls-cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
    ], { stdio: "ignore" });
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);
    const fingerprint = certificateSha256(new X509Certificate(cert).raw);
    const layout = initializeDistributedDevnet(join(temporary, "network"), {
      tlsCertificateSha256: fingerprint,
    });
    const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
    servers.push(...replicas.map((validator) =>
      createValidatorHttpServer(validator, { tls: { cert, key } })));
    const urls = await Promise.all(servers.map((instance) => new Promise((resolve) =>
      instance.listen(0, "127.0.0.1", () =>
        resolve(`https://127.0.0.1:${instance.address().port}`)))));
    const coordinator = new DistributedCoordinator(layout.coordinatorDirectory, urls);
    const funded = await coordinator.faucet(generateWallet().address);
    assert.equal(funded.height, 1);
    assert.ok(replicas.every(({ height }) => height === 1));
  } finally {
    await Promise.all(servers.map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

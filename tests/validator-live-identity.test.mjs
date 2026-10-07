import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet } from "../blockchain/crypto.mjs";
import { initializeDistributedDevnet, ValidatorReplica } from "../blockchain/distributed-node.mjs";
import { certificateSha256, requestJson } from "../blockchain/http-client.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";
import { createValidatorLiveIdentity, probeValidatorLiveIdentity,
  verifyValidatorLiveIdentity } from "../blockchain/validator-live-identity.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `https://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

test("local live identity binds a fresh nonce to ceremony-pinned validator and genesis, not a reused TLS certificate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-validator-live-identity-"));
  const servers = [];
  try {
    const keyPath = join(directory, "key.pem");
    const certPath = join(directory, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"],
    { stdio: "ignore" });
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);
    const pin = certificateSha256(new X509Certificate(cert).raw);
    const nextKeyPath = join(directory, "next-key.pem");
    const nextCertPath = join(directory, "next-cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", nextKeyPath, "-out", nextCertPath, "-days", "1", "-subj", "/CN=localhost"],
    { stdio: "ignore" });
    const nextKey = readFileSync(nextKeyPath);
    const nextCert = readFileSync(nextCertPath);
    const nextPin = certificateSha256(new X509Certificate(nextCert).raw);
    const layout = initializeDistributedDevnet(join(directory, "network"),
      { tlsCertificateSha256: pin });
    const validator = new ValidatorReplica(layout.validatorDirectories[0]);
    const genesisHash = validator.tipHash;
    const trusted = validator.validatorMembers.find(({ address }) => address === validator.address);
    const live = createValidatorHttpServer(validator, { tls: { cert, key } });
    servers.push(live);
    const origin = await listen(live);
    const probe = { chainIdentityGenesisHash: genesisHash, networkId: validator.networkId,
      tlsCertificateSha256: pin, validator: trusted };
    const response = await probeValidatorLiveIdentity({ ...probe, upstreamOrigin: origin });
    assert.equal(response.address, validator.address);
    assert.equal(response.chainIdentityGenesisHash, genesisHash);
    assert.match(response.nonce, /^[0-9a-f]{64}$/);
    assert.throws(() => verifyValidatorLiveIdentity(response, { ...probe, nonce: "b".repeat(64) }),
      /signature or binding/);
    assert.throws(() => verifyValidatorLiveIdentity(response,
      { ...probe, nonce: response.nonce, chainIdentityGenesisHash: "b".repeat(64) }),
      /signature or binding/);
    const malformed = await requestJson(`${origin}/v1/public/validator-live-identity`, {
      body: { nonce: response.nonce, arbitrarySigningInput: "forbidden" },
      tlsCertificateSha256: pin,
    });
    assert.notEqual(malformed.status, 200);
    const invalidNonce = await requestJson(`${origin}/v1/public/validator-live-identity`, {
      body: { nonce: "short" }, tlsCertificateSha256: pin,
    });
    assert.notEqual(invalidNonce.status, 200);
    const coercedNonce = await requestJson(`${origin}/v1/public/validator-live-identity`, {
      body: { nonce: [response.nonce] }, tlsCertificateSha256: pin,
    });
    assert.notEqual(coercedNonce.status, 200);

    live.setSecureContext({ cert: nextCert, key: nextKey, minVersion: "TLSv1.3" });
    const rotated = await probeValidatorLiveIdentity({ ...probe, tlsCertificateSha256: nextPin,
      upstreamOrigin: origin });
    assert.equal(rotated.tlsCertificateSha256, nextPin);
    await assert.rejects(probeValidatorLiveIdentity({ ...probe, upstreamOrigin: origin }),
      /TLS peer certificate pin mismatch/);

    // Same network ID and the exact same TLS certificate are insufficient: the
    // substitute process lacks the validator's consensus signing key.
    const imposter = generateWallet();
    const fake = createHttpsServer({ cert, key }, async (request, reply) => {
      let bytes = "";
      for await (const chunk of request) bytes += chunk;
      const { nonce: requestNonce } = JSON.parse(bytes);
      const forged = createValidatorLiveIdentity({ chainIdentityGenesisHash: genesisHash,
        height: 0, networkId: validator.networkId, nonce: requestNonce, tipHash: genesisHash,
        tlsCertificateSha256: pin, wallet: imposter });
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify(forged));
    });
    servers.push(fake);
    const fakeOrigin = await listen(fake);
    await assert.rejects(probeValidatorLiveIdentity({ ...probe, upstreamOrigin: fakeOrigin }),
      /signature or binding/);
    // Replaying a valid answer from the genuine node cannot satisfy a new challenge.
    const replay = createHttpsServer({ cert, key }, (_request, reply) => {
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify(response));
    });
    servers.push(replay);
    const replayOrigin = await listen(replay);
    await assert.rejects(probeValidatorLiveIdentity({ ...probe, upstreamOrigin: replayOrigin }),
      /signature or binding/);
  } finally {
    await Promise.all(servers.map(close));
    rmSync(directory, { recursive: true, force: true });
  }
});

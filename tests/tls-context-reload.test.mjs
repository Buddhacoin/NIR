import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCertificateRecord,
  EMPTY_CERTIFICATE_RECORD_HASH,
  topologyHistoryCommitment,
} from "../blockchain/certificate-lifecycle.mjs";
import { installCertificateRecord } from "../blockchain/certificate-lifecycle-store.mjs";
import { CERTIFICATE_MODE_LIFECYCLE } from "../blockchain/certificate-runtime.mjs";
import {
  DistributedCoordinator,
  initializeDistributedDevnet,
  ValidatorReplica,
} from "../blockchain/distributed-node.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import { certificateSha256, requestJson } from "../blockchain/http-client.mjs";
import { peerRegistryHash } from "../blockchain/peer-registry.mjs";
import { installValidatorTlsReloader } from "../blockchain/tls-context-reload.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";

async function close(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

function certificate(directory, name) {
  const keyPath = join(directory, `${name}-key.pem`);
  const certPath = join(directory, `${name}-cert.pem`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
  ], { stdio: "ignore" });
  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);
  return {
    cert,
    certPath,
    fingerprint: certificateSha256(new X509Certificate(cert).raw),
    key,
    keyPath,
  };
}

function fixture(root, operation) {
  const layout = initializeDistributedDevnet(join(root, "network"));
  const genesis = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "genesis.json")));
  const wallets = layout.validatorDirectories.map((directory) =>
    JSON.parse(readFileSync(join(directory, "VALIDATOR-KEY.json"))));
  const oldCertificates = wallets.map((_, index) => certificate(root, `old-${index}`));
  const nextCertificate = operation === "renew" ? certificate(root, "new-0") : null;
  const topologyHash = topologyHistoryCommitment();
  const context = {
    currentHeight: 0,
    minimumActivationDelay: 0,
    networkId: genesis.networkId,
    peerRegistryHash: peerRegistryHash(genesis.peerRegistry),
    topologyHistoryHash: topologyHash,
    validators: genesis.validators,
  };
  const issues = wallets.map((wallet, index) => createCertificateRecord({
    activationHeight: 0,
    certificate: {
      serial: (0x10 + index).toString(16),
      sha256: oldCertificates[index].fingerprint,
    },
    networkId: genesis.networkId,
    operation: "issue",
    overlapUntilHeight: 0,
    peerRegistryHash: context.peerRegistryHash,
    previousRecordHash: EMPTY_CERTIFICATE_RECORD_HASH,
    sequence: 0,
    topologyHistoryHash: topologyHash,
    validatorAddress: wallet.address,
  }, wallets.slice(0, 3)));
  const transition = createCertificateRecord({
    activationHeight: 1,
    certificate: operation === "renew"
      ? { serial: "20", sha256: nextCertificate.fingerprint }
      : null,
    networkId: genesis.networkId,
    operation,
    overlapUntilHeight: operation === "renew" ? 2 : 1,
    peerRegistryHash: context.peerRegistryHash,
    previousRecordHash: issues[0].recordHash,
    sequence: 1,
    topologyHistoryHash: topologyHash,
    validatorAddress: wallets[0].address,
  }, wallets.slice(0, 3));
  const history = [...issues, transition];
  for (const directory of [layout.coordinatorDirectory, ...layout.validatorDirectories]) {
    for (const record of history) {
      installCertificateRecord(join(directory, "certificates"), record, context);
    }
  }
  return { genesis, layout, nextCertificate, oldCertificates };
}

async function start(values) {
  const replicas = values.layout.validatorDirectories.map((directory) =>
    new ValidatorReplica(directory, { certificateMode: CERTIFICATE_MODE_LIFECYCLE }));
  const urls = [];
  const servers = replicas.map((replica, index) => createValidatorHttpServer(replica, {
    peerUrls: () => urls,
    tls: values.oldCertificates[index],
  }));
  for (const server of servers) {
    urls.push(await new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
      resolve(`https://127.0.0.1:${server.address().port}`))));
  }
  return { replicas, servers, urls };
}

test("SIGHUP rotates to an active overlap certificate and failures retain the old context", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-tls-reload-overlap-"));
  let running;
  let control;
  try {
    const values = fixture(root, "renew");
    const wrong = certificate(root, "wrong-key");
    const reloadCertPath = join(root, "reload-cert.pem");
    const reloadKeyPath = join(root, "reload-key.pem");
    writeFileSync(reloadCertPath, values.nextCertificate.cert, { mode: 0o600 });
    writeFileSync(reloadKeyPath, values.nextCertificate.key, { mode: 0o600 });
    running = await start(values);
    const messages = [];
    const signals = new EventEmitter();
    assert.throws(() => installValidatorTlsReloader({
      certPath: reloadCertPath,
      keyPath: reloadKeyPath,
      server: running.servers[0],
      signalTarget: signals,
      validator: new ValidatorReplica(values.layout.validatorDirectories[0]),
    }), /only in lifecycle mode/);
    control = installValidatorTlsReloader({
      certPath: reloadCertPath,
      keyPath: reloadKeyPath,
      logger: (message) => messages.push(message),
      server: running.servers[0],
      signalTarget: signals,
      validator: running.replicas[0],
    });
    assert.throws(() => control.reload(), /not active/);
    assert.match(messages.at(-1), /reload failed.*not active/i);
    assert.equal((await requestJson(`${running.urls[0]}/health`, {
      tlsCertificateSha256: values.oldCertificates[0].fingerprint,
    })).status, 200);

    const coordinator = new DistributedCoordinator(
      values.layout.coordinatorDirectory, running.urls,
      { certificateMode: CERTIFICATE_MODE_LIFECYCLE },
    );
    assert.equal((await coordinator.faucet(generateWallet().address)).height, 1);

    writeFileSync(reloadKeyPath, wrong.key, { mode: 0o600 });
    assert.throws(() => control.reload(), /does not match/);
    assert.equal((await requestJson(`${running.urls[0]}/health`, {
      tlsCertificateSha256: values.oldCertificates[0].fingerprint,
    })).status, 200);

    writeFileSync(reloadKeyPath, values.nextCertificate.key, { mode: 0o600 });
    signals.emit("SIGHUP");
    assert.match(messages.at(-1), /reload succeeded/i);
    assert.equal((await requestJson(`${running.urls[0]}/health`, {
      tlsCertificateSha256: values.nextCertificate.fingerprint,
    })).status, 200);
    await assert.rejects(() => requestJson(`${running.urls[0]}/health`, {
      tlsCertificateSha256: values.oldCertificates[0].fingerprint,
    }), /certificate pin mismatch/);
  } finally {
    control?.close();
    if (running) await Promise.all(running.servers.map(close));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a revoked lifecycle certificate cannot be reloaded and the old context is retained", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-tls-reload-revoke-"));
  let running;
  let control;
  try {
    const values = fixture(root, "revoke");
    running = await start(values);
    const coordinator = new DistributedCoordinator(
      values.layout.coordinatorDirectory, running.urls,
      { certificateMode: CERTIFICATE_MODE_LIFECYCLE },
    );
    assert.equal((await coordinator.faucet(generateWallet().address)).height, 1);
    if (running.replicas[0].height === 0) {
      assert.equal((await requestJson(`${running.urls[0]}/v1/sync`, {
        method: "POST",
        tlsCertificateSha256: values.oldCertificates[0].fingerprint,
      })).status, 200);
    }
    assert.equal(running.replicas[0].height, 1);
    const messages = [];
    control = installValidatorTlsReloader({
      certPath: values.oldCertificates[0].certPath,
      keyPath: values.oldCertificates[0].keyPath,
      logger: (message) => messages.push(message),
      server: running.servers[0],
      signalTarget: new EventEmitter(),
      validator: running.replicas[0],
    });
    assert.throws(() => control.reload(), /no active|not active/);
    assert.match(messages.at(-1), /reload failed/i);
    assert.equal((await requestJson(`${running.urls[0]}/health`, {
      tlsCertificateSha256: values.oldCertificates[0].fingerprint,
    })).status, 200);
  } finally {
    control?.close();
    if (running) await Promise.all(running.servers.map(close));
    rmSync(root, { recursive: true, force: true });
  }
});

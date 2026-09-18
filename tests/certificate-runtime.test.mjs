import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCertificateRecord,
  EMPTY_CERTIFICATE_RECORD_HASH,
  topologyHistoryCommitment,
} from "../blockchain/certificate-lifecycle.mjs";
import { installCertificateRecord } from "../blockchain/certificate-lifecycle-store.mjs";
import {
  CERTIFICATE_MODE_LIFECYCLE,
  RuntimeCertificatePins,
} from "../blockchain/certificate-runtime.mjs";
import {
  DistributedCoordinator,
  initializeDistributedDevnet,
  ValidatorReplica,
} from "../blockchain/distributed-node.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import { certificateSha256, requestJson } from "../blockchain/http-client.mjs";
import { peerRegistryHash } from "../blockchain/peer-registry.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";

async function close(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

function certificates(directory, count, prefix) {
  return Array.from({ length: count }, (_, index) => {
    const keyPath = join(directory, `${prefix}-${index}-key.pem`);
    const certPath = join(directory, `${prefix}-${index}-cert.pem`);
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
    ], { stdio: "ignore" });
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);
    return { cert, fingerprint: certificateSha256(new X509Certificate(cert).raw), key };
  });
}

function lifecycleFixture(root, operation = "renew") {
  const layout = initializeDistributedDevnet(join(root, "network"));
  const genesis = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "genesis.json")));
  const wallets = layout.validatorDirectories.map((directory) =>
    JSON.parse(readFileSync(join(directory, "VALIDATOR-KEY.json"))));
  const oldCertificates = certificates(root, 4, "old");
  const newCertificates = operation === "renew" ? certificates(root, 4, "new") : [];
  const topologyHash = topologyHistoryCommitment();
  const context = {
    currentHeight: 0,
    minimumActivationDelay: 0,
    networkId: genesis.networkId,
    peerRegistryHash: peerRegistryHash(genesis.peerRegistry),
    topologyHistoryHash: topologyHash,
    validators: genesis.validators,
  };
  const issuedRecords = [];
  const followupRecords = [];
  for (let index = 0; index < wallets.length; index += 1) {
    const issued = createCertificateRecord({
      activationHeight: 0,
      certificate: { serial: (0x10 + index).toString(16), sha256: oldCertificates[index].fingerprint },
      networkId: genesis.networkId,
      operation: "issue",
      overlapUntilHeight: 0,
      peerRegistryHash: context.peerRegistryHash,
      previousRecordHash: EMPTY_CERTIFICATE_RECORD_HASH,
      sequence: 0,
      topologyHistoryHash: topologyHash,
      validatorAddress: wallets[index].address,
    }, wallets.slice(0, 3));
    issuedRecords.push(issued);
    if (operation === "renew") {
      followupRecords.push(createCertificateRecord({
        activationHeight: 1,
        certificate: {
          serial: (0x20 + index).toString(16),
          sha256: newCertificates[index].fingerprint,
        },
        networkId: genesis.networkId,
        operation: "renew",
        overlapUntilHeight: 2,
        peerRegistryHash: context.peerRegistryHash,
        previousRecordHash: issued.recordHash,
        sequence: 1,
        topologyHistoryHash: topologyHash,
        validatorAddress: wallets[index].address,
      }, wallets.slice(0, 3)));
    } else if (operation === "revoke") {
      followupRecords.push(createCertificateRecord({
        activationHeight: 1,
        certificate: null,
        networkId: genesis.networkId,
        operation: "revoke",
        overlapUntilHeight: 1,
        peerRegistryHash: context.peerRegistryHash,
        previousRecordHash: issued.recordHash,
        sequence: 1,
        topologyHistoryHash: topologyHash,
        validatorAddress: wallets[index].address,
      }, wallets.slice(0, 3)));
    }
  }
  const records = [...issuedRecords, ...followupRecords];
  const install = (directory, history = records) => {
    for (const record of history) {
      installCertificateRecord(join(directory, "certificates"), record, context);
    }
  };
  return {
    context, genesis, install, issuedRecords, layout, newCertificates, oldCertificates, records,
  };
}

async function startValidators(layout, certificateSet, optionsFor = () => ({})) {
  const replicas = layout.validatorDirectories.map((directory, index) =>
    new ValidatorReplica(directory, optionsFor(directory, index)));
  const urls = [];
  const servers = replicas.map((replica, index) => createValidatorHttpServer(replica, {
    peerUrls: () => urls,
    tls: certificateSet[index],
  }));
  for (const server of servers) {
    urls.push(await new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
      resolve(`https://127.0.0.1:${server.address().port}`))));
  }
  return { replicas, servers, urls };
}

test("coordinator runtime reloads renewal history across restart and drops the old pin", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-certificate-runtime-renew-"));
  const servers = [];
  try {
    const values = lifecycleFixture(root, "renew");
    values.install(values.layout.coordinatorDirectory);
    const running = await startValidators(values.layout, values.oldCertificates);
    servers.push(...running.servers);
    let coordinator = new DistributedCoordinator(
      values.layout.coordinatorDirectory, running.urls,
      { certificateMode: CERTIFICATE_MODE_LIFECYCLE },
    );
    assert.equal((await coordinator.faucet(generateWallet().address)).height, 1);
    const overlapPins = new RuntimeCertificatePins(
      values.layout.coordinatorDirectory, values.genesis,
      { mode: CERTIFICATE_MODE_LIFECYCLE },
    ).pinsFor(values.genesis.validators[0].address, 1);
    assert.deepEqual(overlapPins, [
      values.newCertificates[0].fingerprint,
      values.oldCertificates[0].fingerprint,
    ]);

    coordinator = new DistributedCoordinator(
      values.layout.coordinatorDirectory, running.urls,
      { certificateMode: CERTIFICATE_MODE_LIFECYCLE },
    );
    assert.equal((await coordinator.faucet(generateWallet().address)).height, 2);
    assert.equal((await coordinator.faucet(generateWallet().address)).height, 3);
    await assert.rejects(() => coordinator.faucet(generateWallet().address),
      /durability quorum|active lifecycle|certificate pin mismatch/);

    const ports = running.servers.map((server) => server.address().port);
    await Promise.all(running.servers.map(close));
    const restartedReplicas = values.layout.validatorDirectories.map((directory) =>
      new ValidatorReplica(directory));
    const renewedServers = restartedReplicas.map((replica, index) =>
      createValidatorHttpServer(replica, { tls: values.newCertificates[index] }));
    servers.push(...renewedServers);
    await Promise.all(renewedServers.map((server, index) => new Promise((resolve) =>
      server.listen(ports[index], "127.0.0.1", resolve))));
    const runtimePins = new RuntimeCertificatePins(
      values.layout.coordinatorDirectory, values.genesis,
      { mode: CERTIFICATE_MODE_LIFECYCLE },
    );
    for (let index = 0; index < running.urls.length; index += 1) {
      const health = await requestJson(`${running.urls[index]}/health`, {
        tlsCertificateSha256Pins: runtimePins.pinsFor(
          values.genesis.validators[index].address, 3,
        ),
      });
      assert.equal(health.status, 200);
    }
  } finally {
    await Promise.all(servers.map(close));
    rmSync(root, { recursive: true, force: true });
  }
});

test("coordinator runtime fails closed after lifecycle revocation and without lifecycle state", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-certificate-runtime-revoke-"));
  const servers = [];
  try {
    const values = lifecycleFixture(root, "revoke");
    const running = await startValidators(values.layout, values.oldCertificates);
    servers.push(...running.servers);
    const missingPins = new RuntimeCertificatePins(
      values.layout.coordinatorDirectory, values.genesis,
      { mode: CERTIFICATE_MODE_LIFECYCLE },
    );
    assert.throws(() => missingPins.pinsFor(values.genesis.validators[0].address, 0),
      /active lifecycle/);
    await assert.rejects(() => new DistributedCoordinator(
      values.layout.coordinatorDirectory, running.urls,
      { certificateMode: CERTIFICATE_MODE_LIFECYCLE },
    ).faucet(generateWallet().address), /active lifecycle|durability quorum/);

    values.install(values.layout.coordinatorDirectory);
    let coordinator = new DistributedCoordinator(
      values.layout.coordinatorDirectory, running.urls,
      { certificateMode: CERTIFICATE_MODE_LIFECYCLE },
    );
    assert.equal((await coordinator.faucet(generateWallet().address)).height, 1);
    const revokedPins = new RuntimeCertificatePins(
      values.layout.coordinatorDirectory, values.genesis,
      { mode: CERTIFICATE_MODE_LIFECYCLE },
    );
    assert.throws(() => revokedPins.pinsFor(values.genesis.validators[0].address, 1),
      /active lifecycle/);
    coordinator = new DistributedCoordinator(
      values.layout.coordinatorDirectory, running.urls,
      { certificateMode: CERTIFICATE_MODE_LIFECYCLE },
    );
    await assert.rejects(() => coordinator.faucet(generateWallet().address),
      /active lifecycle|durability quorum/);
  } finally {
    await Promise.all(servers.map(close));
    rmSync(root, { recursive: true, force: true });
  }
});

test("validator P2P synchronization uses lifecycle pins on the live request path", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-certificate-runtime-validator-"));
  const servers = [];
  try {
    const values = lifecycleFixture(root, "issue");
    for (const directory of values.layout.validatorDirectories) values.install(directory);
    const running = await startValidators(values.layout, values.oldCertificates, () => ({
      certificateMode: CERTIFICATE_MODE_LIFECYCLE,
    }));
    servers.push(...running.servers);
    const response = await requestJson(`${running.urls[0]}/v1/sync`, {
      method: "POST",
      tlsCertificateSha256: values.oldCertificates[0].fingerprint,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.height, 0);
    const health = await requestJson(`${running.urls[0]}/health`, {
      tlsCertificateSha256: values.oldCertificates[0].fingerprint,
    });
    assert.equal(health.body.certificateMode, CERTIFICATE_MODE_LIFECYCLE);

    const restarted = new ValidatorReplica(values.layout.validatorDirectories[0], {
      certificateMode: CERTIFICATE_MODE_LIFECYCLE,
    });
    assert.deepEqual(restarted.peerTlsCertificateSha256Pins(1), [
      values.oldCertificates[1].fingerprint,
    ]);
  } finally {
    await Promise.all(servers.map(close));
    rmSync(root, { recursive: true, force: true });
  }
});

test("validator P2P propagates a quorum renewal history atomically and survives restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-certificate-propagation-"));
  const servers = [];
  try {
    const values = lifecycleFixture(root, "renew");
    values.install(values.layout.validatorDirectories[0], values.issuedRecords);
    for (const directory of values.layout.validatorDirectories.slice(1)) {
      values.install(directory);
    }
    const running = await startValidators(values.layout, values.oldCertificates, () => ({
      certificateMode: CERTIFICATE_MODE_LIFECYCLE,
    }));
    servers.push(...running.servers);
    const response = await requestJson(`${running.urls[0]}/v1/sync`, {
      method: "POST",
      tlsCertificateSha256: values.oldCertificates[0].fingerprint,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.certificateHistoryStatus, "installed");
    assert.equal(response.body.synchronizedCertificateRecords, values.records.length);

    const restarted = new ValidatorReplica(values.layout.validatorDirectories[0], {
      certificateMode: CERTIFICATE_MODE_LIFECYCLE,
    });
    assert.equal(restarted.certificateLifecycleHistory().length, values.records.length);
    const pins = new RuntimeCertificatePins(
      values.layout.validatorDirectories[0], values.genesis,
      { mode: CERTIFICATE_MODE_LIFECYCLE },
    ).pinsFor(values.genesis.validators[1].address, 1);
    assert.deepEqual(pins, [
      values.newCertificates[1].fingerprint,
      values.oldCertificates[1].fingerprint,
    ]);
  } finally {
    await Promise.all(servers.map(close));
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bootstrapCertificateLifecycle,
  certificateBootstrapMarkerPath,
} from "../blockchain/certificate-bootstrap.mjs";
import {
  createCertificateRecord,
  EMPTY_CERTIFICATE_RECORD_HASH,
  topologyHistoryCommitment,
} from "../blockchain/certificate-lifecycle.mjs";
import {
  certificateStorePaths,
  installCertificateHistory,
  installCertificateRecord,
  loadCertificateHistory,
} from "../blockchain/certificate-lifecycle-store.mjs";
import { CERTIFICATE_MODE_LIFECYCLE } from "../blockchain/certificate-runtime.mjs";
import {
  initializeDistributedDevnet,
  ValidatorReplica,
} from "../blockchain/distributed-node.mjs";
import { certificateSha256 } from "../blockchain/http-client.mjs";
import { peerRegistryHash } from "../blockchain/peer-registry.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";

async function close(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

function tlsIdentity(directory, name) {
  const keyPath = join(directory, `${name}-key.pem`);
  const certPath = join(directory, `${name}-cert.pem`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
  ], { stdio: "ignore" });
  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);
  return { cert, fingerprint: certificateSha256(new X509Certificate(cert).raw), key };
}

function fixture(root) {
  const tls = tlsIdentity(root, "genesis");
  const layout = initializeDistributedDevnet(join(root, "network"), {
    tlsCertificateSha256: tls.fingerprint,
  });
  const clientDirectory = join(root, "bootstrap-client");
  cpSync(layout.validatorDirectories[0], clientDirectory, { recursive: true });
  const genesis = JSON.parse(readFileSync(join(clientDirectory, "genesis.json")));
  const wallets = layout.validatorDirectories.map((directory) =>
    JSON.parse(readFileSync(join(directory, "VALIDATOR-KEY.json"))));
  const topologyHash = topologyHistoryCommitment();
  const registryHash = peerRegistryHash(genesis.peerRegistry);
  const context = {
    networkId: genesis.networkId,
    peerRegistryHash: registryHash,
    topologyHistoryHash: topologyHash,
    validators: genesis.validators,
  };
  const issues = wallets.map((wallet, index) => createCertificateRecord({
    activationHeight: 0,
    certificate: {
      serial: (0x10 + index).toString(16),
      sha256: `${index + 1}`.repeat(64),
    },
    networkId: genesis.networkId,
    operation: "issue",
    overlapUntilHeight: 0,
    peerRegistryHash: registryHash,
    previousRecordHash: EMPTY_CERTIFICATE_RECORD_HASH,
    sequence: 0,
    topologyHistoryHash: topologyHash,
    validatorAddress: wallet.address,
  }, wallets.slice(0, 3)));
  const renewal = (digit) => createCertificateRecord({
    activationHeight: 1,
    certificate: { serial: digit === "a" ? "20" : "21", sha256: digit.repeat(64) },
    networkId: genesis.networkId,
    operation: "renew",
    overlapUntilHeight: 2,
    peerRegistryHash: registryHash,
    previousRecordHash: issues[0].recordHash,
    sequence: 1,
    topologyHistoryHash: topologyHash,
    validatorAddress: wallets[0].address,
  }, wallets.slice(0, 3));
  return {
    clientDirectory,
    context,
    histories: { a: [...issues, renewal("a")], b: [...issues, renewal("b")] },
    issues,
    layout,
    tls,
  };
}

function install(directory, history, context) {
  for (const record of history) {
    installCertificateRecord(join(directory, "certificates"), record, {
      ...context,
      currentHeight: 0,
      minimumActivationDelay: 0,
    });
  }
}

async function startPeers(values, histories, tls = values.tls) {
  values.layout.validatorDirectories.forEach((directory, index) =>
    install(directory, histories[index], values.context));
  const replicas = values.layout.validatorDirectories.map((directory) =>
    new ValidatorReplica(directory, { certificateMode: CERTIFICATE_MODE_LIFECYCLE }));
  const urls = [];
  const servers = replicas.map((replica) => createValidatorHttpServer(replica, {
    peerUrls: () => urls,
    tls,
  }));
  for (const server of servers) {
    urls.push(await new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
      resolve(`https://127.0.0.1:${server.address().port}`))));
  }
  return { replicas, servers, urls };
}

test("one-time bootstrap installs a quorum head, repairs restart, and forbids reuse", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-certificate-bootstrap-"));
  let running;
  try {
    const values = fixture(root);
    running = await startPeers(values, Array(4).fill(values.histories.a));
    const result = await bootstrapCertificateLifecycle(values.clientDirectory, running.urls);
    assert.equal(result.records, values.histories.a.length);
    assert.equal(result.matchingSources.length, 4);
    assert.equal(existsSync(certificateBootstrapMarkerPath(values.clientDirectory)), true);

    const storeDirectory = join(values.clientDirectory, "certificates");
    assert.throws(() => installCertificateHistory(
      storeDirectory, values.issues, values.context,
    ), /roll back/);
    const paths = certificateStorePaths(storeDirectory);
    writeFileSync(paths.primary, "{interrupted", { mode: 0o600 });
    const restarted = new ValidatorReplica(values.clientDirectory, {
      certificateMode: CERTIFICATE_MODE_LIFECYCLE,
    });
    assert.equal(restarted.certificateLifecycleHistory().length, values.histories.a.length);
    assert.equal(loadCertificateHistory(storeDirectory, values.context).recoveredCopies, 0);
    await assert.rejects(
      () => bootstrapCertificateLifecycle(values.clientDirectory, running.urls),
      /already used|store already exists/,
    );

    rmSync(paths.primary);
    rmSync(paths.backup);
    assert.throws(() => restarted.peerTlsCertificateSha256Pins(1),
      /active lifecycle|all certificate/);
    await assert.rejects(
      () => bootstrapCertificateLifecycle(values.clientDirectory, running.urls),
      /already used/,
    );
  } finally {
    if (running) await Promise.all(running.servers.map(close));
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap rejects a 2/2 split without writing a store", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-certificate-bootstrap-split-"));
  let running;
  try {
    const values = fixture(root);
    running = await startPeers(values, [
      values.histories.a, values.histories.a, values.histories.b, values.histories.b,
    ]);
    await assert.rejects(
      () => bootstrapCertificateLifecycle(values.clientDirectory, running.urls), /quorum/,
    );
    const paths = certificateStorePaths(join(values.clientDirectory, "certificates"));
    assert.equal(existsSync(paths.primary) || existsSync(paths.backup), false);
    assert.equal(existsSync(certificateBootstrapMarkerPath(values.clientDirectory)), false);
  } finally {
    if (running) await Promise.all(running.servers.map(close));
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap ignores a forged history but still requires three authenticated peers", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-certificate-bootstrap-forged-"));
  let running;
  try {
    const values = fixture(root);
    running = await startPeers(values, Array(4).fill(values.histories.a));
    const forged = structuredClone(values.histories.a);
    forged.at(-1).recordHash = "f".repeat(64);
    running.replicas[3].certificateLifecycleHistory = () => forged;
    const result = await bootstrapCertificateLifecycle(values.clientDirectory, running.urls);
    assert.equal(result.matchingSources.length, 3);
    assert.equal(result.records, values.histories.a.length);
  } finally {
    if (running) await Promise.all(running.servers.map(close));
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap cannot bypass a wrong genesis TLS pin", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-certificate-bootstrap-pin-"));
  let running;
  try {
    const values = fixture(root);
    const wrongTls = tlsIdentity(root, "wrong");
    running = await startPeers(values, Array(4).fill(values.histories.a), wrongTls);
    await assert.rejects(
      () => bootstrapCertificateLifecycle(values.clientDirectory, running.urls), /quorum/,
    );
    assert.equal(existsSync(certificateBootstrapMarkerPath(values.clientDirectory)), false);
  } finally {
    if (running) await Promise.all(running.servers.map(close));
    rmSync(root, { recursive: true, force: true });
  }
});

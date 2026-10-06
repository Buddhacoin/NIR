import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../blockchain/crypto.mjs";
import { VALIDATOR_ADMISSION_READINESS_CHALLENGE_PATH }
  from "../blockchain/validator-admission-readiness-service.mjs";
import { encryptWallet } from "../blockchain/vault.mjs";
import { createValidatorReadinessProcessBootstrapSet }
  from "../blockchain/validator-readiness-process-protocol.mjs";
import { createValidatorReadinessRuntimeLaunchEnvelope }
  from "../blockchain/validator-readiness-runtime-protocol.mjs";
import { createValidatorReadinessGatewayChildInput }
  from "../blockchain/validator-readiness-gateway-child-protocol.mjs";
import { createValidatorReadinessSignerChildInput }
  from "../blockchain/validator-readiness-signer-child-protocol.mjs";
import { launchValidatorReadinessThreeProcess }
  from "../blockchain/validator-readiness-three-process-launcher.mjs";
import { validatorReadinessSignerFixture } from "./validator-readiness-signer-fixture.mjs";

const directory = mkdtempSync(join(tmpdir(), "nir-three-process-launcher-"));
const keyPath = join(directory, "tls-key.pem");
const certPath = join(directory, "tls-cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"],
{ stdio: "ignore" });
const key = readFileSync(keyPath); const certificate = readFileSync(certPath);
const certificateHash = createHash("sha256")
  .update(new X509Certificate(certificate).raw).digest("hex");
after(() => rmSync(directory, { force: true, recursive: true }));

function limit(promise, label, milliseconds = 15_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
async function listener() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, fd: server._handle.fd };
}
function pins(values, role, bootstrap) {
  return { expectedBootstrapHash: bootstrap.bootstrapHash,
    expectedLauncherNonce: values.launcherNonce,
    expectedReleaseProvenanceHash: values.session.releaseProvenanceHash,
    expectedRole: role, expectedSessionHash: values.session.sessionHash };
}
function input(port, fd) {
  const now = Date.now();
  const values = validatorReadinessSignerFixture({ now,
    endpoint: `https://127.0.0.1:${port}`, tlsCertificateSha256: certificateHash });
  const consensusPasswordText = "three-process-consensus-password";
  const transportPasswordText = "three-process-transport-password";
  const consensusVault = encryptWallet(values.candidate, consensusPasswordText,
    { label: "Three-process consensus" });
  const transportVault = encryptWallet(values.transport, transportPasswordText,
    { label: "Three-process transport" });
  const bootstraps = createValidatorReadinessProcessBootstrapSet({ consensusVault,
    gatewayRolePackage: values.gatewayRolePackage,
    initialHeight: values.context.checkpoint.height, tlsCertificateSha256: certificateHash,
    transportVault }, { now });
  Object.assign(values, bootstraps);
  const cohortBootstraps = { consensus: values.consensusSignerBootstrap,
    gateway: values.gatewayBootstrap, transport: values.transportSignerBootstrap };
  const signerInputs = {};
  for (const [role, bootstrap, encryptedVault] of [
    ["consensus", values.consensusSignerBootstrap, consensusVault],
    ["transport", values.transportSignerBootstrap, transportVault],
  ]) {
    const expected = pins(values, role, bootstrap);
    const launchEnvelope = createValidatorReadinessRuntimeLaunchEnvelope({ bootstrap }, expected,
      { encryptedVault, now });
    signerInputs[role] = createValidatorReadinessSignerChildInput({ cohortBootstraps,
      encryptedVault, launchEnvelope }, expected, { now });
  }
  const gatewayPins = { expectedBootstrapHash: values.gatewayBootstrap.bootstrapHash,
    expectedBoundHost: "127.0.0.1", expectedBoundPort: port,
    expectedLauncherNonce: values.launcherNonce,
    expectedReleaseProvenanceHash: values.session.releaseProvenanceHash,
    expectedSessionHash: values.session.sessionHash };
  const launchEnvelope = createValidatorReadinessRuntimeLaunchEnvelope({
    bootstrap: values.gatewayBootstrap,
    consensusSignerBootstrap: values.consensusSignerBootstrap,
    transportSignerBootstrap: values.transportSignerBootstrap,
  }, pins(values, "gateway", values.gatewayBootstrap), { now });
  const gatewayInput = createValidatorReadinessGatewayChildInput({ cohortBootstraps,
    launchEnvelope }, gatewayPins, { now });
  return { values, options: { consensusInput: signerInputs.consensus,
    consensusPasswordBuffer: Buffer.from(consensusPasswordText), gatewayInput,
    listenerFd: fd, tlsCertificateBuffer: Buffer.from(certificate),
    tlsKeyBuffer: Buffer.from(key), transportInput: signerInputs.transport,
    transportPasswordBuffer: Buffer.from(transportPasswordText), trustedPins: {
      expectedBoundHost: "127.0.0.1", expectedBoundPort: port,
      expectedConsensusBootstrapHash: values.consensusSignerBootstrap.bootstrapHash,
      expectedGatewayBootstrapHash: values.gatewayBootstrap.bootstrapHash,
      expectedLauncherNonce: values.launcherNonce,
      expectedReleaseProvenanceHash: values.session.releaseProvenanceHash,
      expectedSessionHash: values.session.sessionHash,
      expectedTlsCertificateSha256: certificateHash,
      expectedTransportBootstrapHash: values.transportSignerBootstrap.bootstrapHash,
    } } };
}
function request(values) {
  const body = Buffer.from(canonicalJson({ challenge: values.challenge,
    context: values.context }));
  return limit(new Promise((resolve, reject) => {
    const outgoing = httpsRequest(new URL(VALIDATOR_ADMISSION_READINESS_CHALLENGE_PATH,
      values.context.endpoint), { method: "POST", rejectUnauthorized: false,
      minVersion: "TLSv1.3", headers: { "content-length": String(body.length),
        "content-type": "application/json" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks)) }));
    });
    outgoing.on("error", reject); outgoing.end(body);
  }), "readiness HTTPS response");
}

test("launcher activates one real three-process cohort and closes it atomically", async () => {
  const reservation = await listener();
  const { options, values } = input(reservation.port, reservation.fd);
  const launch = launchValidatorReadinessThreeProcess(options);
  await new Promise((resolve) => reservation.server.close(resolve));
  const cohort = await limit(launch, "three-process launch");
  try {
    assert.equal(cohort.state(), "active");
    assert.equal(cohort.productionActivated, true);
    assert.deepEqual(Object.keys(cohort).sort(), ["activeAcknowledgement", "close", "endpoint", "pids",
      "productionActivated", "readiness", "state", "updateHeight", "waitForTermination"]);
    assert.equal(cohort.activeAcknowledgement.messageType, "active-ack");
    assert.ok(Object.isFrozen(cohort.activeAcknowledgement));
    assert.equal((await request(values)).status, 200);
    const updated = await cohort.updateHeight(values.context.checkpoint.height + 1);
    assert.equal(updated.consensus.messageType, "height-ack");
    assert.equal(updated.transport.messageType, "height-ack");
    assert.equal(options.consensusPasswordBuffer.every((byte) => byte === 0), true);
    assert.equal(options.tlsKeyBuffer.every((byte) => byte === 0), true);
  } finally {
    const first = cohort.close();
    assert.strictEqual(cohort.close(), first);
    await first;
  }
  assert.deepEqual(await cohort.waitForTermination(), { reason: "closed" });
  await assert.rejects(() => request(values));
});

test("separate OS process hands a listening socket to the readiness launcher", {
  skip: process.env.NIR_TEST_INHERITED_FD !== undefined,
}, () => {
  execFileSync("python3", [fileURLToPath(new URL(
    "./validator-readiness-socket-activation-fixture.py", import.meta.url)),
  process.execPath, fileURLToPath(import.meta.url)], { timeout: 40_000 });
});

test("OS-inherited listener activates the exact three-process cohort", {
  skip: process.env.NIR_TEST_INHERITED_FD === undefined,
}, async () => {
  const fd = Number(process.env.NIR_TEST_INHERITED_FD);
  const port = Number(process.env.NIR_TEST_INHERITED_PORT);
  assert.ok(Number.isSafeInteger(fd) && fd >= 3);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536);
  const { options, values } = input(port, fd);
  const cohort = await limit(launchValidatorReadinessThreeProcess(options),
    "OS-inherited three-process launch");
  try {
    assert.equal(cohort.state(), "active");
    assert.equal(cohort.endpoint.port, port);
    assert.equal(cohort.activeAcknowledgement.messageType, "active-ack");
    assert.equal((await request(values)).status, 200);
  } finally { await cohort.close(); }
  assert.deepEqual(await cohort.waitForTermination(), { reason: "closed" });
  await assert.rejects(() => request(values));
});

test("bad signer password fails the whole launch without keeping secrets", async () => {
  const reservation = await listener();
  const { options } = input(reservation.port, reservation.fd);
  options.transportPasswordBuffer.fill(0x78);
  const launch = launchValidatorReadinessThreeProcess(options);
  await new Promise((resolve) => reservation.server.close(resolve));
  await assert.rejects(limit(launch, "bad-password launch"), /three-process launch failed/);
  for (const key of ["consensusPasswordBuffer", "transportPasswordBuffer",
    "tlsKeyBuffer", "tlsCertificateBuffer"]) {
    assert.equal(options[key].every((byte) => byte === 0), true, key);
  }
});

test("caller mutations after invocation cannot alter retained cohort inputs", async () => {
  const reservation = await listener();
  const { options } = input(reservation.port, reservation.fd);
  const launch = launchValidatorReadinessThreeProcess(options);
  options.consensusInput.expectedSessionHash = `sha3-256:${"0".repeat(64)}`;
  options.gatewayInput.expectedBoundPort += 1;
  options.tlsKeyBuffer.fill(0x78);
  await new Promise((resolve) => reservation.server.close(resolve));
  const cohort = await limit(launch, "owned-input launch");
  assert.equal(cohort.endpoint.port, reservation.port);
  await cohort.close();
});

test("overlapping secret buffers and expanded process options fail before spawn", async () => {
  const reservation = await listener();
  try {
    const { options } = input(reservation.port, reservation.fd);
    const shared = Buffer.from("shared-three-process-password");
    options.consensusPasswordBuffer = shared;
    options.transportPasswordBuffer = shared.subarray(2);
    await assert.rejects(launchValidatorReadinessThreeProcess(options),
      /three-process launch failed/);
    assert.equal(shared.every((byte) => byte === 0), true);
    assert.equal(options.tlsKeyBuffer.every((byte) => byte === 0), true);
    const expanded = input(reservation.port, reservation.fd).options;
    expanded.env = { NODE_OPTIONS: "--require=attacker" };
    await assert.rejects(launchValidatorReadinessThreeProcess(expanded),
      /three-process launch failed/);
    assert.equal(expanded.consensusPasswordBuffer.every((byte) => byte === 0), true);
  } finally { await new Promise((resolve) => reservation.server.close(resolve)); }
});

test("certificate mismatch and a non-socket listener are rejected before child launch", async () => {
  const reservation = await listener();
  try {
    const invalidCertificate = input(reservation.port, reservation.fd).options;
    invalidCertificate.tlsCertificateBuffer[10] ^= 1;
    await assert.rejects(launchValidatorReadinessThreeProcess(invalidCertificate),
      /three-process launch failed/);
    assert.equal(invalidCertificate.tlsKeyBuffer.every((byte) => byte === 0), true);
    const invalidListener = input(reservation.port, reservation.fd).options;
    invalidListener.listenerFd = 1;
    await assert.rejects(launchValidatorReadinessThreeProcess(invalidListener),
      /three-process launch failed/);
    assert.equal(invalidListener.transportPasswordBuffer.every((byte) => byte === 0), true);
  } finally { await new Promise((resolve) => reservation.server.close(resolve)); }
});

test("self-consistent child inputs cannot replace independent operator pins", async () => {
  const reservation = await listener();
  try {
    const first = input(reservation.port, reservation.fd).options;
    const second = input(reservation.port, reservation.fd).options;
    second.trustedPins = first.trustedPins;
    await assert.rejects(launchValidatorReadinessThreeProcess(second),
      /three-process launch failed/);
    assert.equal(second.consensusPasswordBuffer.every((byte) => byte === 0), true);
    assert.equal(second.tlsKeyBuffer.every((byte) => byte === 0), true);
    const omitted = input(reservation.port, reservation.fd).options;
    delete omitted.trustedPins;
    await assert.rejects(launchValidatorReadinessThreeProcess(omitted),
      /three-process launch failed/);
  } finally { await new Promise((resolve) => reservation.server.close(resolve)); }
});

test("gateway cannot claim a listener port other than the inherited socket", async () => {
  const reservation = await listener();
  const { options } = input(reservation.port + 1, reservation.fd);
  const launch = launchValidatorReadinessThreeProcess(options);
  await new Promise((resolve) => reservation.server.close(resolve));
  await assert.rejects(limit(launch, "wrong-listener launch"),
    /three-process launch failed/);
});

test("one signer crash tears down gateway and the other signer", async () => {
  const reservation = await listener();
  const { options, values } = input(reservation.port, reservation.fd);
  const launch = launchValidatorReadinessThreeProcess(options);
  await new Promise((resolve) => reservation.server.close(resolve));
  const cohort = await limit(launch, "three-process launch");
  process.kill(cohort.pids.transport, "SIGKILL");
  assert.deepEqual(await limit(cohort.waitForTermination(), "cohort teardown"),
    { reason: "failed" });
  assert.throws(() => process.kill(cohort.pids.consensus, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(cohort.pids.gateway, 0), { code: "ESRCH" });
  await assert.rejects(() => request(values));
});

test("gateway crash tears down both signer children", async () => {
  const reservation = await listener();
  const { options, values } = input(reservation.port, reservation.fd);
  const launch = launchValidatorReadinessThreeProcess(options);
  await new Promise((resolve) => reservation.server.close(resolve));
  const cohort = await limit(launch, "three-process launch");
  process.kill(cohort.pids.gateway, "SIGKILL");
  assert.deepEqual(await limit(cohort.waitForTermination(), "cohort teardown"),
    { reason: "failed" });
  assert.throws(() => process.kill(cohort.pids.consensus, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(cohort.pids.transport, 0), { code: "ESRCH" });
  await assert.rejects(() => request(values));
});

test("launcher source keeps fixed child paths and no generic process authority", () => {
  const source = readFileSync(new URL(
    "../blockchain/validator-readiness-three-process-launcher.mjs", import.meta.url), "utf8");
  assert.match(source, /const SIGNER_CLI = fileURLToPath/u);
  assert.match(source, /const GATEWAY_CLI = fileURLToPath/u);
  assert.doesNotMatch(source,
    /process\.env|\b(?:exec|execFile|fork)\s*\(|["']ipc["']|password.*(?:argv|env)/iu);
  assert.match(source, /Object\.freeze\(\["consensusInput"/u);
  assert.match(source, /closeSync\(transferredFd\)/u);
});

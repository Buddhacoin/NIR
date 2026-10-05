import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../blockchain/crypto.mjs";
import { VALIDATOR_ADMISSION_READINESS_CHALLENGE_PATH }
  from "../blockchain/validator-admission-readiness-service.mjs";
import { encryptWallet } from "../blockchain/vault.mjs";
import {
  createValidatorReadinessProcessBootstrapSet,
} from "../blockchain/validator-readiness-process-protocol.mjs";
import {
  createValidatorReadinessGatewayRuntimeReady,
  createValidatorReadinessRuntimeFrameDecoder,
  createValidatorReadinessRuntimeLaunchEnvelope,
  encodeValidatorReadinessRuntimeFrame,
} from "../blockchain/validator-readiness-runtime-protocol.mjs";
import {
  createValidatorReadinessGatewayChildFrameDecoder,
  createValidatorReadinessGatewayChildInput,
  createValidatorReadinessGatewayCommitCommand,
  createValidatorReadinessGatewayPrepareCommand,
  encodeValidatorReadinessGatewayChildFrame,
  verifyValidatorReadinessGatewayCommitAcknowledgement,
  verifyValidatorReadinessGatewayPrepareAcknowledgement,
} from "../blockchain/validator-readiness-gateway-child-protocol.mjs";
import { createValidatorReadinessGatewayRuntimeInput,
  verifyValidatorReadinessGatewayRuntimeInput }
  from "../blockchain/validator-readiness-gateway-runtime-input.mjs";
import {
  createValidatorReadinessSignerActivationCommand,
  createValidatorReadinessSignerChildInput,
  encodeValidatorReadinessSignerChildFrame,
  verifyValidatorReadinessSignerActivationAcknowledgement,
} from "../blockchain/validator-readiness-signer-child-protocol.mjs";
import { validatorReadinessSignerFixture } from "./validator-readiness-signer-fixture.mjs";

const GATEWAY_CLI = fileURLToPath(new URL(
  "../blockchain/validator-readiness-gateway-child-cli.mjs", import.meta.url));
const SIGNER_CLI = fileURLToPath(new URL(
  "../blockchain/validator-readiness-signer-child-cli.mjs", import.meta.url));
const TIMEOUT_MS = 15_000;

const temporary = mkdtempSync(join(tmpdir(), "nir-gateway-child-runtime-"));
const keyPath = join(temporary, "tls-key.pem");
const certPath = join(temporary, "tls-cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"],
{ stdio: "ignore" });
const tlsKey = readFileSync(keyPath); const tlsCertificate = readFileSync(certPath);
const tlsCertificateSha256 = createHash("sha256")
  .update(new X509Certificate(tlsCertificate).raw).digest("hex");
after(() => rmSync(temporary, { force: true, recursive: true }));

function deadline(promise, label, timeoutMs = TIMEOUT_MS) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

class Frames {
  constructor(stream, decoder) {
    this.decoder = decoder; this.queue = []; this.waiters = []; this.error = null;
    stream.on("data", (chunk) => {
      try { for (const value of decoder.push(chunk)) this.#push(value); }
      catch (error) { this.#fail(error); }
    });
    stream.once("error", (error) => this.#fail(error));
    stream.once("end", () => {
      try { decoder.finish(); } catch (error) { this.#fail(error); return; }
      this.#fail(new Error("frame stream ended"));
    });
  }
  #push(value) {
    const waiter = this.waiters.shift(); waiter ? waiter.resolve(value) : this.queue.push(value);
  }
  #fail(error) {
    if (this.error) return; this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  next(label) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.error) return Promise.reject(this.error);
    return deadline(new Promise((resolve, reject) => this.waiters.push({ reject, resolve })), label);
  }
}

async function reserveListener() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  return { fd: server._handle.fd, port: server.address().port, server };
}

function statusPipeRelay() {
  const relay = spawn(process.execPath, ["-e",
    "process.stdin.pipe(process.stdout);setInterval(()=>{},2147483647)"], {
    env: {}, stdio: ["pipe", "pipe", "ignore"],
  });
  relay.on("error", () => {}); relay.stdin.on("error", () => {});
  relay.stdout.on("error", () => {});
  return { consumer: relay.stdout, producer: relay.stdin, relay };
}

function basePins(values, role, bootstrap) {
  return { expectedBootstrapHash: bootstrap.bootstrapHash,
    expectedLauncherNonce: values.launcherNonce,
    expectedReleaseProvenanceHash: values.session.releaseProvenanceHash,
    expectedRole: role, expectedSessionHash: values.session.sessionHash };
}

function signerStatusPins(values, role, ready) {
  const bootstrap = values[`${role}SignerBootstrap`];
  return { ...basePins(values, role, bootstrap), expectedPid: ready.pid,
    expectedProcessNonce: ready.processNonce };
}

function setup(port) {
  const now = Date.now();
  const values = validatorReadinessSignerFixture({ endpoint: `https://127.0.0.1:${port}`,
    now, tlsCertificateSha256 });
  const consensusPassword = "gateway-runtime-consensus-password";
  const transportPassword = "gateway-runtime-transport-password";
  const consensusVault = encryptWallet(values.candidate, consensusPassword,
    { label: "Gateway runtime consensus" });
  const transportVault = encryptWallet(values.transport, transportPassword,
    { label: "Gateway runtime transport" });
  const bootstraps = createValidatorReadinessProcessBootstrapSet({ consensusVault,
    gatewayRolePackage: values.gatewayRolePackage, initialHeight: values.context.checkpoint.height,
    tlsCertificateSha256, transportVault }, { now });
  Object.assign(values, bootstraps, { consensusPassword, consensusVault, now,
    transportPassword, transportVault });
  values.cohortBootstraps = { consensus: values.consensusSignerBootstrap,
    gateway: values.gatewayBootstrap, transport: values.transportSignerBootstrap };
  for (const role of ["consensus", "transport"]) {
    const bootstrap = values[`${role}SignerBootstrap`];
    const encryptedVault = values[`${role}Vault`];
    const pins = basePins(values, role, bootstrap);
    const launchEnvelope = createValidatorReadinessRuntimeLaunchEnvelope({ bootstrap }, pins,
      { encryptedVault, now });
    values[`${role}Input`] = createValidatorReadinessSignerChildInput({
      cohortBootstraps: values.cohortBootstraps, encryptedVault, launchEnvelope,
    }, pins, { now });
  }
  const gatewayPins = basePins(values, "gateway", values.gatewayBootstrap);
  const gatewayLaunchEnvelope = createValidatorReadinessRuntimeLaunchEnvelope({
    bootstrap: values.gatewayBootstrap,
    consensusSignerBootstrap: values.consensusSignerBootstrap,
    transportSignerBootstrap: values.transportSignerBootstrap,
  }, gatewayPins, { now });
  values.gatewayInputPins = { expectedBootstrapHash: values.gatewayBootstrap.bootstrapHash,
    expectedBoundHost: "127.0.0.1", expectedBoundPort: port,
    expectedLauncherNonce: values.launcherNonce,
    expectedReleaseProvenanceHash: values.session.releaseProvenanceHash,
    expectedSessionHash: values.session.sessionHash };
  values.gatewayInput = createValidatorReadinessGatewayChildInput({
    cohortBootstraps: values.cohortBootstraps, launchEnvelope: gatewayLaunchEnvelope,
  }, values.gatewayInputPins, { now });
  return values;
}

function launchSigner(role, values) {
  const child = spawn(process.execPath, [SIGNER_CLI, role], { env: {},
    stdio: Array.from({ length: 10 }, () => "pipe") });
  const status = new Frames(child.stdio[6], createValidatorReadinessRuntimeFrameDecoder());
  for (const descriptor of [3, 4, 5, 7, 8, 9]) child.stdio[descriptor].on("error", () => {});
  child.stdio[3].end(encodeValidatorReadinessSignerChildFrame(values[`${role}Input`]));
  child.stdio[4].end(Buffer.from(values[`${role}Password`]));
  return { child, role, status };
}

async function launchGateway(values, reservation, consensus, transport,
  runtimeInputOverride = null, statusPair = null) {
  const stdio = Array.from({ length: 14 }, () => "pipe"); stdio[12] = reservation.fd;
  if (statusPair) stdio[7] = statusPair.producer._handle.fd;
  const child = spawn(process.execPath, [GATEWAY_CLI], { env: {}, stdio });
  await new Promise((resolve) => reservation.server.close(resolve));
  const statusInput = statusPair?.consumer ?? child.stdio[7];
  const status = new Frames(statusInput, createValidatorReadinessGatewayChildFrameDecoder());
  for (const descriptor of [3, 4, 5, 6, 8, 9, 10, 11, 13]) {
    child.stdio[descriptor].on("error", () => {});
  }
  child.stdio[9].pipe(transport.child.stdio[7]);
  transport.child.stdio[8].pipe(child.stdio[8]);
  child.stdio[11].pipe(consensus.child.stdio[7]);
  consensus.child.stdio[8].pipe(child.stdio[10]);
  const defaultRuntimeInput = () => createValidatorReadinessGatewayRuntimeInput({
    expectedConsensusPid: consensus.child.pid, expectedGatewayPid: child.pid,
    expectedTransportPid: transport.child.pid, gatewayInput: values.gatewayInput,
  }, { now: values.now });
  const runtimeInput = typeof runtimeInputOverride === "function"
    ? runtimeInputOverride({ child, consensus, transport, values })
    : runtimeInputOverride ?? defaultRuntimeInput();
  child.stdio[3].end(encodeValidatorReadinessGatewayChildFrame(runtimeInput));
  child.stdio[4].end(Buffer.from(tlsKey)); child.stdio[5].end(Buffer.from(tlsCertificate));
  return { child, runtimeInput, status, statusPair };
}

function protocolPins(values, records) {
  return { ...values.gatewayInputPins, expectedConsensusPid: records.consensus.child.pid,
    expectedGatewayPid: records.gateway.child.pid,
    expectedTransportPid: records.transport.child.pid };
}

function request(values) {
  const body = Buffer.from(canonicalJson({ challenge: values.challenge,
    context: values.context }));
  return deadline(new Promise((resolve, reject) => {
    const target = new URL(VALIDATOR_ADMISSION_READINESS_CHALLENGE_PATH,
      values.context.endpoint);
    const outgoing = httpsRequest(target, {
      headers: { "content-length": String(body.length), "content-type": "application/json" },
      method: "POST", minVersion: "TLSv1.3", rejectUnauthorized: false,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ body: JSON.parse(Buffer.concat(chunks)),
        status: response.statusCode }));
    });
    outgoing.on("error", reject); outgoing.end(body);
  }), "gateway HTTPS request");
}

function exit(child) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode,
    signal: child.signalCode });
  return deadline(new Promise((resolve) => child.once("exit", (code, signal) =>
    resolve({ code, signal }))), "child exit");
}

async function cohort({ statusPair = null } = {}) {
  const reservation = await reserveListener(); const values = setup(reservation.port);
  const consensus = launchSigner("consensus", values);
  const transport = launchSigner("transport", values);
  const gateway = await launchGateway(values, reservation, consensus, transport,
    null, statusPair);
  const records = { consensus, gateway, transport };
  const readiness = { consensus: await consensus.status.next("consensus READY"),
    gateway: await gateway.status.next("gateway READY"),
    transport: await transport.status.next("transport READY") };
  return { readiness, records, values };
}

async function activate(bundle) {
  const { readiness, records, values } = bundle; const pins = protocolPins(values, records);
  const prepare = createValidatorReadinessGatewayPrepareCommand({ gatewayInput: values.gatewayInput,
    gatewayReady: readiness.gateway, readiness }, pins, { now: Date.now() });
  records.gateway.child.stdio[6].write(encodeValidatorReadinessGatewayChildFrame(prepare));
  const prepareAcknowledgement = await records.gateway.status.next("gateway PREPARE_ACK");
  verifyValidatorReadinessGatewayPrepareAcknowledgement(prepareAcknowledgement, {
    expectedPrepare: prepare, gatewayInput: values.gatewayInput, gatewayReady: readiness.gateway,
    ...pins,
  }, { now: Date.now() });
  const signerAcknowledgements = {};
  for (const role of ["consensus", "transport"]) {
    const command = createValidatorReadinessSignerActivationCommand({
      activation: prepare.activations[role], readiness,
    }, { expectedRole: role, signerInput: values[`${role}Input`], now: Date.now() });
    records[role].child.stdio[5].write(encodeValidatorReadinessRuntimeFrame(command));
    signerAcknowledgements[role] = await records[role].status.next(`${role} activation ACK`);
    verifyValidatorReadinessSignerActivationAcknowledgement(signerAcknowledgements[role], {
      ...signerStatusPins(values, role, readiness[role]),
      expectedActivation: prepare.activations[role],
    });
  }
  const commit = createValidatorReadinessGatewayCommitCommand({ gatewayInput: values.gatewayInput,
    gatewayReady: readiness.gateway, prepare, prepareAcknowledgement,
    signerAcknowledgements }, pins, { now: Date.now() });
  records.gateway.child.stdio[6].write(encodeValidatorReadinessGatewayChildFrame(commit));
  const commitAcknowledgement = await records.gateway.status.next("gateway COMMIT_ACK");
  assert.equal(commitAcknowledgement.messageType, "commit-ack",
    canonicalJson(commitAcknowledgement));
  verifyValidatorReadinessGatewayCommitAcknowledgement(commitAcknowledgement, {
    expectedCommit: commit, expectedPrepare: prepare,
    expectedPrepareAcknowledgement: prepareAcknowledgement,
    gatewayInput: values.gatewayInput, gatewayReady: readiness.gateway, ...pins,
  }, { now: Date.now() });
  return { commit, commitAcknowledgement, prepare, prepareAcknowledgement };
}

async function stopAll(records) {
  for (const record of Object.values(records)) {
    const fd = record.role ? 9 : 13;
    try { record.child.stdio[fd].end(); } catch {}
  }
  return Promise.all(Object.values(records).map((record) => exit(record.child)));
}

test("real gateway child stays HTTP-inactive through PREPARE and COMMIT_ACK flush, then relays both signers", async () => {
  const bundle = await cohort();
  try {
    assert.equal((await request(bundle.values)).status, 503);
    const { readiness, records, values } = bundle; const pins = protocolPins(values, records);
    const prepare = createValidatorReadinessGatewayPrepareCommand({ gatewayInput: values.gatewayInput,
      gatewayReady: readiness.gateway, readiness }, pins, { now: Date.now() });
    records.gateway.child.stdio[6].write(encodeValidatorReadinessGatewayChildFrame(prepare));
    const prepareAcknowledgement = await records.gateway.status.next("gateway PREPARE_ACK");
    verifyValidatorReadinessGatewayPrepareAcknowledgement(prepareAcknowledgement, {
      expectedPrepare: prepare, gatewayInput: values.gatewayInput, gatewayReady: readiness.gateway,
      ...pins,
    }, { now: Date.now() });
    assert.equal((await request(values)).status, 503);
    const signerAcknowledgements = {};
    for (const role of ["consensus", "transport"]) {
      const command = createValidatorReadinessSignerActivationCommand({
        activation: prepare.activations[role], readiness,
      }, { expectedRole: role, signerInput: values[`${role}Input`], now: Date.now() });
      records[role].child.stdio[5].write(encodeValidatorReadinessRuntimeFrame(command));
      signerAcknowledgements[role] = await records[role].status.next(`${role} activation ACK`);
    }
    const commit = createValidatorReadinessGatewayCommitCommand({ gatewayInput: values.gatewayInput,
      gatewayReady: readiness.gateway, prepare, prepareAcknowledgement,
      signerAcknowledgements }, pins, { now: Date.now() });
    records.gateway.child.stdio[6].write(encodeValidatorReadinessGatewayChildFrame(commit));
    const commitAcknowledgement = await records.gateway.status.next("gateway COMMIT_ACK");
    assert.equal(commitAcknowledgement.messageType, "commit-ack",
      canonicalJson(commitAcknowledgement));
    verifyValidatorReadinessGatewayCommitAcknowledgement(commitAcknowledgement, {
      expectedCommit: commit, expectedPrepare: prepare,
      expectedPrepareAcknowledgement: prepareAcknowledgement,
      gatewayInput: values.gatewayInput, gatewayReady: readiness.gateway, ...pins,
    }, { now: Date.now() });
    const accepted = await request(values);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.consensusSignature.length > 100, true);
    assert.equal(accepted.body.transportSignature.length > 100, true);
    assert.deepEqual(await stopAll(records), [
      { code: 0, signal: null }, { code: 0, signal: null }, { code: 0, signal: null },
    ]);
  } finally {
    for (const { child } of Object.values(bundle.records)) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
});

test("gateway child rejects replay after COMMIT and tears down without another HTTP response", async () => {
  const bundle = await cohort();
  try {
    const flow = await activate(bundle);
    assert.equal((await request(bundle.values)).status, 200);
    bundle.records.gateway.child.stdio[6]
      .write(encodeValidatorReadinessGatewayChildFrame(flow.prepare));
    const fatal = await bundle.records.gateway.status.next("gateway replay fatal");
    assert.equal(fatal.messageType, "fatal"); assert.equal(fatal.code, "channel-failed");
    assert.equal((await exit(bundle.records.gateway.child)).code, 1);
  } finally {
    for (const { child } of Object.values(bundle.records)) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
});

test("post-COMMIT poison closes HTTPS and aborts signing before a stalled fatal write", async () => {
  const statusPair = statusPipeRelay();
  const bundle = await cohort({ statusPair });
  try {
    const flow = await activate(bundle);
    const signerRequests = bundle.records.gateway.child.stdio[9];
    signerRequests.unpipe(bundle.records.transport.child.stdio[7]);
    signerRequests.pause();

    let requestBytesReady;
    const requestBytes = new Promise((resolve) => { requestBytesReady = resolve; });
    signerRequests.once("readable", requestBytesReady);
    const signingRequest = request(bundle.values).then(
      (value) => ({ status: "resolved", value }),
      (error) => ({ error, status: "rejected" }));
    await deadline(requestBytes, "gateway signer request bytes");

    statusPair.relay.kill("SIGSTOP");
    let fillerFlushed = false;
    const filler = Buffer.alloc(32 * 1024 * 1024, 0x5a);
    assert.equal(statusPair.producer.write(filler, () => { fillerFlushed = true; }), false);

    bundle.records.gateway.child.stdio[6]
      .write(encodeValidatorReadinessGatewayChildFrame(flow.prepare));
    const outcome = await deadline(signingRequest, "aborted HTTPS signing request", 2_000);
    assert.equal(outcome.status, "rejected");
    assert.equal(fillerFlushed, false,
      "service teardown must precede completion of the stalled status write");
    assert.equal(bundle.records.gateway.child.exitCode, null,
      "fatal status remains bounded and pending after the service is already closed");
    await assert.rejects(() => request(bundle.values));
    assert.deepEqual(await exit(bundle.records.gateway.child), { code: 1, signal: null });
  } finally {
    statusPair.relay.kill("SIGCONT"); statusPair.relay.kill("SIGKILL");
    statusPair.consumer.destroy(); statusPair.producer.destroy();
    for (const role of ["consensus", "transport"]) {
      const child = bundle.records[role].child;
      try { child.stdio[9].end(); } catch {}
      if (child.exitCode === null) await exit(child).catch(() => child.kill("SIGKILL"));
    }
    if (bundle.records.gateway.child.exitCode === null) {
      bundle.records.gateway.child.kill("SIGKILL");
    }
  }
});

test("gateway child lifeline EOF before COMMIT is clean, bounded and never activates HTTP", async () => {
  const bundle = await cohort();
  try {
    bundle.records.gateway.child.stdio[13].end();
    assert.deepEqual(await exit(bundle.records.gateway.child), { code: 0, signal: null });
    await assert.rejects(() => request(bundle.values));
  } finally {
    for (const { child } of Object.values(bundle.records)) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
});

test("gateway runtime input exact schema binds every retained child PID", async () => {
  const reservation = await reserveListener();
  try {
    const values = setup(reservation.port);
    const runtimeInput = createValidatorReadinessGatewayRuntimeInput({
      expectedConsensusPid: 101, expectedGatewayPid: 102, expectedTransportPid: 103,
      gatewayInput: values.gatewayInput,
    }, { now: values.now });
    assert.deepEqual(verifyValidatorReadinessGatewayRuntimeInput(runtimeInput,
      { now: values.now }), runtimeInput);
    for (const mutate of [
      (value) => { value.expectedConsensusPid += 1; },
      (value) => { value.expectedGatewayPid += 1; },
      (value) => { value.expectedTransportPid += 1; },
      (value) => { value.role = "transport"; },
      (value) => { value.unknown = true; },
      (value) => { value.runtimeInputHash = `sha3-256:${"0".repeat(64)}`; },
    ]) {
      const changed = structuredClone(runtimeInput); mutate(changed);
      assert.throws(() => verifyValidatorReadinessGatewayRuntimeInput(changed,
        { now: values.now }));
    }
  } finally {
    await new Promise((resolve) => reservation.server.close(resolve));
  }
});

test("gateway child rejects a runtime package pinned to an old child PID before READY", async () => {
  const reservation = await reserveListener(); const values = setup(reservation.port);
  const consensus = launchSigner("consensus", values);
  const transport = launchSigner("transport", values);
  let gateway;
  try {
    gateway = await launchGateway(values, reservation, consensus, transport,
      ({ child }) => createValidatorReadinessGatewayRuntimeInput({
        expectedConsensusPid: consensus.child.pid, expectedGatewayPid: child.pid + 1,
        expectedTransportPid: transport.child.pid, gatewayInput: values.gatewayInput,
      }, { now: values.now }));
    assert.deepEqual(await exit(gateway.child), { code: 1, signal: null });
    await assert.rejects(() => request(values));
  } finally {
    for (const record of [consensus, transport]) {
      try { record.child.stdio[9].end(); } catch {}
      if (record.child.exitCode === null) await exit(record.child).catch(() => record.child.kill("SIGKILL"));
    }
    if (gateway?.child.exitCode === null) gateway.child.kill("SIGKILL");
  }
});

test("gateway child poisons partial control EOF and never opens HTTP", async () => {
  const bundle = await cohort();
  try {
    bundle.records.gateway.child.stdio[6].end(Buffer.from([0, 0]));
    assert.deepEqual(await exit(bundle.records.gateway.child), { code: 1, signal: null });
    await assert.rejects(() => request(bundle.values));
  } finally {
    for (const role of ["consensus", "transport"]) {
      const child = bundle.records[role].child;
      try { child.stdio[9].end(); } catch {}
      if (child.exitCode === null) await exit(child).catch(() => child.kill("SIGKILL"));
    }
  }
});

test("gateway child treats a failed PREPARE_ACK output as terminal and never activates", async () => {
  const bundle = await cohort();
  try {
    const { readiness, records, values } = bundle;
    records.gateway.child.stdio[7].destroy();
    const prepare = createValidatorReadinessGatewayPrepareCommand({
      gatewayInput: values.gatewayInput, gatewayReady: readiness.gateway, readiness,
    }, protocolPins(values, records), { now: Date.now() });
    records.gateway.child.stdio[6].write(encodeValidatorReadinessGatewayChildFrame(prepare));
    assert.deepEqual(await exit(records.gateway.child), { code: 1, signal: null });
    await assert.rejects(() => request(values));
  } finally {
    for (const role of ["consensus", "transport"]) {
      const child = bundle.records[role].child;
      try { child.stdio[9].end(); } catch {}
      if (child.exitCode === null) await exit(child).catch(() => child.kill("SIGKILL"));
    }
  }
});

test("gateway CLI rejects argv and source has no environment, path, spawn, vault or generic signer surface", () => {
  for (const args of [["extra"], ["gateway", "extra"]]) {
    const result = spawnSync(process.execPath, [GATEWAY_CLI, ...args], { env: {}, timeout: 2_000 });
    assert.equal(result.status, 2); assert.equal(result.stdout.length, 0);
    assert.equal(result.stderr.length, 0);
  }
  const runtime = readFileSync(new URL(
    "../blockchain/validator-readiness-gateway-child-runtime.mjs", import.meta.url), "utf8");
  for (const forbidden of ["process.env", "node:child_process", "spawn(", "vault",
    "privateKey", "signObject(", "createReadStream", "readFile"]) {
    assert.equal(runtime.includes(forbidden), false, forbidden);
  }
});

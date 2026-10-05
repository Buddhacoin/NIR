import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { signObject } from "../blockchain/crypto.mjs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encryptWallet } from "../blockchain/vault.mjs";
import {
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN,
} from "../blockchain/validator-admission-readiness-auth.mjs";
import {
  createValidatorReadinessHeightUpdate,
  createValidatorReadinessProcessBootstrapSet,
  createValidatorReadinessSignerReady,
} from "../blockchain/validator-readiness-process-protocol.mjs";
import {
  createValidatorReadinessGatewayRuntimeReady,
  createValidatorReadinessHeightAcknowledgement,
  createValidatorReadinessLaunchActivation,
  createValidatorReadinessRuntimeFrameDecoder,
  createValidatorReadinessRuntimeLaunchEnvelope,
  encodeValidatorReadinessRuntimeFrame,
  verifyValidatorReadinessHeightAcknowledgement,
} from "../blockchain/validator-readiness-runtime-protocol.mjs";
import {
  createValidatorReadinessSignerActivationCommand,
  createValidatorReadinessSignerChildInput,
  encodeValidatorReadinessSignerChildFrame,
  verifyValidatorReadinessSignerActivationAcknowledgement,
} from "../blockchain/validator-readiness-signer-child-protocol.mjs";
import {
  createValidatorReadinessSignerChannelEpoch,
  createValidatorReadinessConsensusSignRequest,
  createValidatorReadinessSignerFrameDecoder,
  createValidatorReadinessTransportSignRequest,
  createValidatorReadinessTransportSignResponse,
  encodeValidatorReadinessSignerFrame,
  verifyValidatorReadinessConsensusSignResponse,
  verifyValidatorReadinessTransportSignRequest,
  verifyValidatorReadinessTransportSignResponse,
} from "../blockchain/validator-readiness-signer-protocol.mjs";
import { validatorReadinessSignerFixture } from "./validator-readiness-signer-fixture.mjs";

const CLI = fileURLToPath(new URL(
  "../blockchain/validator-readiness-signer-child-cli.mjs", import.meta.url));
const TIMEOUT_MS = 12_000;

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
  #push(value) { const waiter = this.waiters.shift(); waiter ? waiter.resolve(value) : this.queue.push(value); }
  #fail(error) { if (this.error) return; this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error); }
  next(label) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.error) return Promise.reject(this.error);
    return deadline(new Promise((resolve, reject) => this.waiters.push({ reject, resolve })), label);
  }
}

function pins(values, role, bootstrap) {
  return { expectedBootstrapHash: bootstrap.bootstrapHash,
    expectedLauncherNonce: values.launcherNonce,
    expectedReleaseProvenanceHash: values.session.releaseProvenanceHash,
    expectedRole: role, expectedSessionHash: values.session.sessionHash };
}

function fixture(role) {
  const now = Date.now(); const values = validatorReadinessSignerFixture({ now });
  const consensusPassword = "real-child-consensus-password";
  const transportPassword = "real-child-transport-password";
  const consensusVault = encryptWallet(values.candidate, consensusPassword,
    { label: "Real consensus child" });
  const transportVault = encryptWallet(values.transport, transportPassword,
    { label: "Real transport child" });
  const bootstraps = createValidatorReadinessProcessBootstrapSet({ consensusVault,
    gatewayRolePackage: values.gatewayRolePackage,
    initialHeight: values.context.checkpoint.height,
    tlsCertificateSha256: values.context.tlsCertificateSha256, transportVault,
  }, { now });
  Object.assign(values, bootstraps, { consensusPassword, consensusVault, now,
    transportPassword, transportVault });
  const bootstrap = role === "consensus" ? values.consensusSignerBootstrap
    : values.transportSignerBootstrap;
  const encryptedVault = role === "consensus" ? consensusVault : transportVault;
  const expected = pins(values, role, bootstrap);
  const launchEnvelope = createValidatorReadinessRuntimeLaunchEnvelope({ bootstrap }, expected,
    { encryptedVault, now });
  values.signerInput = createValidatorReadinessSignerChildInput({ cohortBootstraps: {
    consensus: values.consensusSignerBootstrap, gateway: values.gatewayBootstrap,
    transport: values.transportSignerBootstrap,
  }, encryptedVault, launchEnvelope }, expected, { now });
  return values;
}

function launch(role, values, password = null) {
  const child = spawn(process.execPath, [CLI, role], {
    cwd: new URL("..", import.meta.url), env: {},
    stdio: Array.from({ length: 10 }, () => "pipe"),
  });
  const status = new Frames(child.stdio[6], createValidatorReadinessRuntimeFrameDecoder());
  const responses = new Frames(child.stdio[8], createValidatorReadinessSignerFrameDecoder());
  const stdout = []; const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  for (const descriptor of [3, 4, 5, 7, 9]) child.stdio[descriptor].on("error", () => {});
  child.stdio[3].end(encodeValidatorReadinessSignerChildFrame(values.signerInput));
  child.stdio[4].end(Buffer.from(password ?? (role === "consensus"
    ? values.consensusPassword : values.transportPassword)));
  return { child, responses, status, stderr, stdout };
}

function exit(child) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return deadline(new Promise((resolve) => child.once("exit", (code, signal) =>
    resolve({ code, signal }))), "child exit");
}

function fullReadiness(values, role, ownReady) {
  const consensus = role === "consensus" ? ownReady : createValidatorReadinessSignerReady({
    bootstrap: values.consensusSignerBootstrap, pid: 41_001, wallet: values.candidate,
  }, { now: Date.now() });
  const transport = role === "transport" ? ownReady : createValidatorReadinessSignerReady({
    bootstrap: values.transportSignerBootstrap, pid: 41_002, wallet: values.transport,
  }, { now: Date.now() });
  const gatewayPins = pins(values, "gateway", values.gatewayBootstrap);
  const gateway = createValidatorReadinessGatewayRuntimeReady({ boundHost: "candidate.example",
    boundPort: 443, bootstrap: values.gatewayBootstrap, pid: 41_003,
    processNonce: "ab".repeat(32) }, gatewayPins);
  return { consensus, gateway, transport };
}

function ownStatusPins(values, role, ready) {
  const bootstrap = role === "consensus" ? values.consensusSignerBootstrap
    : values.transportSignerBootstrap;
  return { ...pins(values, role, bootstrap), expectedPid: ready.pid,
    expectedProcessNonce: ready.processNonce };
}

async function activate(record, values, role, ownReady) {
  const readiness = fullReadiness(values, role, ownReady);
  const activation = createValidatorReadinessLaunchActivation({ readiness },
    ownStatusPins(values, role, ownReady));
  const command = createValidatorReadinessSignerActivationCommand({ activation, readiness }, {
    expectedRole: role, signerInput: values.signerInput, now: Date.now(),
  });
  record.child.stdio[5].write(encodeValidatorReadinessRuntimeFrame(command));
  const ack = await record.status.next(`${role} activation acknowledgement`);
  assert.deepEqual(verifyValidatorReadinessSignerActivationAcknowledgement(ack, {
    ...ownStatusPins(values, role, ownReady), expectedActivation: activation,
  }), ack);
  return { activation, command, readiness };
}

function runtimeChannelBinding(values, role, ready) {
  const bootstrap = role === "transport" ? values.transportSignerBootstrap
    : values.consensusSignerBootstrap;
  return { bootstrap, expectedLauncherNonce: ready.launcherNonce, expectedPid: ready.pid,
    expectedReleaseProvenanceHash: ready.releaseProvenanceHash,
    expectedSessionHash: ready.sessionHash, signerReady: ready };
}

function runtimeChannelEpoch(values, role, ready) {
  return createValidatorReadinessSignerChannelEpoch(runtimeChannelBinding(values, role, ready),
    { expectedRole: role, now: Date.now() });
}

function requestPair(values, role, ready) {
  const channelBinding = runtimeChannelBinding(values, role, ready);
  if (role === "transport") {
    return Array.from({ length: 2 }, () => createValidatorReadinessTransportSignRequest({
      challenge: values.challenge, gatewayRolePackage: values.gatewayRolePackage,
    }, { channelBinding, now: Date.now() }));
  }
  const transportRequest = createValidatorReadinessTransportSignRequest({
    challenge: values.challenge, gatewayRolePackage: values.gatewayRolePackage,
  }, { channelBinding: values.transportSignerBinding, now: Date.now() });
  const verified = verifyValidatorReadinessTransportSignRequest(transportRequest, {
    channelBinding: values.transportSignerBinding,
    rolePackage: values.transportRolePackage, now: Date.now(),
  });
  const transportResponse = createValidatorReadinessTransportSignResponse({
    request: transportRequest, rolePackage: values.transportRolePackage,
    signature: signObject(verified.signingInput, values.transport,
      VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN),
  }, { channelBinding: values.transportSignerBinding, now: Date.now() }).transportResponse;
  return Array.from({ length: 2 }, () => createValidatorReadinessConsensusSignRequest({
    gatewayRolePackage: values.gatewayRolePackage, transportResponse,
  }, { channelBinding, now: Date.now() }));
}

for (const role of ["transport", "consensus"]) {
  test(`real ${role} child gates custody, activation, signing and height updates`, async () => {
    const values = fixture(role); const record = launch(role, values);
    try {
      const ready = await record.status.next(`${role} ready`);
      assert.equal(ready.role, role); assert.equal(ready.pid, record.child.pid);
      await activate(record, values, role, ready);

      const channelBinding = runtimeChannelBinding(values, role, ready);
      const requests = requestPair(values, role, ready);
      record.child.stdio[7].write(Buffer.concat(requests.map(encodeValidatorReadinessSignerFrame)));
      const first = await record.responses.next(`${role} first response`);
      const second = await record.responses.next(`${role} cached response`);
      const verify = role === "transport" ? verifyValidatorReadinessTransportSignResponse
        : verifyValidatorReadinessConsensusSignResponse;
      const firstVerified = verify(first, { gatewayRolePackage: values.gatewayRolePackage,
        channelBinding, request: requests[0], now: Date.now() });
      const secondVerified = verify(second, { gatewayRolePackage: values.gatewayRolePackage,
        channelBinding, request: requests[1], now: Date.now() });
      const core = role === "transport" ? "transportResponse" : "candidateResponse";
      assert.deepEqual(firstVerified[core], secondVerified[core]);

      const bootstrap = role === "transport" ? values.transportSignerBootstrap
        : values.consensusSignerBootstrap;
      const update = createValidatorReadinessHeightUpdate({ bootstrap,
        height: bootstrap.initialHeight + 1 }, { now: Date.now() });
      record.child.stdio[5].write(encodeValidatorReadinessRuntimeFrame(update));
      const heightAck = await record.status.next(`${role} height acknowledgement`);
      assert.deepEqual(verifyValidatorReadinessHeightAcknowledgement(heightAck, {
        ...ownStatusPins(values, role, ready), expectedHeightUpdate: update,
      }), heightAck);

      record.child.stdio[9].end();
      assert.deepEqual(await exit(record.child), { code: 0, signal: null });
    } finally {
      if (record.child.exitCode === null) record.child.kill("SIGKILL");
    }
  });
}

test("a frame captured from child A is rejected by restarted child B before signing", async () => {
  const values = fixture("transport");
  const first = launch("transport", values); let second = null;
  try {
    const firstReady = await first.status.next("first child ready");
    await activate(first, values, "transport", firstReady);
    const [capturedRequest] = requestPair(values, "transport", firstReady);
    const firstEpoch = runtimeChannelEpoch(values, "transport", firstReady);
    first.child.stdio[9].end();
    assert.deepEqual(await exit(first.child), { code: 0, signal: null });

    second = launch("transport", values);
    const secondReady = await second.status.next("replacement child ready");
    await activate(second, values, "transport", secondReady);
    assert.notEqual(runtimeChannelEpoch(values, "transport", secondReady), firstEpoch);
    second.child.stdio[7].write(encodeValidatorReadinessSignerFrame(capturedRequest));
    const fatal = await second.status.next("replacement replay fatal");
    assert.equal(fatal.messageType, "fatal");
    assert.equal(fatal.code, "channel-failed");
    await assert.rejects(second.responses.next("replacement replay response"),
      /ended|failed|closed/);
    assert.equal((await exit(second.child)).code, 1);
  } finally {
    if (first.child.exitCode === null) first.child.kill("SIGKILL");
    if (second?.child.exitCode === null) second.child.kill("SIGKILL");
  }
});

test("real child treats any signer byte before activation ACK as fatal", async () => {
  const values = fixture("transport"); const record = launch("transport", values);
  try {
    const ready = await record.status.next("pre-activation ready");
    assert.equal(ready.role, "transport");
    const request = createValidatorReadinessTransportSignRequest({ challenge: values.challenge,
      gatewayRolePackage: values.gatewayRolePackage }, {
      channelBinding: runtimeChannelBinding(values, "transport", ready), now: Date.now() });
    record.child.stdio[7].write(encodeValidatorReadinessSignerFrame(request));
    const fatal = await record.status.next("pre-activation fatal");
    assert.equal(fatal.messageType, "fatal"); assert.equal(fatal.code, "channel-failed");
    assert.equal((await exit(record.child)).code, 1);
  } finally { if (record.child.exitCode === null) record.child.kill("SIGKILL"); }
});

test("real child fails closed on a wrong password without exposing status details", async () => {
  const values = fixture("consensus");
  const record = launch("consensus", values, "definitely-wrong-child-password");
  try {
    assert.equal((await exit(record.child)).code, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(Buffer.concat(record.stdout).length, 0);
    const stderr = Buffer.concat(record.stderr);
    assert.equal(stderr.length, 0, stderr.toString("utf8"));
  }
  finally { if (record.child.exitCode === null) record.child.kill("SIGKILL"); }
});

test("real child rejects activation replay after ACK and never reopens the endpoint", async () => {
  const values = fixture("transport"); const record = launch("transport", values);
  try {
    const ready = await record.status.next("replay ready");
    const { command } = await activate(record, values, "transport", ready);
    record.child.stdio[5].write(encodeValidatorReadinessRuntimeFrame(command));
    const fatal = await record.status.next("activation replay fatal");
    assert.equal(fatal.messageType, "fatal"); assert.equal(fatal.code, "channel-failed");
    assert.equal((await exit(record.child)).code, 1);
  } finally { if (record.child.exitCode === null) record.child.kill("SIGKILL"); }
});

test("lifeline EOF racing a real key operation cannot release a signature", async () => {
  const values = fixture("transport"); const record = launch("transport", values);
  try {
    const ready = await record.status.next("lifeline race ready");
    await activate(record, values, "transport", ready);
    const [request] = requestPair(values, "transport", ready);
    record.child.stdio[9].end();
    record.child.stdio[7].write(encodeValidatorReadinessSignerFrame(request));
    const result = await Promise.race([
      record.responses.next("lifeline race response").then(() => "response", () => "closed"),
      exit(record.child).then(() => "exit"),
    ]);
    assert.notEqual(result, "response");
    assert.deepEqual(await exit(record.child), { code: 0, signal: null });
  } finally { if (record.child.exitCode === null) record.child.kill("SIGKILL"); }
});

test("real child rejects a height update coalesced behind activation before writing ACK", async () => {
  const values = fixture("consensus"); const record = launch("consensus", values);
  try {
    const ready = await record.status.next("coalesced control ready");
    const readiness = fullReadiness(values, "consensus", ready);
    const activation = createValidatorReadinessLaunchActivation({ readiness },
      ownStatusPins(values, "consensus", ready));
    const command = createValidatorReadinessSignerActivationCommand({ activation, readiness }, {
      expectedRole: "consensus", signerInput: values.signerInput, now: Date.now(),
    });
    const update = createValidatorReadinessHeightUpdate({
      bootstrap: values.consensusSignerBootstrap,
      height: values.consensusSignerBootstrap.initialHeight + 1,
    }, { now: Date.now() });
    record.child.stdio[5].write(Buffer.concat([command, update]
      .map(encodeValidatorReadinessRuntimeFrame)));
    const fatal = await record.status.next("coalesced control fatal");
    assert.equal(fatal.messageType, "fatal"); assert.equal(fatal.code, "channel-failed");
    assert.equal((await exit(record.child)).code, 1);
  } finally { if (record.child.exitCode === null) record.child.kill("SIGKILL"); }
});

test("runtime publishes an accepted height only after its acknowledgement flushes", () => {
  const runtime = readFileSync(new URL(
    "../blockchain/validator-readiness-signer-child-runtime.mjs", import.meta.url), "utf8");
  const acknowledgement = runtime.lastIndexOf("createValidatorReadinessHeightAcknowledgement");
  const publishPrevious = runtime.lastIndexOf("previousUpdate = update");
  const publishHeight = runtime.lastIndexOf("currentHeight = update.height");
  assert.ok(acknowledgement >= 0 && acknowledgement < publishPrevious &&
    publishPrevious < publishHeight);
});

test("child CLI rejects missing, extra and unknown roles before touching inherited channels", () => {
  for (const args of [[], ["gateway"], ["transport", "extra"]]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { env: {}, stdio: "ignore" });
    assert.equal(result.status, 2);
  }
});

test("child runtime and dispatcher have no path, environment, network or generic signing surface", () => {
  const runtime = readFileSync(new URL(
    "../blockchain/validator-readiness-signer-child-runtime.mjs", import.meta.url), "utf8");
  const cli = readFileSync(new URL(
    "../blockchain/validator-readiness-signer-child-cli.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(runtime,
    /node:(?:child_process|cluster|tls|http|https|path)|process\.env|\b(?:readFile|openSync|spawn|fork|execFile|decryptWallet|signObject)\b|privateKey|console\.|process\.(?:stdout|stderr)/u);
  assert.match(runtime, /import \{ Socket \} from "node:net"/u);
  assert.doesNotMatch(runtime,
    /\.(?:connect|listen)\s*\(|\b(?:createConnection|createServer)\s*\(/u);
  const teardownDeadline = runtime.match(
    /function boundedTeardown\(promise\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(teardownDeadline, /setTimeout\(resolve, TEARDOWN_TIMEOUT_MS\)/u);
  assert.doesNotMatch(teardownDeadline, /\.unref\s*\(/u);
  assert.doesNotMatch(cli,
    /node:(?:child_process|cluster|fs|net|tls|http|https|path)|process\.env|console\.|process\.(?:stdout|stderr)/u);
  assert.equal((runtime.match(/export\s+(?:async\s+)?function/g) ?? []).length, 1);
  assert.equal((cli.match(/export\s+/g) ?? []).length, 0);
  assert.match(cli,
    /await\s+runValidatorReadinessSignerChildProcess\([^)]*\)[\s\S]*process\.exit\(exitCode\)/u);
  assert.doesNotMatch(cli, /process\.exitCode\s*=/u);
});

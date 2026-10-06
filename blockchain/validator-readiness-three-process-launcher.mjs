import { spawn } from "node:child_process";
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { closeSync, fstatSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./crypto.mjs";
import {
  verifyValidatorReadinessGatewayActiveAcknowledgement,
  createValidatorReadinessGatewayCommitCommand,
  createValidatorReadinessGatewayPrepareCommand,
  createValidatorReadinessGatewayChildFrameDecoder,
  encodeValidatorReadinessGatewayChildFrame,
  verifyValidatorReadinessGatewayChildInput,
  verifyValidatorReadinessGatewayCommitAcknowledgement,
  verifyValidatorReadinessGatewayPrepareAcknowledgement,
} from "./validator-readiness-gateway-child-protocol.mjs";
import { createValidatorReadinessGatewayRuntimeInput }
  from "./validator-readiness-gateway-runtime-input.mjs";
import {
  createValidatorReadinessHeightUpdate,
  verifyValidatorReadinessSignerReady,
} from "./validator-readiness-process-protocol.mjs";
import {
  createValidatorReadinessRuntimeFrameDecoder,
  encodeValidatorReadinessRuntimeFrame,
  verifyValidatorReadinessGatewayRuntimeReady,
  verifyValidatorReadinessHeightAcknowledgement,
} from "./validator-readiness-runtime-protocol.mjs";
import {
  createValidatorReadinessSignerActivationCommand,
  encodeValidatorReadinessSignerChildFrame,
  verifyValidatorReadinessSignerActivationAcknowledgement,
  verifyValidatorReadinessSignerChildInput,
} from "./validator-readiness-signer-child-protocol.mjs";
import { deriveValidatorReadinessTrustedPins }
  from "./validator-readiness-trusted-evidence.mjs";

const SIGNER_CLI = fileURLToPath(new URL("./validator-readiness-signer-child-cli.mjs", import.meta.url));
const GATEWAY_CLI = fileURLToPath(new URL("./validator-readiness-gateway-child-cli.mjs", import.meta.url));
const ROLES = Object.freeze(["consensus", "transport"]);
const OPTION_KEYS = Object.freeze(["consensusInput", "consensusPasswordBuffer", "gatewayInput",
  "listenerFd", "tlsCertificateBuffer", "tlsKeyBuffer", "transportInput",
  "transportPasswordBuffer", "trustedEvidence", "trustedPins"]);
const PIN_KEYS = Object.freeze(["expectedBoundHost", "expectedBoundPort",
  "expectedConsensusBootstrapHash", "expectedGatewayBootstrapHash",
  "expectedLauncherNonce", "expectedReleaseProvenanceHash", "expectedSessionHash",
  "expectedTlsCertificateSha256", "expectedTransportBootstrapHash"]);
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/u;
const HEX_HASH = /^[0-9a-f]{64}$/u;
const SECRET_KEYS = Object.freeze(["consensusPasswordBuffer", "transportPasswordBuffer",
  "tlsKeyBuffer", "tlsCertificateBuffer"]);
const EPHEMERAL_PIPES = new Set(["bootstrap", "password", "tlsKey", "tlsCertificate"]);
const PHASE_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 500;

function clone(value) { return JSON.parse(canonicalJson(value)); }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
function exactOptions(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== OPTION_KEYS.length ||
      !OPTION_KEYS.every((key) => Object.hasOwn(value, key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) {
    throw new Error("validator readiness three-process launch options are invalid");
  }
  return value;
}
function trustedPins(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== PIN_KEYS.length ||
      !PIN_KEYS.every((key) => Object.hasOwn(value, key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) {
    throw new Error("validator readiness trusted pins are invalid");
  }
  for (const key of ["expectedConsensusBootstrapHash", "expectedGatewayBootstrapHash",
    "expectedReleaseProvenanceHash", "expectedSessionHash",
    "expectedTransportBootstrapHash"]) {
    if (!TAGGED_HASH.test(value[key])) throw new Error(`validator readiness ${key} is invalid`);
  }
  for (const key of ["expectedLauncherNonce", "expectedTlsCertificateSha256"]) {
    if (!HEX_HASH.test(value[key])) throw new Error(`validator readiness ${key} is invalid`);
  }
  if (typeof value.expectedBoundHost !== "string" || value.expectedBoundHost.length < 1 ||
      value.expectedBoundHost.length > 255 || /[\u0000-\u0020\u007f]/u.test(value.expectedBoundHost) ||
      !Number.isSafeInteger(value.expectedBoundPort) || value.expectedBoundPort < 1 ||
      value.expectedBoundPort > 65_535) {
    throw new Error("validator readiness trusted endpoint is invalid");
  }
  return deepFreeze(clone(value));
}
function secretBuffers(value) {
  if (!value || typeof value !== "object") return [];
  try { return SECRET_KEYS.map((key) => Object.getOwnPropertyDescriptor(value, key)?.value)
    .filter(Buffer.isBuffer); } catch { return []; }
}
function overlap(left, right) {
  return left.buffer === right.buffer && left.byteOffset < right.byteOffset + right.byteLength &&
    right.byteOffset < left.byteOffset + left.byteLength;
}
function validateBuffer(value, label, maximum) {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > maximum ||
      (label.includes("Password") && value.length < 12)) {
    throw new Error(`validator readiness ${label} buffer is invalid`);
  }
  return value;
}
function deadline(promise, label, milliseconds = PHASE_TIMEOUT_MS) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function write(stream, bytes, label, end = false) {
  return deadline(new Promise((resolve, reject) => {
    if (!stream || stream.destroyed || stream.writableEnded) {
      reject(new Error(`${label} channel closed`)); return;
    }
    try {
      const callback = (error) => error ? reject(error) : resolve();
      end ? stream.end(bytes, callback) : stream.write(bytes, callback);
    } catch (error) { reject(error); }
  }), label);
}
function acceptListenerFd(listenerFd) {
  if (!Number.isSafeInteger(listenerFd) || listenerFd < 3) {
    throw new Error("validator readiness listener FD is invalid");
  }
  const metadata = fstatSync(listenerFd);
  if (!metadata.isSocket() ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error("validator readiness listener FD is invalid");
  }
  return listenerFd;
}
function validatedInputs(options, trusted) {
  const { consensusInput, gatewayInput, transportInput } = options;
  const now = Date.now();
  const consensus = verifyValidatorReadinessSignerChildInput(consensusInput,
    { expectedRole: "consensus", now });
  const transport = verifyValidatorReadinessSignerChildInput(transportInput,
    { expectedRole: "transport", now });
  const gateway = verifyValidatorReadinessGatewayChildInput(gatewayInput, {
    expectedBootstrapHash: trusted.expectedGatewayBootstrapHash,
    expectedBoundHost: trusted.expectedBoundHost,
    expectedBoundPort: trusted.expectedBoundPort,
    expectedLauncherNonce: trusted.expectedLauncherNonce,
    expectedReleaseProvenanceHash: trusted.expectedReleaseProvenanceHash,
    expectedSessionHash: trusted.expectedSessionHash,
  }, { now });
  if (consensus.expectedBootstrapHash !== trusted.expectedConsensusBootstrapHash ||
      transport.expectedBootstrapHash !== trusted.expectedTransportBootstrapHash ||
      [consensus, transport].some((input) =>
        input.expectedLauncherNonce !== trusted.expectedLauncherNonce ||
        input.expectedReleaseProvenanceHash !== trusted.expectedReleaseProvenanceHash ||
        input.expectedSessionHash !== trusted.expectedSessionHash) ||
      gateway.cohortBootstraps.gateway.tlsCertificateSha256 !==
        trusted.expectedTlsCertificateSha256) {
    throw new Error("validator readiness inputs disagree with trusted pins");
  }
  if (canonicalJson(consensus.cohortBootstraps) !== canonicalJson(transport.cohortBootstraps) ||
      canonicalJson(consensus.cohortBootstraps) !== canonicalJson(gateway.cohortBootstraps) ||
      [consensus, transport].some((input) =>
        input.expectedLauncherNonce !== gateway.expectedLauncherNonce ||
        input.expectedReleaseProvenanceHash !== gateway.expectedReleaseProvenanceHash ||
        input.expectedSessionHash !== gateway.expectedSessionHash)) {
    throw new Error("validator readiness three-process inputs describe different cohorts");
  }
  return deepFreeze(clone({ consensus, gateway, transport }));
}
function checkCertificate(certificate, key, expectedHash) {
  const parsed = new X509Certificate(certificate);
  const digest = createHash("sha256").update(parsed.raw).digest("hex");
  if (digest !== expectedHash || !parsed.checkPrivateKey(createPrivateKey(key))) {
    throw new Error("validator readiness TLS certificate or private key does not match the pin");
  }
}

class Inbox {
  constructor(stream, decoder, fail, label) {
    this.decoder = decoder; this.label = label; this.fail = fail;
    this.expected = "ready"; this.waiter = null; this.message = null; this.failure = null;
    stream.on("data", (chunk) => {
      if (this.failure) return;
      let messages;
      try { messages = this.decoder.push(chunk); } catch (error) { this.stop(error); return; }
      for (const message of messages) {
        const statusType = message.messageType ?? (message.readyHash ? "ready" : null);
        if (!this.expected || statusType !== this.expected || this.message) {
          this.stop(new Error(`${label} sent unexpected status`)); return;
        }
        if (this.waiter) {
          const { resolve, followingType } = this.waiter;
          this.waiter = null; this.expected = followingType;
          resolve(message);
        } else this.message = message;
      }
    });
    stream.on("error", (error) => this.stop(error));
    stream.on("end", () => {
      try { this.decoder.finish(); } catch (error) { this.stop(error); return; }
      this.stop(new Error(`${label} status ended`));
    });
    stream.on("close", () => this.stop(new Error(`${label} status closed`)));
  }
  stop(error) {
    if (this.failure) return;
    this.failure = error; this.message = null;
    if (this.waiter) { const reject = this.waiter.reject; this.waiter = null; reject(error); }
    this.fail(error);
  }
  next(type, label, followingType = null) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.expected === null) this.expected = type;
    if (this.expected !== type || this.waiter) {
      return Promise.reject(new Error(`${this.label} status phase is invalid`));
    }
    if (this.message) {
      const message = this.message; this.message = null; this.expected = followingType;
      return Promise.resolve(message);
    }
    return deadline(new Promise((resolve, reject) => {
      this.waiter = { followingType, resolve, reject };
    }), label);
  }
}

function childRecord(role, fail, listenerFd = null) {
  const gateway = role === "gateway";
  const stdio = ["ignore", "ignore", "ignore", ...Array.from({ length: gateway ? 11 : 7 },
    () => "pipe")];
  if (gateway) stdio[12] = listenerFd;
  const child = spawn(process.execPath, gateway ? [GATEWAY_CLI] : [SIGNER_CLI, role],
    { env: {}, stdio });
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
    try { child.kill("SIGKILL"); } catch {}
    throw new Error(`validator readiness ${role} child did not start`);
  }
  const pipes = gateway ? {
    bootstrap: child.stdio[3], tlsKey: child.stdio[4], tlsCertificate: child.stdio[5],
    control: child.stdio[6], status: child.stdio[7], transportResponse: child.stdio[8],
    transportRequest: child.stdio[9], consensusResponse: child.stdio[10],
    consensusRequest: child.stdio[11], lifeline: child.stdio[13],
  } : {
    bootstrap: child.stdio[3], password: child.stdio[4], control: child.stdio[5],
    status: child.stdio[6], request: child.stdio[7], response: child.stdio[8],
    lifeline: child.stdio[9],
  };
  if (Object.values(pipes).some((stream) => !stream || typeof stream.destroy !== "function")) {
    try { child.kill("SIGKILL"); } catch {}
    throw new Error(`validator readiness ${role} descriptor inventory is incomplete`);
  }
  for (const stream of Object.values(pipes)) stream.on("error", fail);
  let closed = false; let closeResolve;
  const close = new Promise((resolve) => { closeResolve = resolve; });
  child.once("error", fail);
  child.once("exit", () => fail(new Error(`validator readiness ${role} child exited`)));
  child.once("close", () => { closed = true; closeResolve(); });
  const inbox = new Inbox(pipes.status, gateway
    ? createValidatorReadinessGatewayChildFrameDecoder()
    : createValidatorReadinessRuntimeFrameDecoder(), fail, role);
  return { child, close, get closed() { return closed; }, inbox, pipes, role };
}

function relay(source, destination, fail, label) {
  if (!source || !destination || source === destination) throw new Error(`${label} relay invalid`);
  source.on("end", () => fail(new Error(`${label} source ended`)));
  source.on("close", () => fail(new Error(`${label} source closed`)));
  destination.on("finish", () => fail(new Error(`${label} destination finished`)));
  source.pipe(destination);
}

async function boundedExit(record) {
  if (record.closed) return true;
  const exitsWithin = (milliseconds) => deadline(record.close.then(() => true),
    "child close", milliseconds).catch(() => false);
  try { record.pipes.lifeline.end(); } catch {}
  if (await exitsWithin(EXIT_TIMEOUT_MS)) return true;
  try { record.child.kill("SIGTERM"); } catch {}
  if (await exitsWithin(EXIT_TIMEOUT_MS)) return true;
  try { record.child.kill("SIGKILL"); } catch {}
  return exitsWithin(EXIT_TIMEOUT_MS);
}

function basePins(input, role, pid) {
  return { expectedBootstrapHash: input.cohortBootstraps[role].bootstrapHash,
    expectedLauncherNonce: input.expectedLauncherNonce, expectedPid: pid,
    expectedReleaseProvenanceHash: input.expectedReleaseProvenanceHash,
    expectedRole: role, expectedSessionHash: input.expectedSessionHash };
}

function live(records, closing) {
  if (closing()) throw new Error("validator readiness three-process cohort is unavailable");
  for (const record of records) {
    if (record.closed || record.child.exitCode !== null || record.child.signalCode !== null) {
      throw new Error("validator readiness three-process child is unavailable");
    }
    for (const [name, stream] of Object.entries(record.pipes)) {
      if (!EPHEMERAL_PIPES.has(name) && (stream.destroyed || stream.readableEnded ||
          stream.writableEnded || stream.writableFinished)) {
        throw new Error("validator readiness three-process channel is unavailable");
      }
    }
  }
}

/**
 * Atomically launch one fixed readiness cohort. listenerFd is a one-time transferred, already
 * bound socket descriptor: the caller must never use it after invocation. This launcher does not
 * create the listener, read paths, accept caller-provided child commands, or expose child handles.
 */
export async function launchValidatorReadinessThreeProcess(options = {}) {
  const callerSecrets = secretBuffers(options);
  const copies = new Map(); const records = [];
  let transferredFd = null; let state = "starting"; let closing = false;
  let teardownPromise = null; let terminalResolve; let updating = false;
  const terminal = new Promise((resolve) => { terminalResolve = resolve; });
  const teardown = (reason) => {
    if (teardownPromise) return teardownPromise;
    closing = true; state = reason;
    if (transferredFd !== null) {
      try { closeSync(transferredFd); } catch {}
      transferredFd = null;
    }
    for (const record of records) {
      try { record.pipes.lifeline.end(); } catch {}
      try { record.pipes.control.destroy(); } catch {}
      for (const key of Object.keys(record.pipes)) {
        if (key.includes("Request") || key.includes("Response") ||
            key === "request" || key === "response") {
          try { record.pipes[key].destroy(); } catch {}
        }
      }
    }
    teardownPromise = (async () => {
      const stopped = await Promise.all(records.map(boundedExit));
      for (const record of records) {
        for (const stream of Object.values(record.pipes)) {
          try { stream.destroy(); } catch {}
        }
      }
      state = stopped.every(Boolean) ? reason : "failed";
      terminalResolve(Object.freeze({ reason: state }));
    })();
    return teardownPromise;
  };
  const fail = () => { if (!closing) void teardown("failed"); };
  try {
    const accepted = exactOptions(options);
    transferredFd = acceptListenerFd(accepted.listenerFd);
    const trusted = trustedPins(accepted.trustedPins);
    const derived = deriveValidatorReadinessTrustedPins(accepted.trustedEvidence,
      accepted.gatewayInput?.cohortBootstraps);
    if (canonicalJson(derived) !== canonicalJson(trusted)) {
      throw new Error("validator readiness trusted pins disagree with signed evidence");
    }
    for (const key of SECRET_KEYS) validateBuffer(accepted[key], key,
      key.includes("Password") ? 1_024 : 1024 * 1024);
    for (let left = 0; left < SECRET_KEYS.length; left += 1) {
      for (let right = left + 1; right < SECRET_KEYS.length; right += 1) {
        if (overlap(accepted[SECRET_KEYS[left]], accepted[SECRET_KEYS[right]])) {
          throw new Error("validator readiness secret buffers overlap");
        }
      }
    }
    for (const key of SECRET_KEYS) copies.set(key, Buffer.from(accepted[key]));
    for (const key of SECRET_KEYS) accepted[key].fill(0);
    const inputs = validatedInputs(accepted, trusted);
    checkCertificate(copies.get("tlsCertificateBuffer"), copies.get("tlsKeyBuffer"),
      trusted.expectedTlsCertificateSha256);

    for (const role of ROLES) records.push(childRecord(role, fail));
    const byRole = Object.fromEntries(records.map((record) => [record.role, record]));
    records.push(childRecord("gateway", fail, transferredFd));
    byRole.gateway = records[2];
    closeSync(transferredFd); transferredFd = null;
    relay(byRole.gateway.pipes.transportRequest, byRole.transport.pipes.request, fail,
      "transport request");
    relay(byRole.transport.pipes.response, byRole.gateway.pipes.transportResponse, fail,
      "transport response");
    relay(byRole.gateway.pipes.consensusRequest, byRole.consensus.pipes.request, fail,
      "consensus request");
    relay(byRole.consensus.pipes.response, byRole.gateway.pipes.consensusResponse, fail,
      "consensus response");

    const runtimeInput = createValidatorReadinessGatewayRuntimeInput({
      expectedConsensusPid: byRole.consensus.child.pid,
      expectedGatewayPid: byRole.gateway.child.pid,
      expectedTransportPid: byRole.transport.child.pid,
      gatewayInput: inputs.gateway,
    }, { now: Date.now() });
    const writes = await Promise.allSettled([
      write(byRole.consensus.pipes.bootstrap,
        encodeValidatorReadinessSignerChildFrame(inputs.consensus), "consensus bootstrap", true),
      write(byRole.transport.pipes.bootstrap,
        encodeValidatorReadinessSignerChildFrame(inputs.transport), "transport bootstrap", true),
      write(byRole.consensus.pipes.password, copies.get("consensusPasswordBuffer"),
        "consensus password", true),
      write(byRole.transport.pipes.password, copies.get("transportPasswordBuffer"),
        "transport password", true),
      write(byRole.gateway.pipes.bootstrap,
        encodeValidatorReadinessGatewayChildFrame(runtimeInput), "gateway bootstrap", true),
      write(byRole.gateway.pipes.tlsKey, copies.get("tlsKeyBuffer"), "gateway TLS key", true),
      write(byRole.gateway.pipes.tlsCertificate, copies.get("tlsCertificateBuffer"),
        "gateway TLS certificate", true),
    ]);
    if (writes.some((result) => result.status === "rejected")) {
      throw new Error("validator readiness child input delivery failed");
    }
    for (const copy of copies.values()) copy.fill(0);
    const [consensusReady, transportReady, gatewayReady] = await Promise.all([
      byRole.consensus.inbox.next("ready", "consensus READY"),
      byRole.transport.inbox.next("ready", "transport READY"),
      byRole.gateway.inbox.next("ready", "gateway READY"),
    ]);
    live(records, () => closing);
    const readiness = {
      consensus: verifyValidatorReadinessSignerReady(consensusReady,
        { ...basePins(inputs.consensus, "consensus", byRole.consensus.child.pid),
          bootstrap: inputs.consensus.cohortBootstraps.consensus, now: Date.now() }),
      transport: verifyValidatorReadinessSignerReady(transportReady,
        { ...basePins(inputs.transport, "transport", byRole.transport.child.pid),
          bootstrap: inputs.transport.cohortBootstraps.transport, now: Date.now() }),
      gateway: verifyValidatorReadinessGatewayRuntimeReady(gatewayReady, {
        ...basePins(inputs.gateway, "gateway", byRole.gateway.child.pid),
        expectedBoundHost: inputs.gateway.expectedBoundHost,
        expectedBoundPort: inputs.gateway.expectedBoundPort,
        expectedTlsCertificateSha256: inputs.gateway.cohortBootstraps.gateway.tlsCertificateSha256,
      }),
    };
    const pins = { expectedBootstrapHash: inputs.gateway.expectedBootstrapHash,
      expectedBoundHost: inputs.gateway.expectedBoundHost,
      expectedBoundPort: inputs.gateway.expectedBoundPort,
      expectedConsensusPid: byRole.consensus.child.pid,
      expectedGatewayPid: byRole.gateway.child.pid,
      expectedLauncherNonce: inputs.gateway.expectedLauncherNonce,
      expectedReleaseProvenanceHash: inputs.gateway.expectedReleaseProvenanceHash,
      expectedSessionHash: inputs.gateway.expectedSessionHash,
      expectedTransportPid: byRole.transport.child.pid };
    const prepare = createValidatorReadinessGatewayPrepareCommand({
      gatewayInput: inputs.gateway, gatewayReady: readiness.gateway, readiness,
    }, pins, { now: Date.now() });
    const preparePromise = byRole.gateway.inbox.next("prepare-ack", "gateway PREPARE_ACK");
    await write(byRole.gateway.pipes.control, encodeValidatorReadinessGatewayChildFrame(prepare),
      "gateway PREPARE");
    const prepareAcknowledgement = verifyValidatorReadinessGatewayPrepareAcknowledgement(
      await preparePromise, { expectedPrepare: prepare, gatewayInput: inputs.gateway,
        gatewayReady: readiness.gateway, ...pins }, { now: Date.now() });
    live(records, () => closing);
    const signerAcknowledgements = {};
    for (const role of ROLES) {
      const input = inputs[role]; const record = byRole[role];
      const command = createValidatorReadinessSignerActivationCommand({
        activation: prepare.activations[role], readiness,
      }, { expectedRole: role, signerInput: input, now: Date.now() });
      const ackPromise = record.inbox.next("activation-ack", `${role} activation ACK`);
      await write(record.pipes.control, encodeValidatorReadinessRuntimeFrame(command),
        `${role} activation`);
      signerAcknowledgements[role] = verifyValidatorReadinessSignerActivationAcknowledgement(
        await ackPromise, { ...basePins(input, role, record.child.pid),
          expectedProcessNonce: readiness[role].processNonce,
          expectedActivation: prepare.activations[role] });
      live(records, () => closing);
    }
    const commit = createValidatorReadinessGatewayCommitCommand({ gatewayInput: inputs.gateway,
      gatewayReady: readiness.gateway, prepare, prepareAcknowledgement,
      signerAcknowledgements }, pins, { now: Date.now() });
    const commitPromise = byRole.gateway.inbox.next("commit-ack", "gateway COMMIT_ACK",
      "active-ack");
    await write(byRole.gateway.pipes.control, encodeValidatorReadinessGatewayChildFrame(commit),
      "gateway COMMIT");
    const commitAcknowledgement = verifyValidatorReadinessGatewayCommitAcknowledgement(
      await commitPromise, {
      expectedCommit: commit, expectedPrepare: prepare,
      expectedPrepareAcknowledgement: prepareAcknowledgement,
      gatewayInput: inputs.gateway, gatewayReady: readiness.gateway, ...pins,
    }, { now: Date.now() });
    const activeAcknowledgement = verifyValidatorReadinessGatewayActiveAcknowledgement(
      await byRole.gateway.inbox.next("active-ack", "gateway ACTIVE_ACK"), {
        expectedCommit: commit, expectedCommitAcknowledgement: commitAcknowledgement,
        expectedPrepare: prepare, expectedPrepareAcknowledgement: prepareAcknowledgement,
        gatewayInput: inputs.gateway, gatewayReady: readiness.gateway, ...pins,
      }, { now: Date.now() });
    live(records, () => closing);
    state = "active";
    const previousUpdates = { consensus: null, transport: null };
    const updateHeight = async (height) => {
      if (state !== "active" || updating) throw new Error("readiness height update unavailable");
      updating = true;
      try {
        const acknowledgements = {};
        for (const role of ROLES) {
          const record = byRole[role];
          const heightUpdate = createValidatorReadinessHeightUpdate({
            bootstrap: inputs[role].cohortBootstraps[role], height,
            previousUpdate: previousUpdates[role],
          }, { now: Date.now() });
          const ackPromise = record.inbox.next("height-ack", `${role} height ACK`);
          await write(record.pipes.control, encodeValidatorReadinessRuntimeFrame(heightUpdate),
            `${role} height update`);
          acknowledgements[role] = verifyValidatorReadinessHeightAcknowledgement(
            await ackPromise, { ...basePins(inputs[role], role, record.child.pid),
              expectedProcessNonce: readiness[role].processNonce,
              expectedHeightUpdate: heightUpdate });
          previousUpdates[role] = heightUpdate;
          live(records, () => closing);
        }
        return deepFreeze(clone(acknowledgements));
      } catch {
        await teardown("failed");
        throw new Error("validator readiness height update failed");
      } finally { updating = false; }
    };
    return Object.freeze({
      close: () => teardown("closed"), endpoint: Object.freeze({
        host: inputs.gateway.expectedBoundHost, port: inputs.gateway.expectedBoundPort }),
      pids: Object.freeze({ consensus: byRole.consensus.child.pid,
        gateway: byRole.gateway.child.pid, transport: byRole.transport.child.pid }),
      productionActivated: true, readiness: deepFreeze(clone(readiness)), state: () => state,
      activeAcknowledgement: deepFreeze(clone(activeAcknowledgement)),
      updateHeight, waitForTermination: () => terminal,
    });
  } catch {
    await teardown("failed");
    throw new Error("validator readiness three-process launch failed");
  } finally {
    for (const copy of copies.values()) copy.fill(0);
    for (const buffer of callerSecrets) buffer.fill(0);
  }
}

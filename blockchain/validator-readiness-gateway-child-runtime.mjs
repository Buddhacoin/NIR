import { createHash, X509Certificate } from "node:crypto";
import { closeSync, fstatSync } from "node:fs";
import { Socket } from "node:net";
import process from "node:process";

import { createValidatorAdmissionReadinessServer }
  from "./validator-admission-readiness-service.mjs";
import {
  createValidatorReadinessGatewayActivationController,
  createValidatorReadinessGatewayChildFrameDecoder,
  encodeValidatorReadinessGatewayChildFrame,
  verifyValidatorReadinessGatewayPrepareCommand,
} from "./validator-readiness-gateway-child-protocol.mjs";
import { verifyValidatorReadinessGatewayRuntimeInput }
  from "./validator-readiness-gateway-runtime-input.mjs";
import {
  createValidatorReadinessFatalStatus,
  createValidatorReadinessGatewayRuntimeReady,
} from "./validator-readiness-runtime-protocol.mjs";
import {
  createValidatorReadinessConsensusSignerAdapter,
  createValidatorReadinessTransportSignerAdapter,
} from "./validator-readiness-signer-channel.mjs";
import { createValidatorReadinessSplitDuplex }
  from "./validator-readiness-split-duplex.mjs";

const FDS = Object.freeze({ bootstrap: 3, tlsKey: 4, tlsCertificate: 5, controlRead: 6,
  statusWrite: 7, transportRead: 8, transportWrite: 9, consensusRead: 10,
  consensusWrite: 11, listener: 12, lifeline: 13 });
const STARTUP_TIMEOUT_MS = 5_000;
const ACTIVATION_TIMEOUT_MS = 10_000;
const FRAME_TIMEOUT_MS = 5_000;
const WRITE_TIMEOUT_MS = 5_000;
const TEARDOWN_TIMEOUT_MS = 500;
const MAX_CONTROL_MESSAGES = 8;
const MAX_TLS_BYTES = 1024 * 1024;

class RuntimeStop extends Error {
  constructor(code) { super("validator readiness gateway child stopped"); this.code = code; }
}

function inheritedDescriptor(descriptor, { listener = false } = {}) {
  let metadata;
  try { metadata = fstatSync(descriptor); } catch { throw new RuntimeStop("channel-failed"); }
  if ((listener ? !metadata.isSocket() : (!metadata.isFIFO() && !metadata.isSocket())) ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new RuntimeStop("channel-failed");
  }
  return descriptor;
}

function closeDescriptor(descriptor) {
  try { closeSync(descriptor); } catch (error) { if (error?.code !== "EBADF") throw error; }
}

function inheritedPipe(descriptor, direction, register, ownedDescriptors, ownedHandles) {
  inheritedDescriptor(descriptor);
  let handle;
  try {
    handle = new Socket({ fd: descriptor, readable: direction === "read",
      writable: direction === "write" });
  } catch { throw new RuntimeStop("channel-failed"); }
  ownedDescriptors.add(descriptor); ownedHandles.add(handle); register(handle);
  return handle;
}

function deadline(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RuntimeStop(code)), timeoutMs); timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function boundedTeardown(promise) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, TEARDOWN_TIMEOUT_MS); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function pollBoundary() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function assertSignerChannelsLive(channels, raceStop, stopped) {
  await raceStop(pollBoundary());
  await raceStop(pollBoundary());
  if (stopped() || channels.some((channel) => !channel || channel.destroyed ||
      channel.readableEnded || channel.writableEnded || channel.writableFinished)) {
    throw new RuntimeStop("signer-unavailable");
  }
}

function writeFrame(stream, value) {
  const bytes = encodeValidatorReadinessGatewayChildFrame(value);
  return deadline(new Promise((resolve, reject) => {
    if (!stream || stream.destroyed || stream.writableEnded) {
      reject(new RuntimeStop("channel-failed")); return;
    }
    try { stream.write(bytes, (error) => error ? reject(error) : resolve()); }
    catch (error) { reject(error); }
  }), WRITE_TIMEOUT_MS, "channel-failed");
}

function readOneBootstrapFrame(stream) {
  const decoder = createValidatorReadinessGatewayChildFrameDecoder();
  return deadline(new Promise((resolve, reject) => {
    const messages = []; let ended = false; let settled = false;
    const cleanup = () => {
      stream.off("data", onData); stream.off("end", onEnd);
      stream.off("error", onError); stream.off("close", onClose);
    };
    const fail = () => {
      if (settled) return; settled = true; cleanup();
      if (!stream.destroyed) stream.destroy(); reject(new RuntimeStop("bootstrap-invalid"));
    };
    const onData = (chunk) => {
      try { messages.push(...decoder.push(chunk)); if (messages.length > 1) fail(); }
      catch { fail(); }
    };
    const onEnd = () => {
      ended = true;
      try { decoder.finish(); } catch { fail(); return; }
      if (settled) return;
      if (messages.length !== 1) { fail(); return; }
      settled = true; cleanup(); resolve(messages[0]);
    };
    const onError = () => fail();
    const onClose = () => { if (!ended) fail(); };
    stream.on("data", onData); stream.once("end", onEnd);
    stream.once("error", onError); stream.once("close", onClose);
  }), STARTUP_TIMEOUT_MS, "bootstrap-invalid");
}

function readOneSecret(stream, label) {
  return deadline(new Promise((resolve, reject) => {
    const chunks = []; let total = 0; let ended = false; let settled = false;
    const clear = () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
    const cleanup = () => {
      stream.off("data", onData); stream.off("end", onEnd);
      stream.off("error", onError); stream.off("close", onClose);
    };
    const fail = () => {
      if (settled) return; settled = true; cleanup(); clear();
      if (!stream.destroyed) stream.destroy(); reject(new RuntimeStop("tls-invalid"));
    };
    const onData = (value) => {
      if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) { fail(); return; }
      const copy = Buffer.from(value); total += copy.length;
      if (total > MAX_TLS_BYTES) { copy.fill(0); fail(); return; }
      chunks.push(copy);
    };
    const onEnd = () => {
      ended = true;
      if (settled || total === 0) { fail(); return; }
      const value = Buffer.concat(chunks, total); clear(); settled = true; cleanup(); resolve(value);
    };
    const onError = () => fail();
    const onClose = () => { if (!ended) fail(); };
    stream.on("data", onData); stream.once("end", onEnd);
    stream.once("error", onError); stream.once("close", onClose);
  }), STARTUP_TIMEOUT_MS, label);
}

class ControlInbox {
  constructor(stream, stop) {
    this.stream = stream; this.stop = stop;
    this.decoder = createValidatorReadinessGatewayChildFrameDecoder();
    this.queue = []; this.waiter = null; this.timer = null; this.closed = false;
    this.onData = (chunk) => this.#data(chunk);
    this.onEnd = () => this.#end(); this.onError = () => this.#fail();
    this.onClose = () => { if (!this.closed) this.#fail(); };
    stream.on("data", this.onData); stream.once("end", this.onEnd);
    stream.once("error", this.onError); stream.once("close", this.onClose);
  }
  #data(chunk) {
    if (this.closed) return;
    const pending = this.decoder.hasPendingFrame(); let messages;
    try { messages = this.decoder.push(chunk); } catch { this.#fail(); return; }
    if (pending && !this.decoder.hasPendingFrame()) { clearTimeout(this.timer); this.timer = null; }
    if (!pending && this.decoder.hasPendingFrame()) {
      this.timer = setTimeout(() => this.stop("channel-failed"), FRAME_TIMEOUT_MS);
      this.timer.unref?.();
    }
    for (const message of messages) {
      if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve(message); }
      else {
        if (this.queue.length >= MAX_CONTROL_MESSAGES) { this.#fail(); return; }
        this.queue.push(message);
      }
    }
  }
  #fail() { this.quiesce(); this.stop("channel-failed"); }
  #end() {
    clearTimeout(this.timer); this.timer = null;
    try { this.decoder.finish(); } catch { this.#fail(); return; }
    this.#fail();
  }
  next(timeoutMs = 0) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.waiter || this.closed) return Promise.reject(new RuntimeStop("channel-failed"));
    const promise = new Promise((resolve) => { this.waiter = resolve; });
    return timeoutMs === 0 ? promise : deadline(promise, timeoutMs, "channel-failed");
  }
  hasQueuedOrPartial() { return this.queue.length !== 0 || this.decoder.hasPendingFrame(); }
  quiesce() { this.closed = true; clearTimeout(this.timer); this.timer = null; this.stream.pause?.(); }
  destroy() {
    this.quiesce(); this.waiter = null;
    this.stream.off("data", this.onData); this.stream.off("end", this.onEnd);
    this.stream.off("error", this.onError); this.stream.off("close", this.onClose);
  }
}

function inputPins(input) {
  return { expectedBootstrapHash: input.expectedBootstrapHash,
    expectedBoundHost: input.expectedBoundHost, expectedBoundPort: input.expectedBoundPort,
    expectedLauncherNonce: input.expectedLauncherNonce,
    expectedReleaseProvenanceHash: input.expectedReleaseProvenanceHash,
    expectedSessionHash: input.expectedSessionHash };
}

function protocolPins(input, ready, runtimeInput) {
  return { ...inputPins(input),
    expectedConsensusPid: runtimeInput.expectedConsensusPid,
    expectedGatewayPid: ready.pid,
    expectedTransportPid: runtimeInput.expectedTransportPid };
}

function statusPins(input, ready) {
  return { expectedBootstrapHash: input.expectedBootstrapHash,
    expectedLauncherNonce: input.expectedLauncherNonce, expectedPid: ready.pid,
    expectedProcessNonce: ready.processNonce,
    expectedReleaseProvenanceHash: input.expectedReleaseProvenanceHash,
    expectedRole: "gateway", expectedSessionHash: input.expectedSessionHash };
}

function deferredSigner(identity, method) {
  let delegate = null; let closed = false;
  return Object.freeze({ ...identity,
    close() { closed = true; delegate = null; },
    install(value) {
      if (closed || delegate || !value || typeof value[method] !== "function" ||
          value.address !== identity.address || value.algorithm !== identity.algorithm ||
          value.publicKey !== identity.publicKey) {
        throw new Error("validator readiness gateway signer delegate is invalid");
      }
      delegate = value;
    },
    async [method](value) {
      if (closed || !delegate) throw new Error("validator readiness gateway signer is unavailable");
      return delegate[method](value);
    },
  });
}

function listenInherited(server, descriptor, input) {
  inheritedDescriptor(descriptor, { listener: true });
  return deadline(new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string" || address.address !== input.expectedBoundHost ||
          address.port !== input.expectedBoundPort) {
        reject(new RuntimeStop("listener-failed")); return;
      }
      resolve();
    };
    server.once("error", onError); server.once("listening", onListening);
    try { server.listen({ exclusive: true, fd: descriptor }); } catch (error) { onError(error); }
  }), STARTUP_TIMEOUT_MS, "listener-failed");
}

export async function runValidatorReadinessGatewayChildProcess() {
  const resources = new Set(); const ownedDescriptors = new Set(); const ownedHandles = new Set();
  let input = null; let runtimeInput = null; let ready = null; let inbox = null; let statusChannel = null;
  let server = null; let tlsKey = null; let tlsCertificate = null; let controller = null;
  let transportChannel = null; let consensusChannel = null;
  let stopped = false; let stopResolve; let failure = null; let listenerOwned = false;
  const stoppedPromise = new Promise((resolve) => { stopResolve = resolve; });
  const register = (resource) => { resources.add(resource); return resource; };
  const stop = (code) => {
    if (stopped) return;
    stopped = true; inbox?.quiesce(); failure = new RuntimeStop(code); stopResolve(failure);
    try { server?.close(); } catch {}
  };
  const raceStop = async (promise) => {
    const result = await Promise.race([promise.then((value) => ({ value })),
      stoppedPromise.then((error) => ({ error }))]);
    if (result.error) throw result.error;
    return result.value;
  };

  const lifeline = inheritedPipe(FDS.lifeline, "read", register, ownedDescriptors, ownedHandles);
  let lifelineEnded = false;
  lifeline.on("data", () => stop("channel-failed"));
  lifeline.once("end", () => { lifelineEnded = true; stop("shutdown"); });
  lifeline.once("error", () => stop("channel-failed"));
  lifeline.once("close", () => { if (!lifelineEnded) stop("shutdown"); });
  const onSignal = () => stop("shutdown");
  process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);

  try {
    for (const descriptor of Object.values(FDS)) inheritedDescriptor(descriptor,
      { listener: descriptor === FDS.listener });

    const transportRead = inheritedPipe(FDS.transportRead, "read", register,
      ownedDescriptors, ownedHandles);
    const transportWrite = inheritedPipe(FDS.transportWrite, "write", register,
      ownedDescriptors, ownedHandles);
    const consensusRead = inheritedPipe(FDS.consensusRead, "read", register,
      ownedDescriptors, ownedHandles);
    const consensusWrite = inheritedPipe(FDS.consensusWrite, "write", register,
      ownedDescriptors, ownedHandles);
    const preCommitData = () => stop("channel-failed");
    for (const stream of [transportRead, consensusRead]) {
      stream.on("data", preCommitData); stream.once("end", preCommitData);
      stream.once("error", preCommitData);
    }
    for (const stream of [transportWrite, consensusWrite]) stream.once("error", preCommitData);

    const bootstrapInput = inheritedPipe(FDS.bootstrap, "read", register,
      ownedDescriptors, ownedHandles);
    const rawInput = await raceStop(readOneBootstrapFrame(bootstrapInput));
    try {
      runtimeInput = verifyValidatorReadinessGatewayRuntimeInput(rawInput, { now: Date.now() });
      if (runtimeInput.expectedGatewayPid !== process.pid) throw new Error("PID mismatch");
      input = runtimeInput.gatewayInput;
    } catch { throw new RuntimeStop("bootstrap-invalid"); }

    const keyInput = inheritedPipe(FDS.tlsKey, "read", register,
      ownedDescriptors, ownedHandles);
    const certificateInput = inheritedPipe(FDS.tlsCertificate, "read", register,
      ownedDescriptors, ownedHandles);
    [tlsKey, tlsCertificate] = await raceStop(Promise.all([
      readOneSecret(keyInput, "tls-invalid"), readOneSecret(certificateInput, "tls-invalid"),
    ]));
    try {
      const fingerprint = createHash("sha256")
        .update(new X509Certificate(tlsCertificate).raw).digest("hex");
      if (fingerprint !== input.cohortBootstraps.gateway.tlsCertificateSha256) {
        throw new Error("certificate mismatch");
      }
    } catch { throw new RuntimeStop("tls-invalid"); }

    const session = input.cohortBootstraps.gateway.rolePackage.session;
    const transportProxy = deferredSigner(session.context.transport, "signReadinessTransport");
    const consensusProxy = deferredSigner(session.context.candidate, "signReadinessConsensus");
    server = createValidatorAdmissionReadinessServer({ consensusSigner: consensusProxy,
      transportSigner: transportProxy, validators: session.validators }, {
      ...input.cohortBootstraps.gateway.limits, active: false,
      tls: { cert: tlsCertificate, key: tlsKey },
    });
    tlsKey.fill(0); tlsCertificate.fill(0); tlsKey = null; tlsCertificate = null;
    await raceStop(listenInherited(server, FDS.listener, input)); listenerOwned = true;

    ready = createValidatorReadinessGatewayRuntimeReady({ boundHost: input.expectedBoundHost,
      boundPort: input.expectedBoundPort, bootstrap: input.cohortBootstraps.gateway,
      pid: process.pid }, { expectedBootstrapHash: input.expectedBootstrapHash,
      expectedLauncherNonce: input.expectedLauncherNonce,
      expectedReleaseProvenanceHash: input.expectedReleaseProvenanceHash,
      expectedRole: "gateway", expectedSessionHash: input.expectedSessionHash });

    const controlInput = inheritedPipe(FDS.controlRead, "read", register,
      ownedDescriptors, ownedHandles);
    const statusOutput = inheritedPipe(FDS.statusWrite, "write", register,
      ownedDescriptors, ownedHandles);
    statusChannel = register(createValidatorReadinessSplitDuplex({ readable: controlInput,
      writable: statusOutput }, { label: "validator readiness gateway control",
      maxPendingBytes: 4 * 1024 * 1024, writeTimeoutMs: WRITE_TIMEOUT_MS }));
    inbox = new ControlInbox(statusChannel, stop);
    await raceStop(writeFrame(statusChannel, ready));

    const rawPrepare = await raceStop(inbox.next(ACTIVATION_TIMEOUT_MS));
    let prepare;
    try {
      prepare = verifyValidatorReadinessGatewayPrepareCommand(rawPrepare, {
        gatewayInput: input, gatewayReady: ready, ...protocolPins(input, ready, runtimeInput),
      }, { now: Date.now() });
      controller = createValidatorReadinessGatewayActivationController({ gatewayInput: input,
        gatewayReady: ready }, protocolPins(input, ready, runtimeInput), { now: () => Date.now() });
    } catch { throw new RuntimeStop("channel-failed"); }
    if (inbox.hasQueuedOrPartial() || stopped) throw new RuntimeStop("channel-failed");
    const prepareAck = controller.prepare(prepare);

    for (const stream of [transportRead, consensusRead]) {
      stream.off("data", preCommitData); stream.off("end", preCommitData);
      stream.off("error", preCommitData); stream.pause();
    }
    for (const stream of [transportWrite, consensusWrite]) stream.off("error", preCommitData);
    transportChannel = register(createValidatorReadinessSplitDuplex({ readable: transportRead,
      writable: transportWrite }, { label: "validator readiness gateway transport signer",
      maxPendingBytes: 1024 * 1024,
      writeTimeoutMs: input.cohortBootstraps.gateway.limits.responseTimeoutMs }));
    consensusChannel = register(createValidatorReadinessSplitDuplex({ readable: consensusRead,
      writable: consensusWrite }, { label: "validator readiness gateway consensus signer",
      maxPendingBytes: 1024 * 1024,
      writeTimeoutMs: input.cohortBootstraps.gateway.limits.responseTimeoutMs }));
    for (const channel of [transportChannel, consensusChannel]) {
      channel.once("error", () => stop("channel-failed"));
      channel.once("end", () => stop("channel-failed"));
      channel.once("close", () => { if (!stopped) stop("channel-failed"); });
    }
    try {
      transportProxy.install(createValidatorReadinessTransportSignerAdapter({
        bootstrap: input.cohortBootstraps.transport,
        expectedLauncherNonce: input.expectedLauncherNonce,
        expectedPid: prepare.readiness.transport.pid,
        expectedReleaseProvenanceHash: input.expectedReleaseProvenanceHash,
        expectedSessionHash: input.expectedSessionHash,
        gatewayRolePackage: input.cohortBootstraps.gateway.rolePackage,
        signerReady: prepare.readiness.transport, stream: transportChannel,
        timeoutMs: input.cohortBootstraps.gateway.limits.responseTimeoutMs,
      }));
      consensusProxy.install(createValidatorReadinessConsensusSignerAdapter({
        bootstrap: input.cohortBootstraps.consensus,
        expectedLauncherNonce: input.expectedLauncherNonce,
        expectedPid: prepare.readiness.consensus.pid,
        expectedReleaseProvenanceHash: input.expectedReleaseProvenanceHash,
        expectedSessionHash: input.expectedSessionHash,
        gatewayRolePackage: input.cohortBootstraps.gateway.rolePackage,
        signerReady: prepare.readiness.consensus, stream: consensusChannel,
        timeoutMs: input.cohortBootstraps.gateway.limits.responseTimeoutMs,
      }));
    } catch { throw new RuntimeStop("signer-unavailable"); }
    await raceStop(writeFrame(statusChannel, prepareAck));
    controller.prepareAcknowledgementFlushed(prepareAck);
    if (inbox.hasQueuedOrPartial() || stopped) throw new RuntimeStop("channel-failed");

    const commit = await raceStop(inbox.next(ACTIVATION_TIMEOUT_MS));
    let commitAck;
    try { commitAck = controller.commit(commit); }
    catch { throw new RuntimeStop("channel-failed"); }
    if (inbox.hasQueuedOrPartial() || stopped) throw new RuntimeStop("channel-failed");
    await assertSignerChannelsLive([transportChannel, consensusChannel], raceStop, () => stopped);
    await raceStop(writeFrame(statusChannel, commitAck));
    controller.commitAcknowledgementFlushed(commitAck);
    if (inbox.hasQueuedOrPartial() || stopped) throw new RuntimeStop("channel-failed");
    await assertSignerChannelsLive([transportChannel, consensusChannel], raceStop, () => stopped);
    server.validatorAdmissionReadinessActivate();

    await raceStop(inbox.next());
    throw new RuntimeStop("channel-failed");
  } catch (error) {
    const stopError = error instanceof RuntimeStop ? error
      : new RuntimeStop(failure?.code ?? "internal-failure");
    // Deactivate the externally reachable service before attempting the best-effort fatal status.
    // A stalled launcher status reader must never extend the signing lifetime after a terminal
    // protocol error.
    if (!stopped) stop(stopError.code);
    if (ready && input && statusChannel && !statusChannel.destroyed) {
      try { await writeFrame(statusChannel, createValidatorReadinessFatalStatus({
        code: stopError.code }, statusPins(input, ready))); } catch {}
    }
    if (stopError.code !== "shutdown") {
      throw new Error("validator readiness gateway child terminated");
    }
  } finally {
    process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal);
    tlsKey?.fill(0); tlsCertificate?.fill(0); tlsKey = null; tlsCertificate = null;
    try { controller?.close(); } catch {}
    inbox?.destroy();
    if (server) {
      try { await boundedTeardown(server.gracefulShutdown?.(TEARDOWN_TIMEOUT_MS)); } catch {}
    }
    const handleClosures = [...ownedHandles].map((handle) => handle.closed
      ? Promise.resolve() : new Promise((resolve) => handle.once("close", resolve)));
    for (const resource of resources) {
      try { resource.on?.("error", () => {}); if (!resource.destroyed) resource.destroy(); } catch {}
    }
    if (handleClosures.length > 0) await boundedTeardown(Promise.all(handleClosures));
    for (const descriptor of Object.values(FDS)) {
      if (descriptor === FDS.listener && listenerOwned) continue;
      if (!ownedDescriptors.has(descriptor)) { try { closeDescriptor(descriptor); } catch {} }
    }
    server = null; controller = null; input = null; runtimeInput = null; ready = null;
  }
}

export const VALIDATOR_READINESS_GATEWAY_CHILD_FDS = FDS;

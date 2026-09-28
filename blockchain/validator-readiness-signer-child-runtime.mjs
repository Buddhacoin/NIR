import {
  closeSync,
  fstatSync,
} from "node:fs";
import { Socket } from "node:net";
import process from "node:process";

import { readOneTimePasswordFd } from "./operator-secret-input.mjs";
import {
  createValidatorReadinessHeightAcknowledgement,
  createValidatorReadinessFatalStatus,
  createValidatorReadinessRuntimeFrameDecoder,
  encodeValidatorReadinessRuntimeFrame,
} from "./validator-readiness-runtime-protocol.mjs";
import {
  createValidatorReadinessSignerReadyWithCapability,
  verifyValidatorReadinessHeightUpdate,
} from "./validator-readiness-process-protocol.mjs";
import {
  createValidatorReadinessConsensusSignerEndpoint,
  createValidatorReadinessTransportSignerEndpoint,
} from "./validator-readiness-signer-channel.mjs";
import {
  createValidatorReadinessSignerActivationAcknowledgement,
  createValidatorReadinessSignerChildFrameDecoder,
  verifyValidatorReadinessSignerActivationCommand,
  verifyValidatorReadinessSignerChildInput,
} from "./validator-readiness-signer-child-protocol.mjs";
import { createValidatorReadinessSignerCustody }
  from "./validator-readiness-signer-custody.mjs";
import { createValidatorReadinessSplitDuplex }
  from "./validator-readiness-split-duplex.mjs";

const FDS = Object.freeze({ bootstrap: 3, password: 4, controlRead: 5, statusWrite: 6,
  signerRead: 7, signerWrite: 8, lifeline: 9 });
const STARTUP_TIMEOUT_MS = 5_000;
const ACTIVATION_TIMEOUT_MS = 10_000;
const CONTROL_FRAME_TIMEOUT_MS = 5_000;
const STATUS_WRITE_TIMEOUT_MS = 5_000;
const TEARDOWN_TIMEOUT_MS = 250;
const MAX_CONTROL_MESSAGES = 32;
const SIGNER_ROLES = new Set(["consensus", "transport"]);

class RuntimeStop extends Error {
  constructor(code) { super("validator readiness signer child stopped"); this.code = code; }
}

function role(value) {
  if (!SIGNER_ROLES.has(value)) throw new RuntimeStop("bootstrap-invalid");
  return value;
}

function inheritedDescriptor(descriptor, label) {
  let metadata;
  try { metadata = fstatSync(descriptor); } catch { throw new RuntimeStop("channel-failed"); }
  if ((!metadata.isFIFO() && !metadata.isSocket()) ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new RuntimeStop("channel-failed");
  }
  return descriptor;
}

function closeDescriptor(descriptor) {
  try { closeSync(descriptor); } catch (error) { if (error?.code !== "EBADF") throw error; }
}

function inheritedPipe(descriptor, direction, register, ownedDescriptors, ownedHandles) {
  inheritedDescriptor(descriptor, "channel");
  let handle;
  try {
    handle = new Socket({ fd: descriptor, readable: direction === "read",
      writable: direction === "write" });
  } catch {
    throw new RuntimeStop("channel-failed");
  }
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
  // Unlike operational deadlines, this timer must stay referenced: it is the final guarantee that
  // an unresolved platform close notification cannot strand top-level await before the CLI exits.
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, TEARDOWN_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function writeFrame(stream, value) {
  const bytes = encodeValidatorReadinessRuntimeFrame(value);
  return deadline(new Promise((resolve, reject) => {
    if (!stream || stream.destroyed || stream.writableEnded) {
      reject(new RuntimeStop("channel-failed")); return;
    }
    try { stream.write(bytes, (error) => error ? reject(error) : resolve()); }
    catch (error) { reject(error); }
  }), STATUS_WRITE_TIMEOUT_MS, "channel-failed");
}

function readOneBootstrapFrame(stream) {
  const decoder = createValidatorReadinessSignerChildFrameDecoder();
  return deadline(new Promise((resolve, reject) => {
    let ended = false; let settled = false; const messages = [];
    const cleanup = () => {
      stream.off("data", onData); stream.off("end", onEnd);
      stream.off("error", onError); stream.off("close", onClose);
    };
    const fail = () => {
      if (settled) return; settled = true; cleanup();
      if (!stream.destroyed) stream.destroy(); reject(new RuntimeStop("bootstrap-invalid"));
    };
    const onData = (chunk) => {
      try {
        messages.push(...decoder.push(chunk));
        if (messages.length > 1) fail();
      } catch { fail(); }
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

class ControlInbox {
  constructor(stream, stop) {
    this.stream = stream; this.stop = stop; this.decoder = createValidatorReadinessRuntimeFrameDecoder();
    this.queue = []; this.waiter = null; this.timer = null; this.closed = false;
    this.onData = (chunk) => this.#data(chunk);
    this.onEnd = () => this.#end();
    this.onError = () => this.#fail();
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
      this.timer = setTimeout(() => this.stop("channel-failed"), CONTROL_FRAME_TIMEOUT_MS);
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

  quiesce() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); this.timer = null;
    this.stream.pause?.();
  }

  destroy() {
    this.quiesce(); this.waiter = null;
    this.stream.off("data", this.onData); this.stream.off("end", this.onEnd);
    this.stream.off("error", this.onError); this.stream.off("close", this.onClose);
  }
}

function statusPins(input, ready) {
  return { expectedBootstrapHash: input.cohortBootstraps[input.role].bootstrapHash,
    expectedLauncherNonce: input.expectedLauncherNonce, expectedPid: ready.pid,
    expectedProcessNonce: ready.processNonce,
    expectedReleaseProvenanceHash: input.expectedReleaseProvenanceHash,
    expectedRole: input.role, expectedSessionHash: input.expectedSessionHash };
}

function activeSigner(custody, signerRole, isStopped) {
  const guarded = Object.assign(Object.create(null), {
    address: custody.address, algorithm: custody.algorithm, publicKey: custody.publicKey,
  });
  const beforeKeyOperation = async () => {
    // Let already-readable lifeline/control events win over newly arrived signer work. Two check
    // phases guarantee an intervening poll even when the signer descriptor was delivered first.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    if (isStopped()) throw new Error("validator readiness signer child is stopping");
  };
  if (signerRole === "transport") {
    guarded.signReadinessTransportInput = async (value, options) => {
      await beforeKeyOperation();
      return custody.signReadinessTransportInput(value, options);
    };
  } else {
    guarded.signReadinessConsensusInput = async (value, options) => {
      await beforeKeyOperation();
      return custody.signReadinessConsensusInput(value, options);
    };
  }
  return Object.freeze(guarded);
}

export async function runValidatorReadinessSignerChildProcess(expectedRole) {
  expectedRole = role(expectedRole);
  const resources = new Set(); const ownedDescriptors = new Set(); const ownedHandles = new Set();
  let endpoint = null; let inbox = null; let input = null;
  let ownReady = null; let passwordBuffer = null; let signer = null; let statusChannel = null;
  let dataChannel = null; let requestInput = null; let responseOutput = null;
  let stopped = false; let stopResolve; let failure = null;
  const stoppedPromise = new Promise((resolve) => { stopResolve = resolve; });
  const register = (resource) => { resources.add(resource); return resource; };
  const stop = (code) => {
    if (stopped) return;
    stopped = true; inbox?.quiesce(); requestInput?.pause?.();
    failure = new RuntimeStop(code); stopResolve(failure);
  };
  const raceStop = async (promise) => {
    const result = await Promise.race([promise.then((value) => ({ value })),
      stoppedPromise.then((error) => ({ error }))]);
    if (result.error) throw result.error;
    return result.value;
  };
  const lifeline = inheritedPipe(FDS.lifeline, "read", register,
    ownedDescriptors, ownedHandles);
  let lifelineEnded = false;
  lifeline.on("data", () => stop("channel-failed"));
  lifeline.once("end", () => { lifelineEnded = true; stop("shutdown"); });
  lifeline.once("error", () => stop("channel-failed"));
  lifeline.once("close", () => { if (!lifelineEnded) stop("shutdown"); });
  const onSignal = () => stop("shutdown");
  process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);

  try {
    for (const descriptor of [FDS.bootstrap, FDS.password, FDS.controlRead, FDS.statusWrite,
      FDS.signerRead, FDS.signerWrite]) inheritedDescriptor(descriptor, "channel");

    requestInput = inheritedPipe(FDS.signerRead, "read", register,
      ownedDescriptors, ownedHandles);
    responseOutput = inheritedPipe(FDS.signerWrite, "write", register,
      ownedDescriptors, ownedHandles);
    const preActivationData = () => stop("channel-failed");
    requestInput.on("data", preActivationData);
    requestInput.once("end", () => stop("channel-failed"));
    requestInput.once("error", () => stop("channel-failed"));
    responseOutput.once("error", () => stop("channel-failed"));

    const bootstrapInput = inheritedPipe(FDS.bootstrap, "read", register,
      ownedDescriptors, ownedHandles);
    const rawInput = await raceStop(readOneBootstrapFrame(bootstrapInput));
    try {
      input = verifyValidatorReadinessSignerChildInput(rawInput,
        { expectedRole, now: Date.now() });
    } catch { throw new RuntimeStop("bootstrap-invalid"); }

    try {
      ownedDescriptors.add(FDS.password);
      passwordBuffer = await raceStop(readOneTimePasswordFd(FDS.password,
        `validator readiness ${expectedRole} signer`, { maximumBytes: 1_024,
          timeoutMs: STARTUP_TIMEOUT_MS }));
      signer = createValidatorReadinessSignerCustody({ encryptedVault: input.encryptedVault,
        expectedVaultCommitment: input.cohortBootstraps[expectedRole].vaultCommitment,
        passwordBuffer, role: expectedRole });
      passwordBuffer = null;
    } catch (error) {
      if (error instanceof RuntimeStop) throw error;
      throw new RuntimeStop("password-invalid");
    }

    try {
      ownReady = createValidatorReadinessSignerReadyWithCapability({
        bootstrap: input.cohortBootstraps[expectedRole], pid: process.pid, signer,
      }, { now: Date.now() });
    } catch { throw new RuntimeStop("signer-unavailable"); }

    const controlInput = inheritedPipe(FDS.controlRead, "read", register,
      ownedDescriptors, ownedHandles);
    const statusOutput = inheritedPipe(FDS.statusWrite, "write", register,
      ownedDescriptors, ownedHandles);
    statusChannel = register(createValidatorReadinessSplitDuplex({ readable: controlInput,
      writable: statusOutput }, { label: `validator readiness ${expectedRole} control`,
      maxPendingBytes: 4 * 1024 * 1024, writeTimeoutMs: STATUS_WRITE_TIMEOUT_MS }));
    inbox = new ControlInbox(statusChannel, stop);
    await raceStop(writeFrame(statusChannel, ownReady));

    const command = await raceStop(inbox.next(ACTIVATION_TIMEOUT_MS));
    let verifiedCommand;
    try {
      verifiedCommand = verifyValidatorReadinessSignerActivationCommand(command, {
        expectedOwnReady: ownReady, expectedRole, now: Date.now(), signerInput: input,
      });
    } catch { throw new RuntimeStop("channel-failed"); }
    if (inbox.hasQueuedOrPartial() || stopped) throw new RuntimeStop("channel-failed");
    const pins = statusPins(input, ownReady);
    const acknowledgement = createValidatorReadinessSignerActivationAcknowledgement({
      activation: verifiedCommand.activation,
    }, pins);
    await raceStop(writeFrame(statusChannel, acknowledgement));
    if (inbox.hasQueuedOrPartial() || stopped) throw new RuntimeStop("channel-failed");

    requestInput.off("data", preActivationData); requestInput.pause();
    dataChannel = register(createValidatorReadinessSplitDuplex({ readable: requestInput,
      writable: responseOutput }, { label: `validator readiness ${expectedRole} signer data`,
      maxPendingBytes: 1024 * 1024,
      writeTimeoutMs: input.cohortBootstraps.gateway.limits.responseTimeoutMs }));
    dataChannel.once("error", () => stop("channel-failed"));
    dataChannel.once("end", () => stop("channel-failed"));
    dataChannel.once("close", () => { if (!stopped) stop("channel-failed"); });

    let currentHeight = input.cohortBootstraps[expectedRole].initialHeight;
    let previousUpdate = null;
    const endpointOptions = { now: () => Date.now(),
      rolePackage: input.cohortBootstraps[expectedRole].rolePackage,
      signer: activeSigner(signer, expectedRole, () => stopped),
      stream: dataChannel,
      timeoutMs: input.cohortBootstraps.gateway.limits.responseTimeoutMs,
      trustedCurrentHeight: () => currentHeight };
    try {
      endpoint = expectedRole === "transport"
        ? createValidatorReadinessTransportSignerEndpoint(endpointOptions)
        : createValidatorReadinessConsensusSignerEndpoint(endpointOptions);
    } catch { throw new RuntimeStop("signer-unavailable"); }

    for (;;) {
      const message = await raceStop(inbox.next()); let update;
      if (message && typeof message === "object" && Object.hasOwn(message, "messageType")) {
        throw new RuntimeStop("channel-failed");
      }
      try {
        update = verifyValidatorReadinessHeightUpdate(message, {
          bootstrap: input.cohortBootstraps[expectedRole], expectedRole,
          expectedLauncherNonce: input.expectedLauncherNonce,
          expectedReleaseProvenanceHash: input.expectedReleaseProvenanceHash,
          expectedSessionHash: input.expectedSessionHash, now: Date.now(), previousUpdate,
        });
      } catch { throw new RuntimeStop("height-invalid"); }
      await raceStop(writeFrame(statusChannel,
        createValidatorReadinessHeightAcknowledgement({ heightUpdate: update }, pins)));
      previousUpdate = update; currentHeight = update.height;
    }
  } catch (error) {
    const stopError = error instanceof RuntimeStop ? error
      : new RuntimeStop(failure?.code ?? "internal-failure");
    if (!stopped) { stopped = true; failure = stopError; stopResolve(stopError); }
    if (ownReady && input && statusChannel && !statusChannel.destroyed) {
      try {
        await writeFrame(statusChannel, createValidatorReadinessFatalStatus({ code: stopError.code },
          statusPins(input, ownReady)));
      } catch {}
    }
    if (stopError.code !== "shutdown") {
      throw new Error("validator readiness signer child terminated");
    }
  } finally {
    process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal);
    passwordBuffer?.fill(0); passwordBuffer = null;
    try { endpoint?.close(); } catch {}
    inbox?.destroy();
    const handleClosures = [...ownedHandles].map((handle) => handle.closed
      ? Promise.resolve()
      : new Promise((resolve) => handle.once("close", resolve)));
    for (const resource of resources) {
      try {
        resource.on?.("error", () => {});
        if (!resource.destroyed) resource.destroy();
      } catch {}
    }
    if (handleClosures.length > 0) {
      await boundedTeardown(Promise.all(handleClosures));
    }
    for (const descriptor of Object.values(FDS)) {
      if (!ownedDescriptors.has(descriptor)) {
        try { closeDescriptor(descriptor); } catch {}
      }
    }
    endpoint = null; signer = null; input = null; ownReady = null;
  }
}

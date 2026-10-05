import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./crypto.mjs";
import { verifyValidatorReadinessSignerReady }
  from "./validator-readiness-process-protocol.mjs";
import { createValidatorReadinessRuntimeFrameDecoder }
  from "./validator-readiness-runtime-protocol.mjs";
import {
  encodeValidatorReadinessSignerChildFrame,
  verifyValidatorReadinessSignerChildInput,
} from "./validator-readiness-signer-child-protocol.mjs";

const SIGNER_CLI = fileURLToPath(new URL(
  "./validator-readiness-signer-child-cli.mjs", import.meta.url));
const ROLES = Object.freeze(["consensus", "transport"]);
const READY_TIMEOUT_MS = 8_000;
const WRITE_TIMEOUT_MS = 5_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 500;
const FORCED_EXIT_TIMEOUT_MS = 500;
const OPTION_KEYS = Object.freeze([
  "consensusInput", "consensusPasswordBuffer", "transportInput", "transportPasswordBuffer",
]);

function timeout(promise, milliseconds, label) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

function clone(value) { return JSON.parse(canonicalJson(value)); }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function password(value, label) {
  if (!Buffer.isBuffer(value) || value.length < 12 || value.length > 1_024) {
    throw new Error(`validator readiness ${label} password buffer is invalid`);
  }
  return value;
}

function exactOptions(value) {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("validator readiness signer cohort options are invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== OPTION_KEYS.length ||
      !OPTION_KEYS.every((key) => keys.includes(key)) || keys.some((key) => typeof key !== "string")) {
    throw new Error("validator readiness signer cohort options have unexpected fields");
  }
  for (const key of OPTION_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new Error("validator readiness signer cohort options must be data properties");
    }
  }
  return value;
}

function cleanupPasswords(value) {
  if (!value || typeof value !== "object") return [];
  try {
    return OPTION_KEYS.filter((key) => key.endsWith("PasswordBuffer"))
      .map((key) => Object.getOwnPropertyDescriptor(value, key)?.value).filter(Buffer.isBuffer);
  } catch { return []; }
}

function rangesOverlap(left, right) {
  if (left.buffer !== right.buffer) return false;
  const leftEnd = left.byteOffset + left.byteLength;
  const rightEnd = right.byteOffset + right.byteLength;
  return left.byteOffset < rightEnd && right.byteOffset < leftEnd;
}

function commonInput(left, right) {
  return left.expectedLauncherNonce === right.expectedLauncherNonce &&
    left.expectedReleaseProvenanceHash === right.expectedReleaseProvenanceHash &&
    left.expectedSessionHash === right.expectedSessionHash &&
    canonicalJson(left.cohortBootstraps) === canonicalJson(right.cohortBootstraps);
}

function writeAndEnd(stream, bytes, label) {
  return timeout(new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return; settled = true; stream.off("error", onError);
      error ? reject(error) : resolve();
    };
    const onError = (error) => finish(error);
    stream.once("error", onError);
    try { stream.end(bytes, (error) => finish(error)); } catch (error) { finish(error); }
  }), WRITE_TIMEOUT_MS, label);
}

class StatusInbox {
  constructor(stream, fail) {
    this.decoder = createValidatorReadinessRuntimeFrameDecoder(); this.messagesSeen = 0;
    this.queue = []; this.waiter = null; this.failure = null;
    const stop = (error) => {
      if (this.failure) return;
      this.failure = error instanceof Error ? error : new Error("signer status channel failed");
      this.queue.length = 0;
      if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter.reject(this.failure); }
      fail(this.failure);
    };
    stream.on("data", (chunk) => {
      if (this.messagesSeen !== 0) {
        stop(new Error("signer status channel emitted bytes after READY")); return;
      }
      let messages;
      try { messages = this.decoder.push(chunk); } catch (error) { stop(error); return; }
      if (messages.length > 1 || (messages.length === 1 && this.decoder.hasPendingFrame())) {
        stop(new Error("signer status channel did not emit exactly one READY frame")); return;
      }
      if (messages.length === 0) return;
      this.messagesSeen = 1;
      const [message] = messages;
      if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter.resolve(message); }
      else this.queue.push(message);
    });
    stream.once("error", stop);
    stream.once("end", () => {
      try { this.decoder.finish(); }
      catch (error) { stop(error); return; }
      stop(new Error("signer status channel ended"));
    });
  }

  next(label) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.waiter) return Promise.reject(new Error("signer status channel is busy"));
    return timeout(new Promise((resolve, reject) => { this.waiter = { reject, resolve }; }),
      READY_TIMEOUT_MS, label);
  }
}

function childRecord(role, fail) {
  const child = spawn(process.execPath, [SIGNER_CLI, role], {
    env: {}, stdio: ["ignore", "ignore", "ignore", ...Array.from({ length: 7 }, () => "pipe")],
  });
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
    try { child.kill("SIGKILL"); } catch {}
    throw new Error(`validator readiness ${role} signer process did not start`);
  }
  const pipes = Object.freeze({ bootstrap: child.stdio[3], password: child.stdio[4],
    control: child.stdio[5], status: child.stdio[6], request: child.stdio[7],
    response: child.stdio[8], lifeline: child.stdio[9] });
  for (const stream of Object.values(pipes)) {
    if (!stream || typeof stream.destroy !== "function") {
      try { child.kill("SIGKILL"); } catch {}
      for (const candidate of Object.values(pipes)) {
        try { candidate?.destroy?.(); } catch {}
      }
      throw new Error(`validator readiness ${role} signer channel inventory is incomplete`);
    }
    stream.on("error", () => {});
  }
  let closed = false; let closeResolve;
  const close = new Promise((resolve) => { closeResolve = resolve; });
  child.once("error", (error) => { fail(error); });
  child.once("exit", () => {
    fail(new Error(`validator readiness ${role} signer process exited`));
  });
  child.once("close", () => { closed = true; closeResolve(); });
  return { child, close, get closed() { return closed; },
    inbox: new StatusInbox(pipes.status, fail), pipes, role };
}

function uniqueChannels(records) {
  const seen = new Set();
  for (const record of records) {
    for (const stream of Object.values(record.pipes)) {
      if (seen.has(stream)) throw new Error("validator readiness signer channels are aliased");
      seen.add(stream);
    }
  }
}

function exitsWithin(record, milliseconds) {
  let timer;
  return Promise.race([
    record.close.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function boundedExit(record) {
  if (record.closed) return true;
  try { record.pipes.lifeline.end(); } catch {}
  const graceful = await exitsWithin(record, GRACEFUL_EXIT_TIMEOUT_MS);
  if (graceful) return true;
  try { record.child.kill("SIGTERM"); } catch {}
  const terminated = await exitsWithin(record, FORCED_EXIT_TIMEOUT_MS);
  if (terminated) return true;
  try { record.child.kill("SIGKILL"); } catch {}
  return exitsWithin(record, FORCED_EXIT_TIMEOUT_MS);
}

function readyPins(input, role, processId) {
  return { bootstrap: input.cohortBootstraps[role],
    expectedLauncherNonce: input.expectedLauncherNonce, expectedPid: processId,
    expectedReleaseProvenanceHash: input.expectedReleaseProvenanceHash,
    expectedRole: role, expectedSessionHash: input.expectedSessionHash, now: Date.now() };
}

/**
 * Launch and supervise the two isolated readiness signers. This intentionally has no activation
 * method: an unsigned gateway READY is trustworthy only when received from a gateway process that
 * this launcher spawned and pinned, and that production gateway runtime does not exist yet.
 */
export async function launchValidatorReadinessSignerCohort(options = {}) {
  let consensusInput; let consensusPasswordBuffer; let transportInput; let transportPasswordBuffer;
  let consensusPasswordCopy = null; let transportPasswordCopy = null;
  const passwords = cleanupPasswords(options);
  let records = []; let closing = false; let state = "starting"; let teardownPromise = null;
  let terminalResolve;
  const terminal = new Promise((resolve) => { terminalResolve = resolve; });
  const teardown = (reason) => {
    if (teardownPromise) return teardownPromise;
    closing = true; state = reason;
    teardownPromise = (async () => {
      const stopped = await Promise.all(records.map((record) => boundedExit(record)));
      for (const record of records) {
        for (const stream of Object.values(record.pipes)) {
          try { if (!stream.destroyed) stream.destroy(); } catch {}
        }
      }
      const finalReason = stopped.every(Boolean) ? reason : "failed";
      state = finalReason; terminalResolve(Object.freeze({ reason: finalReason }));
    })();
    return teardownPromise;
  };
  const fail = () => { if (!closing) void teardown("failed"); };

  try {
    ({ consensusInput, consensusPasswordBuffer, transportInput, transportPasswordBuffer } =
      exactOptions(options));
    consensusPasswordBuffer = password(consensusPasswordBuffer, "consensus");
    transportPasswordBuffer = password(transportPasswordBuffer, "transport");
    if (rangesOverlap(consensusPasswordBuffer, transportPasswordBuffer)) {
      throw new Error("validator readiness signer password buffers are aliased");
    }
    consensusPasswordCopy = Buffer.from(consensusPasswordBuffer);
    transportPasswordCopy = Buffer.from(transportPasswordBuffer);
    consensusPasswordBuffer.fill(0); transportPasswordBuffer.fill(0);
    consensusInput = verifyValidatorReadinessSignerChildInput(consensusInput,
      { expectedRole: "consensus", now: Date.now() });
    transportInput = verifyValidatorReadinessSignerChildInput(transportInput,
      { expectedRole: "transport", now: Date.now() });
    if (!commonInput(consensusInput, transportInput)) {
      throw new Error("validator readiness signer cohort inputs do not describe one launch");
    }

    for (const role of ROLES) records.push(childRecord(role, fail));
    uniqueChannels(records);
    const byRole = Object.fromEntries(records.map((record) => [record.role, record]));
    const writes = await Promise.allSettled([
      writeAndEnd(byRole.consensus.pipes.bootstrap,
        encodeValidatorReadinessSignerChildFrame(consensusInput), "consensus bootstrap write"),
      writeAndEnd(byRole.transport.pipes.bootstrap,
        encodeValidatorReadinessSignerChildFrame(transportInput), "transport bootstrap write"),
      writeAndEnd(byRole.consensus.pipes.password, consensusPasswordCopy,
        "consensus password write"),
      writeAndEnd(byRole.transport.pipes.password, transportPasswordCopy,
        "transport password write"),
    ]);
    if (writes.some((result) => result.status === "rejected")) {
      throw new Error("validator readiness signer cohort input delivery failed");
    }
    consensusPasswordCopy.fill(0); transportPasswordCopy.fill(0);

    const [consensusMessage, transportMessage] = await Promise.all([
      byRole.consensus.inbox.next("consensus signer READY"),
      byRole.transport.inbox.next("transport signer READY"),
    ]);
    if (closing) throw new Error("validator readiness signer cohort failed during startup");
    const readiness = {
      consensus: verifyValidatorReadinessSignerReady(consensusMessage,
        readyPins(consensusInput, "consensus", byRole.consensus.child.pid)),
      transport: verifyValidatorReadinessSignerReady(transportMessage,
        readyPins(transportInput, "transport", byRole.transport.child.pid)),
    };
    if (closing || records.some((record) => record.child.exitCode !== null ||
        record.child.signalCode !== null)) {
      throw new Error("validator readiness signer cohort failed while verifying READY");
    }
    state = "signers-ready-awaiting-gateway";
    const publicReadiness = deepFreeze(clone(readiness));
    const pids = Object.freeze({ consensus: byRole.consensus.child.pid,
      transport: byRole.transport.child.pid });
    return Object.freeze({
      close: () => teardown("closed"), pids, productionActivated: false,
      readiness: publicReadiness, state: () => state,
      waitForTermination: () => terminal,
    });
  } catch {
    await teardown("failed");
    throw new Error("validator readiness signer cohort launch failed");
  } finally {
    consensusPasswordCopy?.fill(0); transportPasswordCopy?.fill(0);
    for (const value of passwords) value.fill(0);
  }
}

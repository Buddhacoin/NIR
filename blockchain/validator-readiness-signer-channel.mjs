import {
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN,
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN,
} from "./validator-admission-readiness-auth.mjs";
import {
  createValidatorReadinessConsensusSignRequest,
  createValidatorReadinessConsensusSignResponse,
  createValidatorReadinessSignerChannelEpoch,
  createValidatorReadinessSignerFrameDecoder,
  createValidatorReadinessTransportSignRequest,
  createValidatorReadinessTransportSignResponse,
  encodeValidatorReadinessSignerFrame,
  VALIDATOR_READINESS_SIGNER_MAX_TIMEOUT_MS,
  verifyValidatorReadinessConsensusSignRequest,
  verifyValidatorReadinessConsensusSignResponse,
  verifyValidatorReadinessTransportSignRequest,
  verifyValidatorReadinessTransportSignResponse,
} from "./validator-readiness-signer-protocol.mjs";
import { verifyValidatorReadinessSignerReady }
  from "./validator-readiness-process-protocol.mjs";
import { verifyValidatorReadinessRolePackage }
  from "./validator-readiness-session.mjs";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_REQUESTS = 65_536;
const DEFAULT_MAX_OPERATIONS = 4_096;

function signal(value) {
  if (value !== null && (typeof value !== "object" || typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function")) {
    throw new Error("validator readiness signer abort signal is invalid");
  }
  return value;
}

function integer(value, fallback, minimum, maximum, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return result;
}

function monotonicClock(clock) {
  let previous = -1;
  return () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0 || value < previous) {
      throw new Error("validator readiness signer clock is invalid or moved backwards");
    }
    previous = value; return value;
  };
}

function assertStream(stream) {
  if (!stream || typeof stream.on !== "function" || typeof stream.write !== "function" ||
      typeof stream.destroy !== "function") {
    throw new Error("validator readiness signer channel is invalid");
  }
  return stream;
}

function writeFrame(stream, value) {
  const frame = encodeValidatorReadinessSignerFrame(value);
  return new Promise((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) {
      reject(new Error("validator readiness signer channel is unavailable")); return;
    }
    try { stream.write(frame, (error) => error ? reject(error) : resolve()); }
    catch (error) { reject(error); }
  });
}

function boundedWriteFrame(stream, value, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("validator readiness signer output timed out")),
      timeoutMs);
    timer.unref?.();
  });
  return Promise.race([writeFrame(stream, value), timeout]).finally(() => clearTimeout(timer));
}

function publicIdentity(session, role) {
  const value = role === "transport" ? session.context.transport : session.context.candidate;
  return { address: value.address, algorithm: value.algorithm, publicKey: value.publicKey };
}

function verifiedChannelBinding({ bootstrap, expectedLauncherNonce, expectedPid,
  expectedReleaseProvenanceHash, expectedSessionHash, signerReady } = {}, role, now) {
  const ready = verifyValidatorReadinessSignerReady(signerReady, { bootstrap,
    expectedLauncherNonce, expectedPid, expectedReleaseProvenanceHash, expectedRole: role,
    expectedSessionHash, now });
  const channelBinding = structuredClone({ bootstrap, expectedLauncherNonce, expectedPid,
    expectedReleaseProvenanceHash, expectedSessionHash, signerReady: ready });
  createValidatorReadinessSignerChannelEpoch(channelBinding, { expectedRole: role, now });
  return { channelBinding, ready };
}

function createClient({ bootstrap, expectedLauncherNonce, expectedPid,
  expectedReleaseProvenanceHash, expectedSessionHash, gatewayRolePackage,
  now = () => Date.now(), role, signerReady, stream, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  assertStream(stream);
  if (typeof now !== "function") throw new Error("validator readiness signer clock is invalid");
  const time = monotonicClock(now);
  const { channelBinding } = verifiedChannelBinding({ bootstrap, expectedLauncherNonce,
    expectedPid, expectedReleaseProvenanceHash, expectedSessionHash, signerReady }, role, time());
  timeoutMs = integer(timeoutMs, DEFAULT_TIMEOUT_MS, 1,
    VALIDATOR_READINESS_SIGNER_MAX_TIMEOUT_MS, "validator readiness signer timeout");
  const gateway = verifyValidatorReadinessRolePackage(gatewayRolePackage,
    { expectedRole: "gateway", now: time() });
  const decoder = createValidatorReadinessSignerFrameDecoder();
  let pending = null; let poisoned = false; let cleanEnd = false; let frameTimer = null;

  const cleanupPending = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
  };
  const poison = (error) => {
    if (poisoned) return;
    poisoned = true;
    clearTimeout(frameTimer); frameTimer = null;
    const failure = error instanceof Error ? error
      : new Error("validator readiness signer channel failed");
    if (pending) {
      const current = pending; cleanupPending(); pending = null; current.reject(failure);
    }
    if (!stream.destroyed) stream.destroy();
  };
  const onData = (chunk) => {
    if (chunk.length === 0) return;
    const wasPending = decoder.hasPendingFrame();
    let messages;
    try { messages = decoder.push(chunk); } catch (error) { poison(error); return; }
    const isPending = decoder.hasPendingFrame();
    if (wasPending && !isPending) { clearTimeout(frameTimer); frameTimer = null; }
    if (!wasPending && isPending) {
      frameTimer = setTimeout(() => poison(
        new Error("validator readiness signer input frame timed out")), timeoutMs);
      frameTimer.unref?.();
    }
    for (const message of messages) {
      if (!pending) { poison(new Error("validator readiness signer response was unsolicited")); return; }
      const current = pending;
      try {
        const response = role === "transport"
          ? verifyValidatorReadinessTransportSignResponse(message,
            { channelBinding, gatewayRolePackage: gateway, request: current.request, now: time() })
          : verifyValidatorReadinessConsensusSignResponse(message,
            { channelBinding, gatewayRolePackage: gateway, request: current.request, now: time() });
        cleanupPending(); pending = null; current.resolve(response);
      } catch (error) { poison(error); return; }
    }
  };
  const onEnd = () => {
    clearTimeout(frameTimer); frameTimer = null;
    try { decoder.finish(); } catch (error) { poison(error); return; }
    if (pending) poison(new Error("validator readiness signer channel ended with work pending"));
    else cleanEnd = true;
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  stream.on("error", poison);
  stream.on("close", () => {
    if (!cleanEnd && !poisoned) poison(new Error("validator readiness signer channel closed"));
  });

  const request = (value, requestSignal) => {
    signal(requestSignal);
    if (poisoned || cleanEnd || stream.destroyed) {
      return Promise.reject(new Error("validator readiness signer channel is unavailable"));
    }
    if (pending) return Promise.reject(new Error("validator readiness signer channel is busy"));
    if (requestSignal?.aborted) {
      return Promise.reject(requestSignal.reason instanceof Error ? requestSignal.reason
        : new Error("validator readiness signer request was aborted"));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => poison(requestSignal.reason instanceof Error ? requestSignal.reason
        : new Error("validator readiness signer request was aborted"));
      const timer = setTimeout(() => poison(new Error("validator readiness signer request timed out")),
        timeoutMs);
      timer.unref?.();
      pending = { onAbort, reject, request: value, resolve, signal: requestSignal, timer };
      requestSignal?.addEventListener("abort", onAbort, { once: true });
      boundedWriteFrame(stream, value, timeoutMs).catch(poison);
    });
  };
  return { channelBinding, gateway, identity: publicIdentity(gateway.session, role), request, time };
}

export function createValidatorReadinessTransportSignerAdapter(options = {}) {
  const client = createClient({ ...options, role: "transport" });
  return Object.freeze({ ...client.identity,
    async signReadinessTransport({ challenge, signal: requestSignal = null } = {}) {
      const request = createValidatorReadinessTransportSignRequest({ challenge,
        gatewayRolePackage: client.gateway },
      { channelBinding: client.channelBinding, now: client.time() });
      const response = await client.request(request, requestSignal);
      return response.transportResponse.transportSignature;
    },
  });
}

export function createValidatorReadinessConsensusSignerAdapter(options = {}) {
  const client = createClient({ ...options, role: "consensus" });
  return Object.freeze({ ...client.identity,
    async signReadinessConsensus({ signal: requestSignal = null, transportResponse } = {}) {
      const request = createValidatorReadinessConsensusSignRequest({
        gatewayRolePackage: client.gateway, transportResponse,
      }, { channelBinding: client.channelBinding, now: client.time() });
      const response = await client.request(request, requestSignal);
      return response.candidateResponse.consensusSignature;
    },
  });
}

function assertSigner(signer, identity, role) {
  const method = role === "transport" ? "signReadinessTransportInput"
    : "signReadinessConsensusInput";
  if (!signer || signer.address !== identity.address || signer.algorithm !== identity.algorithm ||
      signer.publicKey !== identity.publicKey || typeof signer[method] !== "function" ||
      typeof signer.sign !== "undefined") {
    throw new Error(`validator readiness ${role} endpoint signer is invalid`);
  }
  return method;
}

function createEndpoint({ bootstrap, expectedLauncherNonce, expectedPid,
  expectedReleaseProvenanceHash, expectedSessionHash, maxOperations = DEFAULT_MAX_OPERATIONS,
  maxRequests = DEFAULT_MAX_REQUESTS, now = () => Date.now(), role, signer, signerReady, stream,
  timeoutMs = DEFAULT_TIMEOUT_MS, trustedCurrentHeight }) {
  assertStream(stream);
  if (typeof now !== "function" || typeof trustedCurrentHeight !== "function") {
    throw new Error("validator readiness signer endpoint trust callbacks are invalid");
  }
  const time = monotonicClock(now);
  const { channelBinding } = verifiedChannelBinding({ bootstrap, expectedLauncherNonce,
    expectedPid, expectedReleaseProvenanceHash, expectedSessionHash, signerReady }, role, time());
  timeoutMs = integer(timeoutMs, DEFAULT_TIMEOUT_MS, 1,
    VALIDATOR_READINESS_SIGNER_MAX_TIMEOUT_MS, "validator readiness signer timeout");
  maxRequests = integer(maxRequests, DEFAULT_MAX_REQUESTS, 16, 1_000_000,
    "validator readiness signer request capacity");
  maxOperations = integer(maxOperations, DEFAULT_MAX_OPERATIONS, 16, maxRequests,
    "validator readiness signer operation capacity");
  const pinned = verifyValidatorReadinessRolePackage(bootstrap?.rolePackage,
    { expectedRole: role, now: time() });
  const identity = publicIdentity(pinned.session, role);
  const signerMethod = assertSigner(signer, identity, role);
  const decoder = createValidatorReadinessSignerFrameDecoder();
  const requestIds = new Map(); const operations = new Map();
  let activeController = null; let cleanEnd = false; let lastHeight = -1;
  let frameTimer = null; let pendingMessages = 0; let poisoned = false;
  let queue = Promise.resolve();
  const metrics = { completedOperations: 0, requests: 0, reusedOperations: 0 };

  const poison = (error) => {
    if (poisoned) return;
    poisoned = true;
    clearTimeout(frameTimer); frameTimer = null;
    activeController?.abort(error instanceof Error ? error
      : new Error("validator readiness signer endpoint failed"));
    if (!stream.destroyed) stream.destroy();
  };
  const height = () => {
    const current = trustedCurrentHeight();
    if (!Number.isSafeInteger(current) || current < pinned.session.context.checkpoint.height ||
        current >= pinned.session.expiresAtHeight || current < lastHeight) {
      throw new Error("validator readiness signer trusted height is invalid, stale, or expired");
    }
    lastHeight = current; return current;
  };
  const sign = async (verified) => {
    height();
    const existing = operations.get(verified.operationHash);
    if (existing) {
      if (existing.state !== "completed") {
        throw new Error("validator readiness signer operation is already pending");
      }
      metrics.reusedOperations += 1; return existing.core;
    }
    if (operations.size >= maxOperations) {
      throw new Error("validator readiness signer operation capacity is exhausted");
    }
    const reservation = { state: "pending" };
    operations.set(verified.operationHash, reservation);
    const controller = new AbortController(); activeController = controller;
    const timer = setTimeout(() => controller.abort(
      new Error("validator readiness signer key operation timed out")), timeoutMs);
    timer.unref?.();
    const cancelled = new Promise((_, reject) => controller.signal.addEventListener("abort",
      () => reject(controller.signal.reason instanceof Error ? controller.signal.reason
        : new Error("validator readiness signer key operation was aborted")), { once: true }));
    try {
      const operation = Promise.resolve().then(() => signer[signerMethod](
        verified.signingInput, { signal: controller.signal }));
      const signature = await Promise.race([operation, cancelled]);
      if (controller.signal.aborted) throw controller.signal.reason;
      height();
      const response = role === "transport"
        ? createValidatorReadinessTransportSignResponse({ request: verified.request,
          rolePackage: pinned, signature }, { channelBinding, now: time() })
        : createValidatorReadinessConsensusSignResponse({ request: verified.request,
          rolePackage: pinned, signature }, { channelBinding, now: time() });
      const core = role === "transport" ? response.transportResponse : response.candidateResponse;
      reservation.core = core; reservation.state = "completed";
      metrics.completedOperations += 1;
      return core;
    } finally {
      clearTimeout(timer); activeController = null;
      if (reservation.state !== "completed") poison(
        controller.signal.reason ?? new Error("validator readiness signer key operation failed"));
    }
  };
  const handle = async (message) => {
    const verified = role === "transport"
      ? verifyValidatorReadinessTransportSignRequest(message,
        { channelBinding, rolePackage: pinned, now: time() })
      : verifyValidatorReadinessConsensusSignRequest(message,
        { channelBinding, rolePackage: pinned, now: time() });
    const priorRequestHash = requestIds.get(verified.request.requestId);
    if (priorRequestHash !== undefined && priorRequestHash !== verified.requestHash) {
      throw new Error("validator readiness signer request id was reused for different input");
    }
    if (priorRequestHash === undefined && requestIds.size >= maxRequests) {
      throw new Error("validator readiness signer request capacity is exhausted");
    }
    if (priorRequestHash === undefined) {
      requestIds.set(verified.request.requestId, verified.requestHash);
    }
    metrics.requests += 1;
    const core = await sign(verified);
    const response = role === "transport"
      ? createValidatorReadinessTransportSignResponse({ request: verified.request,
        rolePackage: pinned, signature: core.transportSignature }, { channelBinding, now: time() })
      : createValidatorReadinessConsensusSignResponse({ request: verified.request,
        rolePackage: pinned, signature: core.consensusSignature }, { channelBinding, now: time() });
    await boundedWriteFrame(stream, response, timeoutMs);
  };
  const onData = (chunk) => {
    if (chunk.length === 0) return;
    const wasPending = decoder.hasPendingFrame();
    let messages;
    try { messages = decoder.push(chunk); } catch (error) { poison(error); return; }
    const isPending = decoder.hasPendingFrame();
    if (wasPending && !isPending) { clearTimeout(frameTimer); frameTimer = null; }
    if (!wasPending && isPending) {
      frameTimer = setTimeout(() => poison(
        new Error("validator readiness signer input frame timed out")), timeoutMs);
      frameTimer.unref?.();
    }
    if (pendingMessages + messages.length > maxRequests) {
      poison(new Error("validator readiness signer input queue capacity is exhausted")); return;
    }
    pendingMessages += messages.length;
    for (const message of messages) queue = queue.then(() => {
      if (poisoned) throw new Error("validator readiness signer endpoint is poisoned");
      return handle(message);
    }).finally(() => {
      pendingMessages -= 1;
    }).catch(poison);
  };
  const onEnd = () => {
    clearTimeout(frameTimer); frameTimer = null;
    try { decoder.finish(); } catch (error) { poison(error); return; }
    if (pendingMessages !== 0 || activeController !== null) {
      poison(new Error("validator readiness signer endpoint ended with work pending"));
    } else cleanEnd = true;
  };
  stream.on("data", onData); stream.on("end", onEnd); stream.on("error", poison);
  stream.on("close", () => {
    if (!cleanEnd && !poisoned) poison(new Error("validator readiness signer endpoint closed"));
  });
  return Object.freeze({
    close() {
      cleanEnd = pendingMessages === 0 && activeController === null;
      if (!stream.destroyed && !stream.writableEnded) stream.end();
      if (!cleanEnd) poison(new Error("validator readiness signer endpoint closed while active"));
    },
    metrics() { return { ...metrics, operations: operations.size, poisoned,
      requestIds: requestIds.size }; },
  });
}

export function createValidatorReadinessTransportSignerEndpoint(options = {}) {
  return createEndpoint({ ...options, role: "transport" });
}

export function createValidatorReadinessConsensusSignerEndpoint(options = {}) {
  return createEndpoint({ ...options, role: "consensus" });
}

export const VALIDATOR_READINESS_TRANSPORT_SIGNING_DOMAIN =
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN;
export const VALIDATOR_READINESS_CONSENSUS_SIGNING_DOMAIN =
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN;

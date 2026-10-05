import { createHash, X509Certificate } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";

import { canonicalJson } from "./crypto.mjs";
import {
  hardenHttpServer, HTTP_MAX_HEADER_BYTES, HttpIngressError, HttpIngressGuard,
  ingressErrorResponse, rejectUnexpectedRequestBody,
} from "./http-ingress.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";
import {
  verifyValidatorAdmissionReadinessChallenge,
  verifyValidatorAdmissionReadinessContext,
} from "./validator-admission-readiness-auth.mjs";
import { respondToValidatorAdmissionReadinessChallenge }
  from "./validator-admission-readiness-responder.mjs";

export const VALIDATOR_ADMISSION_READINESS_CHALLENGE_PATH =
  "/v1/validator-admission/readiness/challenge";
export const VALIDATOR_ADMISSION_READINESS_MAX_BODY_BYTES = 512 * 1024;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function json(response, status, value) {
  const body = canonicalJson(value);
  response.writeHead(status, { "cache-control": "no-store", "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8" });
  response.end(body);
}

function discard(request) {
  request.on("data", () => {});
  request.resume();
}

function readCanonicalRequest(request, bodyIdleTimeoutMs) {
  if (request.headers["transfer-encoding"] !== undefined) {
    discard(request);
    return Promise.reject(new HttpIngressError("framing",
      "chunked request bodies are not accepted", 400));
  }
  const declared = request.headers["content-length"];
  if (typeof declared !== "string" || !/^[1-9][0-9]*$/.test(declared)) {
    discard(request);
    return Promise.reject(new HttpIngressError("framing",
      "request content length is required", 411));
  }
  const expected = Number(declared);
  if (!Number.isSafeInteger(expected) || expected > VALIDATOR_ADMISSION_READINESS_MAX_BODY_BYTES) {
    discard(request);
    return Promise.reject(new HttpIngressError("bodyTooLarge", "request body is too large", 413));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let timer;
    const clear = () => {
      clearTimeout(timer);
      request.off("data", onData); request.off("end", onEnd);
      request.off("error", onError); request.off("aborted", onAborted);
    };
    const fail = (error, drain = true) => {
      if (settled) return;
      settled = true; clear();
      if (drain) discard(request);
      reject(error);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new HttpIngressError("bodyTimeout",
        "request body timed out", 408)), bodyIdleTimeoutMs);
      timer.unref?.();
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > expected || bytes > VALIDATOR_ADMISSION_READINESS_MAX_BODY_BYTES) {
        fail(new HttpIngressError("bodyTooLarge", "request body is too large", 413));
      } else { chunks.push(chunk); arm(); }
    };
    const onEnd = () => {
      if (bytes !== expected) {
        fail(new HttpIngressError("framing", "request content length is mismatched", 400), false);
        return;
      }
      try {
        const encoded = Buffer.concat(chunks, bytes).toString("utf8");
        const parsed = parseConsensusJson(encoded);
        if (encoded !== canonicalJson(parsed)) {
          throw new HttpIngressError("json", "request body is not canonical JSON", 400);
        }
        settled = true; clear(); resolve(parsed);
      } catch (error) {
        fail(error instanceof HttpIngressError ? error : new HttpIngressError("json",
          "request body is not valid canonical JSON", 400), false);
      }
    };
    const onError = () => fail(new HttpIngressError("transport",
      "request transport failed", 400), false);
    const onAborted = () => fail(new HttpIngressError("transport",
      "request transport was aborted", 400), false);
    request.on("data", onData); request.on("end", onEnd);
    request.on("error", onError); request.on("aborted", onAborted); arm();
  });
}

function positiveInteger(value, fallback, maximum, label) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return resolved;
}

export function createValidatorAdmissionReadinessServer({
  consensusSigner,
  transportSigner,
  validators,
} = {}, options = {}) {
  if (options.active !== undefined && typeof options.active !== "boolean") {
    throw new Error("validator admission readiness activation state is invalid");
  }
  let activated = options.active ?? true;
  let closed = false;
  const tls = options.tls;
  if (!tls || (typeof tls.key !== "string" && !Buffer.isBuffer(tls.key)) ||
      (typeof tls.cert !== "string" && !Buffer.isBuffer(tls.cert))) {
    throw new Error("validator admission readiness TLS key and certificate are required");
  }
  let tlsCertificateSha256;
  try {
    tlsCertificateSha256 = createHash("sha256").update(new X509Certificate(tls.cert).raw)
      .digest("hex");
  } catch {
    throw new Error("validator admission readiness TLS certificate is invalid");
  }
  if (!Array.isArray(validators)) {
    throw new Error("validator admission readiness validators are required");
  }
  const observerValidators = structuredClone(validators);
  const maxCompletedChallenges = positiveInteger(options.maxCompletedChallenges, 65_536,
    1_000_000, "validator admission readiness replay capacity");
  const responseTimeoutMs = positiveInteger(options.responseTimeoutMs, 5_000, 60_000,
    "validator admission readiness response timeout");
  const bodyIdleTimeoutMs = positiveInteger(options.bodyIdleTimeoutMs, 5_000, 60_000,
    "validator admission readiness body idle timeout");
  if (bodyIdleTimeoutMs < 10) {
    throw new Error("validator admission readiness body idle timeout is invalid");
  }
  const httpIngressOptions = { bodyIdleTimeoutMs,
    burst: options.burst ?? 32, maxActive: options.maxActive ?? 32,
    maxActivePerAddress: options.maxActivePerAddress ?? 8,
    maxConnections: options.maxConnections ?? 32,
    requestsPerMinute: options.requestsPerMinute ?? 120,
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000 };
  const ingress = new HttpIngressGuard(httpIngressOptions);
  const active = new Set();
  const activeControllers = new Set();
  const completed = new Set();
  const totals = { accepted: 0, rejected: 0, replayRejected: 0 };

  const handler = async (request, response) => {
    let finishIngress;
    try {
      if (!activated || closed) {
        totals.rejected += 1;
        response.shouldKeepAlive = false;
        response.setHeader("connection", "close");
        const socket = request.socket;
        response.once("finish", () => socket?.destroy());
        json(response, 503, { error: "validator admission readiness service is not active" });
        return;
      }
      finishIngress = ingress.begin(request);
      if (request.url !== VALIDATOR_ADMISSION_READINESS_CHALLENGE_PATH) {
        discard(request);
        json(response, 404, { error: "not found" });
        return;
      }
      if (request.method !== "POST") {
        rejectUnexpectedRequestBody(request);
        json(response, 405, { error: "method not allowed" });
        return;
      }
      if (request.headers["content-type"] !== "application/json") {
        discard(request);
        throw new HttpIngressError("contentType", "application/json is required", 415);
      }
      const body = await readCanonicalRequest(request, httpIngressOptions.bodyIdleTimeoutMs);
      exact(body, ["challenge", "context"], "validator admission readiness request");
      const context = verifyValidatorAdmissionReadinessContext(body.context);
      if (context.tlsCertificateSha256 !== tlsCertificateSha256) {
        throw new Error("validator admission readiness TLS certificate pin is mismatched");
      }
      const challenge = verifyValidatorAdmissionReadinessChallenge(body.challenge,
        { context, validators: observerValidators });
      const key = `${context.contextHash}\0${challenge.observer}`;
      if (completed.has(challenge.challengeHash)) {
        totals.replayRejected += 1;
        throw new Error("validator admission readiness challenge replay is rejected");
      }
      if (active.has(key)) {
        throw new Error("validator admission readiness context and observer are already active");
      }
      if (completed.size >= maxCompletedChallenges) {
        throw new HttpIngressError("capacity",
          "validator admission readiness replay capacity is exhausted", 503);
      }
      if (!activated || closed) {
        throw new HttpIngressError("inactive",
          "validator admission readiness service is not active", 503);
      }
      active.add(key);
      const controller = new AbortController();
      activeControllers.add(controller);
      const timeout = setTimeout(() => controller.abort(new HttpIngressError("responseTimeout",
        "validator admission readiness response timed out", 408)), responseTimeoutMs);
      timeout.unref?.();
      const abort = () => {
        if (!response.writableEnded) controller.abort(new HttpIngressError("transport",
          "validator admission readiness request was aborted", 400));
      };
      const socket = request.socket;
      request.once("aborted", abort);
      response.once("close", abort);
      socket?.once("close", abort);
      try {
        const candidateResponse = await respondToValidatorAdmissionReadinessChallenge({ challenge,
          consensusSigner, context, signal: controller.signal, transportSigner,
          validators: observerValidators });
        if (!activated || closed || controller.signal.aborted) {
          throw new HttpIngressError("shutdown",
            "validator admission readiness service is not active", 503);
        }
        completed.add(challenge.challengeHash);
        totals.accepted += 1;
        json(response, 200, candidateResponse);
      } finally {
        clearTimeout(timeout);
        request.off("aborted", abort);
        response.off("close", abort);
        socket?.off("close", abort);
        active.delete(key);
        activeControllers.delete(controller);
      }
    } catch (error) {
      totals.rejected += 1;
      ingress.record(error);
      if (closed && !response.destroyed && !response.writableEnded) response.destroy();
      else if (!response.destroyed && !response.writableEnded && !response.headersSent) {
        const rejected = ingressErrorResponse(error);
        json(response, rejected.status, { error: rejected.message });
      } else if (!response.destroyed && !response.writableEnded) response.destroy();
    } finally {
      finishIngress?.();
    }
  };
  const server = createHttpsServer({ cert: tls.cert, key: tls.key,
    maxHeaderSize: HTTP_MAX_HEADER_BYTES, maxVersion: "TLSv1.3", minVersion: "TLSv1.3" }, handler);
  const beginShutdown = () => {
    if (closed) return;
    activated = false; closed = true;
    for (const controller of activeControllers) controller.abort(new HttpIngressError("shutdown",
      "validator admission readiness service is shutting down", 503));
  };
  const nativeClose = server.close.bind(server);
  server.close = (callback) => { beginShutdown(); return nativeClose(callback); };
  server.once("close", beginShutdown);
  server.validatorAdmissionReadinessActivate = () => {
    if (closed) throw new Error("validator admission readiness server is closed");
    if (activated) throw new Error("validator admission readiness server is already active");
    activated = true;
    return true;
  };
  server.validatorAdmissionReadinessMetrics = () => ({ active: active.size,
    activated, closed, completedChallenges: completed.size,
    httpIngress: ingress.metrics(), ...totals });
  return hardenHttpServer(server, httpIngressOptions);
}

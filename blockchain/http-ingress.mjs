import { parseConsensusJson } from "./consensus-json.mjs";

const DEFAULTS = Object.freeze({
  bodyIdleTimeoutMs: 5_000,
  burst: 256,
  maxActive: 128,
  maxActivePerAddress: 16,
  maxAddresses: 4_096,
  maxBodyBytes: 2 * 1024 * 1024,
  maxConnections: 128,
  maxHeaderBytes: 16 * 1024,
  maxHeadersCount: 64,
  maxJsonNodes: 100_000,
  maxUrlBytes: 2_048,
  requestsPerMinute: 600,
});

export class HttpIngressError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return resolved;
}

function addressOf(request) {
  const value = request?.socket?.remoteAddress;
  if (typeof value !== "string" || value.length < 1 || value.length > 128) return "unknown";
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function discard(request) {
  request.on("data", () => {});
  request.resume();
}

function validateContentLength(request, maximumBytes) {
  const encoding = request.headers["content-encoding"];
  if (encoding !== undefined && String(encoding).trim().toLowerCase() !== "identity") {
    throw new HttpIngressError("encoding", "compressed request bodies are not accepted", 415);
  }
  if (request.headers["content-length"] !== undefined && request.headers["transfer-encoding"] !== undefined) {
    throw new HttpIngressError("framing", "ambiguous request framing is not accepted", 400);
  }
  const declared = request.headers["content-length"];
  if (declared === undefined) return;
  if (typeof declared !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(declared)) {
    throw new HttpIngressError("framing", "request content length is invalid", 400);
  }
  const bytes = Number(declared);
  if (!Number.isSafeInteger(bytes) || bytes > maximumBytes) {
    throw new HttpIngressError("bodyTooLarge", "request body is too large", 413);
  }
}

export function rejectUnexpectedRequestBody(request) {
  try {
    validateContentLength(request, 0);
    if (request.headers["transfer-encoding"] !== undefined ||
        request.headers["content-length"] !== undefined &&
        request.headers["content-length"] !== "0") {
      throw new HttpIngressError("bodyTooLarge", "request body is not accepted", 413);
    }
  } catch (error) {
    discard(request);
    throw error;
  }
}

function countJsonNodes(value, maximum) {
  const pending = [value];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    count += 1;
    if (count > maximum) {
      throw new HttpIngressError("jsonShape", "request JSON shape is too large", 400);
    }
    if (Array.isArray(current)) {
      if (current.length > maximum - count - pending.length) {
        throw new HttpIngressError("jsonShape", "request JSON shape is too large", 400);
      }
      for (let index = 0; index < current.length; index += 1) pending.push(current[index]);
    } else if (current !== null && typeof current === "object") {
      const values = Object.values(current);
      if (values.length > maximum - count - pending.length) {
        throw new HttpIngressError("jsonShape", "request JSON shape is too large", 400);
      }
      for (const entry of values) pending.push(entry);
    }
  }
}

export function readBoundedConsensusJson(request, options = {}) {
  const maximumBytes = boundedInteger(
    options.maxBodyBytes, DEFAULTS.maxBodyBytes, 1, 64 * 1024 * 1024, "HTTP body limit",
  );
  const idleTimeoutMs = boundedInteger(
    options.bodyIdleTimeoutMs, DEFAULTS.bodyIdleTimeoutMs, 10, 60_000, "HTTP body idle timeout",
  );
  const maximumNodes = boundedInteger(
    options.maxJsonNodes, DEFAULTS.maxJsonNodes, 1, 1_000_000, "HTTP JSON node limit",
  );
  try { validateContentLength(request, maximumBytes); }
  catch (error) { discard(request); return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let timer = null;
    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error, drain = true) => {
      if (settled) return;
      settled = true;
      clear();
      if (drain) discard(request);
      reject(error);
    };
    const arm = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => fail(new HttpIngressError(
        "bodyTimeout", "request body timed out", 408,
      )), idleTimeoutMs);
      timer.unref?.();
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        fail(new HttpIngressError("bodyTooLarge", "request body is too large", 413));
        return;
      }
      chunks.push(chunk);
      arm();
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      clear();
      try {
        const parsed = parseConsensusJson(Buffer.concat(chunks, bytes).toString("utf8"));
        countJsonNodes(parsed, maximumNodes);
        resolve(parsed);
      } catch (error) {
        reject(error instanceof HttpIngressError ? error : new HttpIngressError(
          "json", "request body is not valid consensus JSON", 400,
        ));
      }
    };
    const onError = () => fail(new HttpIngressError("transport", "request transport failed", 400), false);
    const onAborted = () => fail(new HttpIngressError("transport", "request transport was aborted", 400), false);
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
    arm();
  });
}

export class HttpIngressGuard {
  #active = 0;
  #activeByAddress = new Map();
  #addresses = new Map();
  #clock;
  #lastClock = 0;
  #options;
  #totals = {
    accepted: 0, bodyTimeout: 0, bodyTooLarge: 0, concurrencyRejected: 0,
    encodingRejected: 0, malformed: 0, rateRejected: 0, urlRejected: 0,
  };

  constructor(options = {}) {
    this.#clock = options.clock ?? (() => Date.now());
    if (typeof this.#clock !== "function") throw new Error("HTTP ingress clock is invalid");
    this.#options = {
      burst: boundedInteger(options.burst, DEFAULTS.burst, 1, 100_000, "HTTP ingress burst"),
      maxActive: boundedInteger(options.maxActive, DEFAULTS.maxActive, 1, 100_000, "HTTP active limit"),
      maxActivePerAddress: boundedInteger(options.maxActivePerAddress,
        DEFAULTS.maxActivePerAddress, 1, 10_000, "HTTP per-address active limit"),
      maxAddresses: boundedInteger(options.maxAddresses, DEFAULTS.maxAddresses,
        1, 1_000_000, "HTTP address limit"),
      maxUrlBytes: boundedInteger(options.maxUrlBytes, DEFAULTS.maxUrlBytes,
        64, 64 * 1024, "HTTP URL limit"),
      requestsPerMinute: boundedInteger(options.requestsPerMinute,
        DEFAULTS.requestsPerMinute, 1, 1_000_000, "HTTP request rate"),
    };
    if (this.#options.maxActivePerAddress > this.#options.maxActive) {
      throw new Error("HTTP per-address active limit exceeds the global limit");
    }
  }

  begin(request) {
    if (typeof request.url !== "string" || Buffer.byteLength(request.url) > this.#options.maxUrlBytes) {
      this.#totals.urlRejected += 1;
      throw new HttpIngressError("url", "request URL is too long", 414);
    }
    const address = addressOf(request);
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0 || now < this.#lastClock) {
      throw new HttpIngressError("clock", "ingress admission is unavailable", 503);
    }
    this.#lastClock = now;
    const old = this.#addresses.get(address);
    const elapsed = old ? Math.max(0, now - old.updatedAt) : 0;
    const tokens = old
      ? Math.min(this.#options.burst,
        old.tokens + elapsed * this.#options.requestsPerMinute / 60_000)
      : this.#options.burst;
    if (tokens < 1) {
      this.#totals.rateRejected += 1;
      throw new HttpIngressError("rate", "request rate limit exceeded", 429);
    }
    this.#addresses.delete(address);
    this.#addresses.set(address, { tokens: tokens - 1, updatedAt: now });
    while (this.#addresses.size > this.#options.maxAddresses) {
      this.#addresses.delete(this.#addresses.keys().next().value);
    }
    const addressActive = this.#activeByAddress.get(address) ?? 0;
    if (this.#active >= this.#options.maxActive ||
        addressActive >= this.#options.maxActivePerAddress) {
      this.#totals.concurrencyRejected += 1;
      throw new HttpIngressError("concurrency", "request concurrency limit exceeded", 503);
    }
    this.#active += 1;
    this.#activeByAddress.set(address, addressActive + 1);
    this.#totals.accepted += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#active -= 1;
      const remaining = (this.#activeByAddress.get(address) ?? 1) - 1;
      if (remaining === 0) this.#activeByAddress.delete(address);
      else this.#activeByAddress.set(address, remaining);
    };
  }

  record(error) {
    if (!(error instanceof HttpIngressError)) { this.#totals.malformed += 1; return; }
    if (error.code === "bodyTimeout") this.#totals.bodyTimeout += 1;
    else if (error.code === "bodyTooLarge") this.#totals.bodyTooLarge += 1;
    else if (error.code === "encoding") this.#totals.encodingRejected += 1;
    else if (!["rate", "concurrency", "url"].includes(error.code)) this.#totals.malformed += 1;
  }

  metrics() {
    return {
      ...this.#totals,
      active: this.#active,
      activeAddresses: this.#activeByAddress.size,
      trackedAddresses: this.#addresses.size,
    };
  }
}

export function hardenHttpServer(server, options = {}) {
  const maxConnections = boundedInteger(options.maxConnections, DEFAULTS.maxConnections,
    1, 100_000, "HTTP connection limit");
  server.maxConnections = maxConnections;
  server.maxHeadersCount = boundedInteger(options.maxHeadersCount, DEFAULTS.maxHeadersCount,
    1, 1_024, "HTTP header count limit");
  server.headersTimeout = boundedInteger(options.headersTimeoutMs, 5_000,
    100, 120_000, "HTTP headers timeout");
  server.requestTimeout = boundedInteger(options.requestTimeoutMs, 10_000,
    100, 300_000, "HTTP request timeout");
  server.keepAliveTimeout = boundedInteger(options.keepAliveTimeoutMs, 2_000,
    100, 120_000, "HTTP keep-alive timeout");
  server.maxRequestsPerSocket = boundedInteger(options.maxRequestsPerSocket, 100,
    1, 100_000, "HTTP requests-per-socket limit");
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.gracefulShutdown = (timeoutMs = 5_000) => {
    boundedInteger(timeoutMs, 5_000, 10, 60_000, "HTTP shutdown timeout");
    return new Promise((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      let completed = false;
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, timeoutMs);
      timer.unref?.();
      server.close((error) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      });
      server.closeIdleConnections?.();
    });
  };
  return server;
}

export function ingressErrorResponse(error) {
  if (error instanceof HttpIngressError) return { status: error.status, message: error.message };
  const message = typeof error?.message === "string" ? error.message : "request rejected";
  const approvedClientFailure = /(?:authentication|signature|certificate|height|quorum|equivocat|rate limit|invalid|malformed|mismatch|duplicate|replay|unknown transaction|not found|not allowed|unavailable|conflict|stale|required|exceeds|too many|extend|deterministic|refus|proposer|binding|nonce)/i;
  if (message.length <= 200 && !/[\r\n]/.test(message) && approvedClientFailure.test(message) &&
      !/(?:\bENOENT\b|\bEACCES\b|node:internal|\/Users\/|\\Users\\|secret|password|token|vault|credential|private|database|\bdsn\b|stack trace)/i.test(message)) {
    return { status: 400, message };
  }
  return { status: 400, message: "request rejected" };
}

export const HTTP_MAX_HEADER_BYTES = DEFAULTS.maxHeaderBytes;

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { signWalletTransfer, walletPublicInfo } from "./wallet-files.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const REQUEST_ID = /^[0-9a-f]{64}$/;

function send(response, status, value, origin) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "access-control-allow-origin": origin,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "vary": "Origin",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) reject(new Error("bridge request is too large"));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("bridge request is not valid JSON")); }
    });
    request.on("error", reject);
  });
}

function validIntent(value) {
  if (!value || !REQUEST_ID.test(value.requestId ?? "") ||
      typeof value.networkId !== "string" || value.networkId.length < 3 ||
      value.networkId.length > 128 || !ADDRESS.test(value.recipient ?? "") ||
      typeof value.amount !== "string" || !/^[1-9][0-9]{0,30}$/.test(value.amount) ||
      !Number.isSafeInteger(value.nonce) || value.nonce < 0 ||
      (value.fee !== undefined &&
        (typeof value.fee !== "string" || !/^[1-9][0-9]{0,30}$/.test(value.fee)))) {
    throw new Error("bridge signing intent is invalid");
  }
  return {
    amount: value.amount,
    ...(value.fee === undefined ? {} : { fee: value.fee }),
    networkId: value.networkId,
    nonce: value.nonce,
    recipient: value.recipient,
    requestId: value.requestId,
  };
}

function authorized(request, sessionToken) {
  const supplied = request.headers["x-nir-bridge-token"];
  if (typeof supplied !== "string") return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(sessionToken);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createWalletBridgeServer({
  authorize,
  origin,
  sessionToken,
  vaultPath,
} = {}) {
  if (typeof authorize !== "function" || typeof vaultPath !== "string" ||
      !/^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?|chrome-extension:\/\/[a-p]{32})$/.test(origin ?? "") ||
      !/^[0-9a-f]{64}$/.test(sessionToken ?? "")) {
    throw new Error("wallet bridge configuration is invalid");
  }
  const seen = new Set();
  let pending = false;
  const server = createServer(async (request, response) => {
    const requestOrigin = request.headers.origin;
    const host = request.headers.host ?? "";
    const remoteAddress = request.socket.remoteAddress ?? "";
    if (requestOrigin !== origin || !/^(?:localhost|127\.0\.0\.1):[0-9]{1,5}$/.test(host) ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress)) {
      return send(response, 403, { error: "bridge origin or host is not allowed" }, origin);
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-headers": "content-type, x-nir-bridge-token",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-origin": origin,
        "access-control-max-age": "300",
        "vary": "Origin",
      });
      response.end(); return;
    }
    if (!authorized(request, sessionToken)) {
      return send(response, 401, { error: "bridge session is not authorized" }, origin);
    }
    try {
      const url = new URL(request.url, "http://bridge.local");
      if (request.method === "GET" && url.pathname === "/v1/wallet") {
        return send(response, 200, walletPublicInfo(vaultPath), origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/sign") {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("bridge signing requests require application/json");
        }
        const intent = validIntent(await readBody(request));
        if (pending) throw new Error("another signing request is awaiting confirmation");
        if (seen.has(intent.requestId)) throw new Error("signing request was already used");
        seen.add(intent.requestId);
        if (seen.size > 1_000) seen.delete(seen.values().next().value);
        pending = true;
        try {
          const password = await authorize(structuredClone(intent));
          if (typeof password !== "string") throw new Error("signing was rejected by the user");
          const { requestId, ...transfer } = intent;
          const transaction = signWalletTransfer({ path: vaultPath, password, ...transfer });
          return send(response, 200, { requestId, transaction }, origin);
        } finally {
          pending = false;
        }
      }
      return send(response, 404, { error: "not found" }, origin);
    } catch (error) {
      return send(response, 400, { error: error.message }, origin);
    }
  });
  server.maxConnections = 8;
  server.maxHeadersCount = 32;
  server.headersTimeout = 5_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 2_000;
  return server;
}

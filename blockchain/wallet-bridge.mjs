import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import {
  signWalletPaymentRequest,
  signWalletResourceOperation,
  signWalletTransfer,
  walletPublicInfo,
} from "./wallet-files.mjs";
import { verifyPaymentRequest } from "./payment-request.mjs";

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

function validResourceIntent(value) {
  if (!value || !REQUEST_ID.test(value.requestId ?? "") ||
      typeof value.networkId !== "string" || value.networkId.length < 3 ||
      value.networkId.length > 128 || !Number.isSafeInteger(value.nonce) || value.nonce < 0 ||
      !["credit-stake", "credit-delegation", "credit-unstake-request", "credit-unstake-claim"]
        .includes(value.type)) {
    throw new Error("bridge resource intent is invalid");
  }
  const operation = {
    networkId: value.networkId,
    nonce: value.nonce,
    requestId: value.requestId,
    type: value.type,
  };
  if (["credit-stake", "credit-unstake-request"].includes(value.type)) {
    if (typeof value.amount !== "string" || !/^[1-9][0-9]{0,30}$/.test(value.amount)) {
      throw new Error("bridge resource amount is invalid");
    }
    operation.amount = value.amount;
  }
  if (["credit-stake", "credit-delegation"].includes(value.type)) {
    if (typeof value.fee !== "string" || !/^[1-9][0-9]{0,30}$/.test(value.fee)) {
      throw new Error("bridge resource fee is invalid");
    }
    operation.fee = value.fee;
  }
  if (value.type === "credit-delegation") {
    if (!ADDRESS.test(value.delegate ?? "") || !Number.isSafeInteger(value.limit) ||
        value.limit < 0 || value.limit > 1_000_000) {
      throw new Error("bridge resource delegation is invalid");
    }
    operation.delegate = value.delegate;
    operation.limit = value.limit;
  }
  return operation;
}

function validPaymentRequestIntent(value) {
  const now = Date.now();
  if (!value || !REQUEST_ID.test(value.requestId ?? "") ||
      typeof value.networkId !== "string" || value.networkId.length < 3 ||
      value.networkId.length > 128 || typeof value.amount !== "string" ||
      !/^[1-9][0-9]{0,30}$/.test(value.amount) || typeof value.memo !== "string" ||
      Buffer.byteLength(value.memo, "utf8") > 160 || /[\u0000-\u001f\u007f]/u.test(value.memo) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now ||
      value.expiresAt > now + 30 * 24 * 60 * 60 * 1_000) {
    throw new Error("bridge payment request intent is invalid");
  }
  return {
    amount: value.amount,
    expiresAt: value.expiresAt,
    memo: value.memo,
    networkId: value.networkId,
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

function sameSecret(leftValue, rightValue) {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createWalletBridgeServer({
  authorize,
  origin,
  pairingCode,
  pairingLifetimeMs = 120_000,
  sessionToken,
  vaultPath,
} = {}) {
  if (typeof authorize !== "function" || typeof vaultPath !== "string" ||
      !/^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?|chrome-extension:\/\/[a-p]{32})$/.test(origin ?? "") ||
      !/^[0-9a-f]{64}$/.test(sessionToken ?? "") ||
      (pairingCode !== undefined && !/^[0-9]{8}$/.test(pairingCode)) ||
      !Number.isSafeInteger(pairingLifetimeMs) || pairingLifetimeMs < 1 || pairingLifetimeMs > 300_000) {
    throw new Error("wallet bridge configuration is invalid");
  }
  const seen = new Set();
  let pending = false;
  let pairingAttempts = 0;
  let pairingAvailable = pairingCode !== undefined;
  const pairingDeadline = Date.now() + pairingLifetimeMs;
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
    const url = new URL(request.url, "http://bridge.local");
    if (request.method === "POST" && url.pathname === "/v1/pair") {
      try {
        if (!pairingAvailable || Date.now() > pairingDeadline || pairingAttempts >= 5) {
          pairingAvailable = false;
          throw new Error("pairing is unavailable; restart the bridge");
        }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("pairing requests require application/json");
        }
        pairingAttempts += 1;
        const body = await readBody(request);
        if (typeof body.code !== "string" || !sameSecret(body.code, pairingCode)) {
          throw new Error("pairing code is invalid");
        }
        pairingAvailable = false;
        return send(response, 200, { sessionToken }, origin);
      } catch (error) {
        return send(response, 400, { error: error.message }, origin);
      }
    }
    if (!authorized(request, sessionToken)) {
      return send(response, 401, { error: "bridge session is not authorized" }, origin);
    }
    try {
      if (request.method === "GET" && url.pathname === "/v1/wallet") {
        return send(response, 200, walletPublicInfo(vaultPath), origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/verify-payment-request") {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("payment request verification requires application/json");
        }
        const body = await readBody(request);
        if (typeof body?.networkId !== "string" || body.networkId.length > 128) {
          throw new Error("payment request network is invalid");
        }
        return send(response, 200, {
          request: verifyPaymentRequest(body.request, { networkId: body.networkId }), verified: true,
        }, origin);
      }
      if (request.method === "POST" &&
          ["/v1/sign", "/v1/sign-resource", "/v1/sign-payment-request"].includes(url.pathname)) {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("bridge signing requests require application/json");
        }
        const body = await readBody(request);
        const intent = url.pathname === "/v1/sign-resource" ? validResourceIntent(body)
          : url.pathname === "/v1/sign-payment-request" ? validPaymentRequestIntent(body)
            : validIntent(body);
        if (pending) throw new Error("another signing request is awaiting confirmation");
        if (seen.has(intent.requestId)) throw new Error("signing request was already used");
        seen.add(intent.requestId);
        if (seen.size > 1_000) seen.delete(seen.values().next().value);
        pending = true;
        try {
          const password = await authorize(structuredClone(intent));
          if (typeof password !== "string") throw new Error("signing was rejected by the user");
          const { requestId, ...payload } = intent;
          const transaction = url.pathname === "/v1/sign-resource"
            ? signWalletResourceOperation({ path: vaultPath, password, operation: payload })
            : url.pathname === "/v1/sign-payment-request"
              ? signWalletPaymentRequest({
                path: vaultPath, password, intent: { ...payload, requestId },
              })
              : signWalletTransfer({ path: vaultPath, password, ...payload });
          return send(response, 200, {
            requestId,
            ...(url.pathname === "/v1/sign-payment-request"
              ? { paymentRequest: transaction } : { transaction }),
          }, origin);
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

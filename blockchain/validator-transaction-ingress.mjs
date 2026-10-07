import { createServer } from "node:http";

import { transactionId } from "./chain.mjs";
import {
  hardenHttpServer, HTTP_MAX_HEADER_BYTES, HttpIngressGuard,
  ingressErrorResponse, readBoundedConsensusJson, rejectUnexpectedRequestBody,
} from "./http-ingress.mjs";
import { requestJson } from "./http-client.mjs";

const TRANSACTION_PATH = "/v1/transactions";
const HASH = /^[0-9a-f]{64}$/;
const BODY_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 256 * 1024;

function send(response, status, value, close = false, walletOrigin = null) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    vary: "Origin",
    ...(walletOrigin ? { "access-control-allow-origin": walletOrigin } : {}),
    ...(close ? { connection: "close" } : {}),
  });
  response.end(body);
}

export function validateValidatorTransactionIngressConfig({
  expectedNetworkId, tlsCertificateSha256, upstreamOrigin, walletOrigin = null,
} = {}) {
  if (typeof expectedNetworkId !== "string" || expectedNetworkId.length < 3 ||
      expectedNetworkId.length > 128 || !HASH.test(tlsCertificateSha256 ?? "")) {
    throw new Error("transaction ingress network or TLS pin is invalid");
  }
  let url;
  try { url = new URL(upstreamOrigin); }
  catch { throw new Error("transaction ingress upstream origin is invalid"); }
  if (url.protocol !== "https:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || url.origin !== upstreamOrigin) {
    throw new Error("transaction ingress requires an exact loopback HTTPS upstream origin");
  }
  if (walletOrigin !== null) {
    let browser;
    try { browser = new URL(walletOrigin); }
    catch { throw new Error("transaction ingress wallet origin is invalid"); }
    if (browser.protocol !== "http:" || browser.hostname !== "127.0.0.1" ||
        !browser.port || Number(browser.port) < 1 || browser.username || browser.password || browser.pathname !== "/" ||
        browser.search || browser.hash || browser.origin !== walletOrigin) {
      throw new Error("transaction ingress requires an exact local wallet origin");
    }
  }
  return { expectedNetworkId, tlsCertificateSha256, upstreamOrigin: url.origin, walletOrigin };
}

/** A loopback-only deployment component. Its sole upstream request path is fixed. */
export function createValidatorTransactionIngressServer(config) {
  const trusted = validateValidatorTransactionIngressConfig(config);
  const ingressOptions = {
    burst: 20, maxActive: 16, maxActivePerAddress: 8,
    maxBodyBytes: BODY_LIMIT, maxConnections: 64, requestsPerMinute: 60,
  };
  const ingress = new HttpIngressGuard(ingressOptions);
  const server = createServer({ maxHeaderSize: HTTP_MAX_HEADER_BYTES }, async (request, response) => {
    let release;
    try {
      release = ingress.begin(request);
      if (!["POST", "OPTIONS"].includes(request.method) || request.url !== TRANSACTION_PATH) {
        return send(response, 404, { error: "not found" }, true);
      }
      const browserOrigin = request.headers.origin;
      if (browserOrigin !== undefined && browserOrigin !== trusted.walletOrigin) {
        return send(response, 403, { error: "browser origins are not accepted" }, true);
      }
      if (request.method === "OPTIONS") {
        if (browserOrigin === undefined ||
            request.headers["access-control-request-method"] !== "POST" ||
            request.headers["access-control-request-headers"]?.toLowerCase() !== "content-type") {
          return send(response, 403, { error: "transaction preflight is invalid" }, true);
        }
        rejectUnexpectedRequestBody(request);
        response.writeHead(204, {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "POST",
          "access-control-allow-origin": trusted.walletOrigin,
          "cache-control": "no-store",
          vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        });
        response.end(); return;
      }
      if (request.headers["content-type"] !== "application/json") {
        return send(response, 415, { error: "application/json is required" }, true, browserOrigin);
      }
      const transaction = await readBoundedConsensusJson(request, ingressOptions);
      if (transaction?.networkId !== trusted.expectedNetworkId) {
        return send(response, 400, { error: "transaction network is invalid" }, false, browserOrigin);
      }
      const expectedId = transactionId(transaction);
      let upstream;
      try {
        upstream = await requestJson(`${trusted.upstreamOrigin}${TRANSACTION_PATH}`, {
          body: transaction, method: "POST", maxResponseBytes: RESPONSE_LIMIT,
          timeoutMs: 5_000, tlsCertificateSha256: trusted.tlsCertificateSha256,
        });
      } catch {
        return send(response, 502, { error: "validator ingress is unavailable" }, false, browserOrigin);
      }
      if (!upstream.ok) {
        return send(response, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
          { error: "validator rejected transaction" }, false, browserOrigin);
      }
      const result = upstream.body;
      if (upstream.status !== 202 || !["queued", "known"].includes(result?.status) ||
          result.transactionId !== expectedId ||
          !Number.isSafeInteger(result.gossipedPeers) || result.gossipedPeers < 0 ||
          result.gossipedPeers > 512 || result.height !== undefined ||
          result.blockHash !== undefined) {
        return send(response, 502, { error: "validator ingress response is invalid" }, false, browserOrigin);
      }
      return send(response, 202, {
        status: result.status,
        transactionId: result.transactionId,
        gossipedPeers: result.gossipedPeers,
      }, false, browserOrigin);
    } catch (error) {
      ingress.record(error);
      const rejected = ingressErrorResponse(error);
      return send(response, rejected.status, { error: rejected.message }, false,
        request.headers.origin === trusted.walletOrigin ? trusted.walletOrigin : null);
    } finally {
      release?.();
    }
  });
  return hardenHttpServer(server, ingressOptions);
}

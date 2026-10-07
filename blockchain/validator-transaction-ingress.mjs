import { createServer } from "node:http";

import { transactionId } from "./chain.mjs";
import {
  hardenHttpServer, HTTP_MAX_HEADER_BYTES, HttpIngressGuard,
  ingressErrorResponse, readBoundedConsensusJson,
} from "./http-ingress.mjs";
import { requestJson } from "./http-client.mjs";

const TRANSACTION_PATH = "/v1/transactions";
const HASH = /^[0-9a-f]{64}$/;
const BODY_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 256 * 1024;

function send(response, status, value, close = false) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...(close ? { connection: "close" } : {}),
  });
  response.end(body);
}

export function validateValidatorTransactionIngressConfig({
  expectedNetworkId, tlsCertificateSha256, upstreamOrigin,
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
  return { expectedNetworkId, tlsCertificateSha256, upstreamOrigin: url.origin };
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
      if (request.method !== "POST" || request.url !== TRANSACTION_PATH) {
        return send(response, 404, { error: "not found" }, true);
      }
      // There is no browser/CORS contract. Reject simple cross-origin form posts as well.
      if (request.headers.origin !== undefined) {
        return send(response, 403, { error: "browser origins are not accepted" }, true);
      }
      if (request.headers["content-type"] !== "application/json") {
        return send(response, 415, { error: "application/json is required" }, true);
      }
      const transaction = await readBoundedConsensusJson(request, ingressOptions);
      if (transaction?.networkId !== trusted.expectedNetworkId) {
        return send(response, 400, { error: "transaction network is invalid" });
      }
      const expectedId = transactionId(transaction);
      let upstream;
      try {
        upstream = await requestJson(`${trusted.upstreamOrigin}${TRANSACTION_PATH}`, {
          body: transaction, method: "POST", maxResponseBytes: RESPONSE_LIMIT,
          timeoutMs: 5_000, tlsCertificateSha256: trusted.tlsCertificateSha256,
        });
      } catch {
        return send(response, 502, { error: "validator ingress is unavailable" });
      }
      if (!upstream.ok) {
        return send(response, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
          { error: "validator rejected transaction" });
      }
      const result = upstream.body;
      if (upstream.status !== 202 || !["queued", "known"].includes(result?.status) ||
          result.transactionId !== expectedId ||
          !Number.isSafeInteger(result.gossipedPeers) || result.gossipedPeers < 0 ||
          result.gossipedPeers > 512 || result.height !== undefined ||
          result.blockHash !== undefined) {
        return send(response, 502, { error: "validator ingress response is invalid" });
      }
      return send(response, 202, result);
    } catch (error) {
      ingress.record(error);
      const rejected = ingressErrorResponse(error);
      return send(response, rejected.status, { error: rejected.message });
    } finally {
      release?.();
    }
  });
  return hardenHttpServer(server, ingressOptions);
}

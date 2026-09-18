import { createServer } from "node:http";
import {
  hardenHttpServer,
  HTTP_MAX_HEADER_BYTES,
  HttpIngressGuard,
  ingressErrorResponse,
  readBoundedConsensusJson,
} from "./http-ingress.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;

function send(response, status, value, origin = null) {
  const body = JSON.stringify(value);
  const headers = {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
  if (origin) headers["access-control-allow-origin"] = origin;
  response.writeHead(status, headers);
  response.end(body);
}

function allowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return null;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$/.test(origin) ? origin : false;
}

export function createNodeHttpServer(node, options = {}) {
  const httpIngressOptions = {
    maxBodyBytes: 64 * 1024,
    ...(options.httpIngress ?? {}),
  };
  const httpIngress = new HttpIngressGuard(httpIngressOptions);
  const server = createServer({ maxHeaderSize: HTTP_MAX_HEADER_BYTES }, async (request, response) => {
    let finishIngress = null;
    const origin = allowedOrigin(request);
    try {
      finishIngress = httpIngress.begin(request);
      if (origin === false) return send(response, 403, { error: "origin is not allowed" });
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          ...(origin ? { "access-control-allow-origin": origin } : {}),
        });
        response.end(); return;
      }
      const url = new URL(request.url, "http://node.local");
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, {
          height: node.height, networkId: node.networkId, status: "ready",
          tipHash: node.tipHash, valueMode: "valueless-devnet",
          ...(node.consensusMode ? { consensusMode: node.consensusMode } : {}),
          ...(node.certificateMode ? { certificateMode: node.certificateMode } : {}),
          ...(Number.isSafeInteger(node.protocolVersion) ? { protocolVersion: node.protocolVersion } : {}),
          ...(node.pendingProtocolUpgrade !== undefined
            ? { pendingProtocolUpgrade: node.pendingProtocolUpgrade } : {}),
          ...(Number.isSafeInteger(node.mempoolSize) ? { mempoolSize: node.mempoolSize } : {}),
        }, origin);
      }
      if (request.method === "GET" && url.pathname === "/v1/validator-handoffs") {
        if (typeof node.validatorHandoffHistory !== "function") {
          return send(response, 501, { error: "validator handoff history is unavailable" }, origin);
        }
        const history = await node.validatorHandoffHistory();
        return send(response, 200, Array.isArray(history) ? { handoffs: history } : history, origin);
      }
      if (request.method === "GET" && url.pathname === "/v1/finality-proofs") {
        if (typeof node.finalityProofsAfter !== "function") {
          return send(response, 501, { error: "finality proofs are unavailable" }, origin);
        }
        const fromHeight = Number(url.searchParams.get("fromHeight"));
        const limitValue = url.searchParams.get("limit");
        const limit = limitValue === null ? undefined : Number(limitValue);
        const proofs = await node.finalityProofsAfter(fromHeight, limit);
        return send(response, 200, { proofs }, origin);
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/transactions/") &&
          url.pathname.endsWith("/proof")) {
        if (typeof node.transactionProof !== "function") {
          return send(response, 501, { error: "transaction proof is unavailable" }, origin);
        }
        const id = decodeURIComponent(url.pathname.slice("/v1/transactions/".length, -6));
        return send(response, 200, await node.transactionProof(id), origin);
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/accounts/")) {
        const accountPath = url.pathname.slice("/v1/accounts/".length);
        const proofRequest = accountPath.endsWith("/proof");
        const historyRequest = accountPath.endsWith("/history");
        const address = decodeURIComponent(proofRequest ? accountPath.slice(0, -6)
          : historyRequest ? accountPath.slice(0, -8) : accountPath);
        if (!ADDRESS.test(address)) throw new Error("address is invalid");
        if (historyRequest) {
          if (typeof node.accountHistoryPage !== "function") {
            return send(response, 501, { error: "account history pages are unavailable" }, origin);
          }
          const beforeText = url.searchParams.get("before");
          const limitText = url.searchParams.get("limit");
          return send(response, 200, await node.accountHistoryPage(address, {
            ...(beforeText === null ? {} : { before: Number(beforeText) }),
            ...(limitText === null ? {} : { limit: Number(limitText) }),
          }), origin);
        }
        if (proofRequest) {
          if (typeof node.accountProof !== "function") {
            return send(response, 501, { error: "account proof is unavailable" }, origin);
          }
          return send(response, 200, await node.accountProof(address), origin);
        }
        return send(response, 200, node.account(address), origin);
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/assets/") &&
          url.pathname.endsWith("/proof")) {
        if (typeof node.assetProof !== "function") return send(response, 501, { error: "asset proofs are unavailable" }, origin);
        const assetId = decodeURIComponent(url.pathname.slice("/v1/assets/".length, -6));
        const holder = url.searchParams.get("holder");
        if (!/^[0-9a-f]{64}$/.test(assetId) || !ADDRESS.test(holder ?? "")) throw new Error("asset proof request is invalid");
        return send(response, 200, await node.assetProof(assetId, holder), origin);
      }
      if (request.method === "GET" && url.pathname === "/v1/fees") {
        return send(response, 200, node.feeQuote(url.searchParams.get("amount"),
          url.searchParams.get("fee") ?? undefined), origin);
      }
      if (request.method === "GET" && url.pathname === "/metrics") {
        return send(response, 200, { httpIngress: httpIngress.metrics() }, origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/transactions") {
        const body = await readBoundedConsensusJson(request, httpIngressOptions);
        return send(response, 202, await node.submitTransaction(body), origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/faucet") {
        const { recipient, amount } = await readBoundedConsensusJson(request, httpIngressOptions);
        if (!ADDRESS.test(recipient ?? "")) throw new Error("recipient is invalid");
        return send(response, 202, await node.faucet(recipient, amount), origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/blocks/produce" && node.produceBlock) {
        return send(response, 202, await node.produceBlock(), origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/snapshots/create" && node.createSnapshot) {
        return send(response, 201, await node.createSnapshot(), origin);
      }
      return send(response, 404, { error: "not found" }, origin);
    } catch (error) {
      httpIngress.record(error);
      const rejected = ingressErrorResponse(error);
      return send(response, rejected.status, { error: rejected.message }, origin);
    } finally {
      finishIngress?.();
    }
  });
  return hardenHttpServer(server, httpIngressOptions);
}

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

import {
  hardenHttpServer,
  HTTP_MAX_HEADER_BYTES,
  HttpIngressError,
  HttpIngressGuard,
  ingressErrorResponse,
  readBoundedConsensusJson,
  rejectUnexpectedRequestBody,
} from "./http-ingress.mjs";
import { createFallbackBeaconShare, createProgressBeaconShare } from "./operators.mjs";

const HASH = /^[0-9a-f]{64}$/;
const MAX_BEACON_RESPONSE_BYTES = 32 * 1024;

function json(response, status, value) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_BEACON_RESPONSE_BYTES) {
    throw new Error("beacon response exceeds its bound");
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function exactShareRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("beacon share request is invalid");
  }
  const keys = Object.keys(value).sort();
  const expected = value.purpose === undefined
    ? ["candidateId", "round"] : ["candidateId", "purpose", "round"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
      !HASH.test(value.candidateId ?? "") || !Number.isSafeInteger(value.round) ||
      value.round < 1 ||
      value.purpose !== undefined && !["fallback", "progress"].includes(value.purpose)) {
    throw new Error("beacon share request is invalid");
  }
  return {
    candidateId: value.candidateId,
    purpose: value.purpose ?? "fallback",
    round: value.round,
  };
}

export function createBeaconHttpServer({
  issued,
  networkId,
  persist,
  wallet,
}, options = {}) {
  const maxIssuedShares = options.maxIssuedShares ?? 10_000;
  if (!(issued instanceof Map) || typeof persist !== "function" ||
      !wallet || typeof networkId !== "string" || networkId.length < 1 ||
      Buffer.byteLength(networkId) > 64 || !Number.isSafeInteger(maxIssuedShares) ||
      maxIssuedShares < 1 || maxIssuedShares > 1_000_000 || issued.size > maxIssuedShares) {
    throw new Error("beacon HTTP service configuration is invalid");
  }
  const randomBytesImpl = options.randomBytesImpl ?? randomBytes;
  if (typeof randomBytesImpl !== "function") throw new Error("beacon randomness source is invalid");
  const httpIngressOptions = {
    burst: 30,
    maxActive: 8,
    maxActivePerAddress: 2,
    maxBodyBytes: 8_192,
    maxConnections: 16,
    requestsPerMinute: 60,
    ...(options.httpIngress ?? {}),
  };
  const httpIngress = new HttpIngressGuard(httpIngressOptions);
  const totals = { capacityRejected: 0, sharesCreated: 0, sharesReplayed: 0 };
  const failedKeys = new Set();
  const pending = new Map();
  let mutationTail = Promise.resolve();
  const serialize = (operation) => {
    const result = mutationTail.then(operation);
    mutationTail = result.catch(() => {});
    return result;
  };
  const server = createServer({ maxHeaderSize: HTTP_MAX_HEADER_BYTES }, async (request, response) => {
    let release = null;
    try {
      release = httpIngress.begin(request);
      response.once("finish", release);
      response.once("close", release);
      const url = new URL(request.url, "http://beacon.invalid");
      if (url.search || url.hash) throw new Error("beacon request URL is invalid");
      if (request.method === "GET") {
        rejectUnexpectedRequestBody(request);
        if (url.pathname === "/health") {
          json(response, 200, {
            address: wallet.address, algorithm: wallet.algorithm, networkId, status: "ready",
          });
          return;
        }
        if (url.pathname === "/metrics") {
          json(response, 200, {
            beacon: { ...totals, issuedShares: issued.size },
            httpIngress: httpIngress.metrics(),
          });
          return;
        }
        json(response, 404, { error: "not found" }); return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/share") {
        rejectUnexpectedRequestBody(request);
        json(response, 404, { error: "not found" }); return;
      }
      const { candidateId, purpose, round } = exactShareRequest(
        await readBoundedConsensusJson(request, httpIngressOptions),
      );
      const key = `${purpose}:${candidateId}:${round}`;
      const legacyKey = `${candidateId}:${round}`;
      if (failedKeys.has(key)) {
        throw new HttpIngressError(
          "durability", "beacon share context requires operator recovery", 503,
        );
      }
      let share = issued.get(key) ?? (purpose === "fallback" ? issued.get(legacyKey) : undefined);
      if (share) {
        totals.sharesReplayed += 1;
        json(response, 200, share); return;
      }
      let operation = pending.get(key);
      if (operation === undefined) {
        operation = serialize(async () => {
          const known = issued.get(key) ??
            (purpose === "fallback" ? issued.get(legacyKey) : undefined);
          if (known) return { created: false, share: known };
          if (issued.size >= maxIssuedShares) {
            totals.capacityRejected += 1;
            throw new HttpIngressError("capacity", "beacon share capacity is exhausted", 503);
          }
          const createShare = purpose === "progress"
            ? createProgressBeaconShare : createFallbackBeaconShare;
          const value = randomBytesImpl(32);
          if (!Buffer.isBuffer(value) || value.length !== 32) {
            throw new Error("beacon randomness source failed");
          }
          const created = createShare({
            wallet, networkId, candidateId, round, value: value.toString("hex"),
          });
          try { await persist(key, created); }
          catch (error) { failedKeys.add(key); throw error; }
          issued.set(key, created);
          totals.sharesCreated += 1;
          return { created: true, share: created };
        });
        pending.set(key, operation);
        operation.finally(() => {
          if (pending.get(key) === operation) pending.delete(key);
        }).catch(() => {});
      } else {
        totals.sharesReplayed += 1;
      }
      ({ share } = await operation);
      json(response, 200, share);
    } catch (error) {
      httpIngress.record(error);
      if (!response.headersSent) {
        const rejected = ingressErrorResponse(error);
        json(response, rejected.status, { error: rejected.message });
      } else response.destroy();
    }
  });
  server.httpIngressMetrics = () => ({
    beacon: { ...totals, issuedShares: issued.size },
    httpIngress: httpIngress.metrics(),
  });
  return hardenHttpServer(server, httpIngressOptions);
}

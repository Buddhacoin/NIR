import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
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
import { VerificationScheduler } from "./operator-defense.mjs";
import { verifyBeaconShareRequest } from "./beacon-request-auth.mjs";

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

export function createBeaconHttpServer({
  issued,
  networkId,
  nonces,
  persist,
  requesters,
  wallet,
}, options = {}) {
  const maxIssuedShares = options.maxIssuedShares ?? 10_000;
  const maxNonces = options.maxNonces ?? 100_000;
  if (!(issued instanceof Map) || !(nonces instanceof Map) || !(requesters instanceof Map) ||
      requesters.size < 1 || typeof persist !== "function" ||
      !wallet || typeof networkId !== "string" || networkId.length < 1 ||
      Buffer.byteLength(networkId) > 64 || !Number.isSafeInteger(maxIssuedShares) ||
      maxIssuedShares < 1 || maxIssuedShares > 1_000_000 || issued.size > maxIssuedShares ||
      !Number.isSafeInteger(maxNonces) || maxNonces < 1 || maxNonces > 1_000_000 ||
      nonces.size > maxNonces) {
    throw new Error("beacon HTTP service configuration is invalid");
  }
  const randomBytesImpl = options.randomBytesImpl ?? randomBytes;
  const clock = options.clock ?? (() => Date.now());
  const timeHighWater = options.timeHighWater ?? (() => 0);
  const stateMetrics = options.stateMetrics ?? (() => ({
    activeNonces: nonces.size, generation: 0, highWater: timeHighWater(), maxNonces,
  }));
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
  const authentication = options.authenticationScheduler ?? new VerificationScheduler({
    maxConcurrent: 2, maxPerIdentity: 2, maxQueued: 16, maxQueuedPerIdentity: 16,
  });
  if (typeof authentication.run !== "function" || typeof authentication.metrics !== "function") {
    throw new Error("beacon authentication scheduler is invalid");
  }
  const totals = { capacityRejected: 0, sharesCreated: 0, sharesReplayed: 0 };
  const failedKeys = new Set();
  const failedNonces = new Set();
  let mutationTail = Promise.resolve();
  const serialize = (operation) => {
    const result = mutationTail.then(operation);
    mutationTail = result.catch(() => {});
    return result;
  };
  const tls = options.tls ?? null;
  if (tls !== null && ((typeof tls.key !== "string" && !Buffer.isBuffer(tls.key)) ||
      (typeof tls.cert !== "string" && !Buffer.isBuffer(tls.cert)))) {
    throw new Error("beacon TLS key and certificate are required together");
  }
  const handler = async (request, response) => {
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
            antiReplay: stateMetrics(),
            authentication: authentication.metrics(),
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
      const envelope = await readBoundedConsensusJson(request, httpIngressOptions);
      const claimed = envelope?.payload?.requester;
      if (typeof claimed !== "string" || !requesters.has(claimed)) {
        throw new Error("beacon share requester is unauthorized");
      }
      const auth = await authentication.run("beacon-preauth", () => verifyBeaconShareRequest(envelope, {
        beaconAddress: wallet.address, clock, minimumTime: timeHighWater(), networkId, requesters,
      }));
      const { candidateId, generation, purpose, replayKey, round } = auth;
      if (nonces.has(replayKey) || failedNonces.has(replayKey)) {
        throw new HttpIngressError("replay", "beacon share request nonce was already used", 409);
      }
      const key = `${purpose}:${generation}:${candidateId}:${round}`;
      const generationlessKey = `${purpose}:${candidateId}:${round}`;
      const legacyKey = `${candidateId}:${round}`;
      if (failedKeys.has(key)) {
        throw new HttpIngressError(
          "durability", "beacon share context requires operator recovery", 503,
        );
      }
      const operation = serialize(async () => {
          if (nonces.has(replayKey) || failedNonces.has(replayKey)) {
            throw new HttpIngressError("replay", "beacon share request nonce was already used", 409);
          }
          if (nonces.size >= maxNonces) {
            totals.capacityRejected += 1;
            throw new HttpIngressError("capacity", "beacon nonce capacity is exhausted", 503);
          }
          const known = issued.get(key) ?? (generation === 0
            ? issued.get(generationlessKey) ??
              (purpose === "fallback" ? issued.get(legacyKey) : undefined)
            : undefined);
          if (known) {
            try { await persist({ auth, type: "nonce" }); }
            catch (error) { failedNonces.add(replayKey); throw error; }
            nonces.set(replayKey, auth.expiresAt);
            totals.sharesReplayed += 1;
            return known;
          }
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
            wallet, networkId, candidateId, generation, round, value: value.toString("hex"),
          });
          try { await persist({ auth, key, share: created, type: "share-and-nonce" }); }
          catch (error) { failedKeys.add(key); failedNonces.add(replayKey); throw error; }
          issued.set(key, created);
          nonces.set(replayKey, auth.expiresAt);
          totals.sharesCreated += 1;
          return created;
        });
      const share = await operation;
      json(response, 200, share);
    } catch (error) {
      httpIngress.record(error);
      if (!response.headersSent) {
        const rejected = ingressErrorResponse(error);
        json(response, rejected.status, { error: rejected.message });
      } else response.destroy();
    }
  };
  const server = tls === null
    ? createServer({ maxHeaderSize: HTTP_MAX_HEADER_BYTES }, handler)
    : createHttpsServer({
      cert: tls.cert, key: tls.key, maxHeaderSize: HTTP_MAX_HEADER_BYTES, minVersion: "TLSv1.3",
    }, handler);
  server.httpIngressMetrics = () => ({
    beacon: { ...totals, issuedShares: issued.size },
    antiReplay: stateMetrics(),
    authentication: authentication.metrics(),
    httpIngress: httpIngress.metrics(),
  });
  return hardenHttpServer(server, httpIngressOptions);
}

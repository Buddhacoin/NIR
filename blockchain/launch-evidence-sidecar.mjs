import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import {
  HttpIngressGuard,
  HTTP_MAX_HEADER_BYTES,
  ingressErrorResponse,
  readBoundedConsensusJson,
  rejectUnexpectedRequestBody,
} from "./http-ingress.mjs";
import {
  signMultiHostLaunchServiceResponse,
  validateMultiHostLaunchPlan,
  verifyMultiHostLaunchReceipt,
} from "./multi-host-launch-evidence.mjs";

const MAX_RESPONSE_BYTES = 16 * 1024;

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}

function send(response, status, value) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    throw new Error("launch evidence response exceeds its bound");
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

/**
 * Creates the deliberately narrow responder used by a public-testnet operator
 * behind its already configured HTTPS origin.  The sidecar proves possession of
 * the configured evidence key and an exact, pre-signed host receipt; it does
 * not claim to prove that the host or operator is independent.
 */
export function createLaunchEvidenceSidecar({ plan: planValue, receipt: receiptValue, wallet }, options = {}) {
  const allowInsecureLocalhost = options.allowInsecureLocalhost === true;
  const clock = options.clock ?? (() => Date.now());
  const tls = options.tls ?? null;
  if (typeof clock !== "function" || (tls !== null &&
      ((typeof tls.key !== "string" && !Buffer.isBuffer(tls.key)) ||
       (typeof tls.cert !== "string" && !Buffer.isBuffer(tls.cert))))) {
    throw new Error("launch evidence sidecar configuration is invalid");
  }
  const validationOptions = { allowInsecureLocalhost };
  const plan = validateMultiHostLaunchPlan(planValue, validationOptions);
  const receipt = verifyMultiHostLaunchReceipt(receiptValue, plan, validationOptions);
  if (!wallet || wallet.address !== receipt.signer.address || wallet.publicKey !== receipt.signer.publicKey) {
    throw new Error("launch evidence sidecar wallet is not the receipt signer");
  }
  const ingressOptions = {
    bodyIdleTimeoutMs: 3_000,
    burst: 20,
    maxActive: 4,
    maxActivePerAddress: 2,
    maxBodyBytes: 1_024,
    maxConnections: 8,
    maxHeaderBytes: 8_192,
    maxJsonNodes: 16,
    maxUrlBytes: 256,
    requestsPerMinute: 30,
    ...(options.httpIngress ?? {}),
  };
  const ingress = new HttpIngressGuard({ ...ingressOptions, clock });
  const handler = async (request, response) => {
    let release;
    try {
      release = ingress.begin(request);
      response.once("finish", release);
      response.once("close", release);
      const url = new URL(request.url, "http://launch-evidence.invalid");
      if (url.search || url.hash || request.method !== "POST" ||
          url.pathname !== "/v1/launch-evidence") {
        rejectUnexpectedRequestBody(request);
        send(response, 404, { error: "not found" });
        return;
      }
      const requestValue = await readBoundedConsensusJson(request, ingressOptions);
      exact(requestValue, ["challengeNonce", "planHash", "receiptHash", "runNonce"],
        "launch evidence challenge");
      if (requestValue.planHash !== plan.planHash || requestValue.receiptHash !== receipt.receiptHash ||
          requestValue.runNonce !== plan.runNonce) {
        throw new Error("launch evidence challenge does not match the configured receipt");
      }
      const responseValue = signMultiHostLaunchServiceResponse(plan, receipt, {
        challengeNonce: requestValue.challengeNonce, respondedAt: clock(), wallet,
      }, validationOptions);
      send(response, 200, responseValue);
    } catch (error) {
      ingress.record(error);
      if (!response.headersSent) {
        const rejected = ingressErrorResponse(error);
        send(response, rejected.status, { error: rejected.message });
      } else response.destroy();
    }
  };
  const server = tls === null
    ? createHttpServer({ maxHeaderSize: HTTP_MAX_HEADER_BYTES }, handler)
    : createHttpsServer({ cert: tls.cert, key: tls.key, maxHeaderSize: HTTP_MAX_HEADER_BYTES,
      minVersion: "TLSv1.3" }, handler);
  server.launchEvidenceMetrics = () => ingress.metrics();
  return server;
}

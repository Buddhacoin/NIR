import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { verifyAccountProof, MAX_ACCOUNT_PROOF_BYTES } from "./account-proof.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";
import { verifyFinalityProofChain, MAX_FINALITY_CHAIN_BYTES } from "./light-client.mjs";
import { advanceValidatorTrust } from "./validator-handoff.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const FIREFOX_ORIGIN = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function send(response, status, value, origin) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "access-control-allow-origin": origin,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "vary": "Origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(body);
}

function tokenMatches(supplied, expected) {
  if (typeof supplied !== "string") return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("request is too large");
    chunks.push(chunk);
  }
  return parseConsensusJson(Buffer.concat(chunks).toString("utf8"));
}

// This is deliberately a separate capability from the native wallet bridge.
// Its token is useful only for checking public evidence for one fixed address;
// there is no vault path, account selection, signing or token-upgrade route.
export function createAccountObserverBridgeServer({
  address, origin, sessionToken, trustAnchor,
} = {}) {
  const networkId = trustAnchor?.expectedNetworkId;
  const genesis = trustAnchor?.genesisCheckpoint;
  if (!ADDRESS.test(address ?? "") || !FIREFOX_ORIGIN.test(origin ?? "") ||
      !HASH.test(sessionToken ?? "") ||
      typeof networkId !== "string" || networkId.length < 3 || networkId.length > 128 ||
      !Array.isArray(trustAnchor?.trustedValidators) ||
      !genesis || genesis.height !== 0 || !HASH.test(genesis.tipHash ?? "") ||
      !HASH.test(genesis.stateRoot ?? "") || !HASH.test(genesis.accountStateRoot ?? "") ||
      !HASH.test(genesis.validatorSetId ?? "")) {
    throw new Error("account observer configuration is invalid");
  }
  const trust = {
    expectedNetworkId: networkId,
    handoffs: structuredClone(trustAnchor.handoffs ?? []),
    trustedValidators: structuredClone(trustAnchor.trustedValidators),
  };
  advanceValidatorTrust(trust);
  const pinnedGenesis = structuredClone(genesis);
  let verifiedTip = null;
  return createServer(async (request, response) => {
    const requestOrigin = request.headers.origin;
    const remoteAddress = request.socket.remoteAddress ?? "";
    if (requestOrigin !== origin ||
        !/^(?:localhost|127\.0\.0\.1):[0-9]{1,5}$/.test(request.headers.host ?? "") ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress)) {
      return send(response, 403, { error: "observer origin or host is not allowed" }, origin);
    }
    if (request.method === "OPTIONS") {
      if (request.headers["access-control-request-method"] !== "POST" ||
          request.headers["access-control-request-headers"]?.toLowerCase() !==
            "content-type,x-nir-observer-token") {
        return send(response, 403, { error: "observer preflight is invalid" }, origin);
      }
      response.writeHead(204, {
        "access-control-allow-headers": "content-type, x-nir-observer-token",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-origin": origin,
        "access-control-max-age": "300",
        "vary": "Origin",
      });
      response.end();
      return;
    }
    if (!tokenMatches(request.headers["x-nir-observer-token"], sessionToken)) {
      return send(response, 401, { error: "observer session is not authorized" }, origin);
    }
    const url = new URL(request.url, "http://observer.local");
    if (url.search || request.method !== "POST" ||
        !["/v1/verify-finality-chain", "/v1/verify-account-proof"].includes(url.pathname)) {
      return send(response, 404, { error: "observer endpoint is unavailable" }, origin);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
      return send(response, 415, { error: "application/json is required" }, origin);
    }
    try {
      if (url.pathname === "/v1/verify-finality-chain") {
        const body = await readJson(request, MAX_FINALITY_CHAIN_BYTES + 64 * 1024);
        // Always verify the full chain from the pinned genesis. A shorter
        // untrusted replacement may be valid but cannot roll the tip backward.
        const next = verifyFinalityProofChain(body?.proofs, {
          checkpoint: pinnedGenesis,
          expectedNetworkId: networkId,
          handoffs: trust.handoffs,
          trustedValidators: trust.trustedValidators,
        });
        const previousHeightProof = verifiedTip && body.proofs[verifiedTip.height - 1];
        if (verifiedTip && (next.height < verifiedTip.height ||
            previousHeightProof?.hash !== verifiedTip.tipHash)) {
          throw new Error("observer finality tip would roll back or conflict");
        }
        verifiedTip = next;
        return send(response, 200, {
          genesisHash: pinnedGenesis.tipHash, networkId, tip: next, verified: true,
        }, origin);
      }
      const body = await readJson(request, MAX_ACCOUNT_PROOF_BYTES + 1_024);
      if (!body || Object.keys(body).sort().join(",") !== "proof" || !verifiedTip ||
          body.proof?.height !== verifiedTip.height) {
        throw new Error("account proof requires the latest verified finality tip");
      }
      const activeTrust = advanceValidatorTrust({
        expectedNetworkId: networkId,
        handoffs: trust.handoffs.filter(({ activationHeight }) =>
          activationHeight <= body.proof.height),
        trustedValidators: trust.trustedValidators,
      });
      if (activeTrust.lastHandoff?.activationHeight === body.proof.height &&
          (body.proof.tipHash !== activeTrust.lastHandoff.activationBlockHash ||
           body.proof.stateRoot !== activeTrust.lastHandoff.activationStateRoot)) {
        throw new Error("account proof does not match validator activation block");
      }
      const statement = verifyAccountProof(body.proof, {
        expectedAddress: address,
        expectedNetworkId: networkId,
        minimumHeight: verifiedTip.height,
        trustedValidators: activeTrust.trustedValidators,
      });
      if (statement.accountStateRoot !== verifiedTip.accountStateRoot ||
          statement.tipHash !== verifiedTip.tipHash ||
          statement.stateRoot !== verifiedTip.stateRoot ||
          statement.validatorSetId !== verifiedTip.validatorSetId ||
          statement.protocolVersion !== verifiedTip.protocolVersion ||
          JSON.stringify(statement.pendingProtocolUpgrade) !==
            JSON.stringify(verifiedTip.pendingProtocolUpgrade)) {
        throw new Error("account proof does not match verified finality chain");
      }
      return send(response, 200, {
        address, genesisHash: pinnedGenesis.tipHash, networkId, statement, verified: true,
      }, origin);
    } catch {
      return send(response, 400, { error: "observer evidence could not be verified" }, origin);
    }
  });
}

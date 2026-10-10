import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { verifyAccountProof, MAX_ACCOUNT_PROOF_BYTES } from "./account-proof.mjs";
import {
  acquireAccountObserverSession, loadAccountObserverCheckpoint,
  saveAccountObserverCheckpoint,
} from "./account-observer-checkpoint.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";
import { CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION } from "./constants.mjs";
import {
  verifyFinalityProofChain, MAX_FINALITY_CHAIN_BYTES, MAX_FINALITY_PROOFS,
} from "./light-client.mjs";
import { advanceValidatorTrust } from "./validator-handoff.mjs";
import { validatorSetId } from "./validator-rotation.mjs";

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

async function readNodeJson(nodeBaseUrl, path, maximumBytes) {
  const response = await fetch(`${nodeBaseUrl}${path}`, {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
      Number(response.headers.get("content-length") ?? 0) > maximumBytes) {
    throw new Error("node proof response is unavailable or too large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("node proof response is too large");
    chunks.push(chunk);
  }
  return parseConsensusJson(Buffer.concat(chunks).toString("utf8"));
}

// This is deliberately a separate capability from the native wallet bridge.
// Its token is useful only for checking public evidence for one fixed address;
// there is no vault path, account selection, signing or token-upgrade route.
export function createAccountObserverBridgeServer({
  address, checkpointPath, nodeBaseUrl, origin, sessionToken, trustAnchor,
} = {}) {
  const networkId = trustAnchor?.expectedNetworkId;
  const genesis = trustAnchor?.genesisCheckpoint;
  if (!ADDRESS.test(address ?? "") || !FIREFOX_ORIGIN.test(origin ?? "") ||
      !HASH.test(sessionToken ?? "") ||
      (checkpointPath !== undefined &&
       (typeof checkpointPath !== "string" || checkpointPath.length < 1)) ||
      (nodeBaseUrl !== undefined &&
        (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(nodeBaseUrl) ||
         Number(nodeBaseUrl.slice("http://127.0.0.1:".length)) > 65_535)) ||
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
  const binding = { address, genesisHash: pinnedGenesis.tipHash, networkId };
  const releaseSession = checkpointPath
    ? acquireAccountObserverSession(checkpointPath) : null;
  let savedCheckpoint;
  try {
    savedCheckpoint = checkpointPath
      ? loadAccountObserverCheckpoint(checkpointPath, binding) : null;
    if (savedCheckpoint) {
      const active = advanceValidatorTrust({
        expectedNetworkId: networkId,
        handoffs: trust.handoffs.filter(({ activationHeight }) =>
          activationHeight <= savedCheckpoint.tip.height),
        trustedValidators: trust.trustedValidators,
      });
      if (savedCheckpoint.tip.validatorSetId !== validatorSetId(active.trustedValidators)) {
        throw new Error("observer checkpoint validator set is not trusted");
      }
    }
  } catch (error) {
    releaseSession?.();
    throw error;
  }
  let verifiedTip = savedCheckpoint?.tip ?? null;
  let verifiedTimestamp = savedCheckpoint?.lastTimestamp ?? null;
  let refreshPending = false;
  const verifyChain = (proofs) => {
    const base = verifiedTip ?? pinnedGenesis;
    if (!Array.isArray(proofs) || proofs[0]?.header?.height !== base.height + 1 ||
        proofs[0]?.header?.previousHash !== base.tipHash ||
        (verifiedTimestamp !== null && proofs[0]?.header?.timestamp < verifiedTimestamp)) {
      throw new Error("observer finality chain does not extend the verified tip");
    }
    if (proofs.some(({ header }) =>
      header?.protocolVersion >= CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION &&
      header?.chainIdentityGenesisHash !== pinnedGenesis.tipHash)) {
      throw new Error("observer finality chain has a foreign genesis identity");
    }
    // A pre-v28 checkpoint is bound to genesis by the private local store; v28+
    // additionally authenticates the genesis identity inside every header.
    const next = verifyFinalityProofChain(proofs, {
      checkpoint: base,
      expectedChainIdentityGenesisHash: base.height > 0 &&
        base.protocolVersion < CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION
        ? null : pinnedGenesis.tipHash,
      expectedNetworkId: networkId,
      handoffs: trust.handoffs,
      trustedValidators: trust.trustedValidators,
    });
    return next;
  };
  const commitTip = (tip, timestamp) => {
    if (checkpointPath) saveAccountObserverCheckpoint(checkpointPath, binding, tip, timestamp);
    verifiedTip = tip;
    verifiedTimestamp = timestamp;
  };
  const verifyAccount = (proof, tip) => {
    if (!tip || proof?.height !== tip.height) {
      throw new Error("account proof requires the latest verified finality tip");
    }
    const activeTrust = advanceValidatorTrust({
      expectedNetworkId: networkId,
      handoffs: trust.handoffs.filter(({ activationHeight }) =>
        activationHeight <= proof.height),
      trustedValidators: trust.trustedValidators,
    });
    if (activeTrust.lastHandoff?.activationHeight === proof.height &&
        (proof.tipHash !== activeTrust.lastHandoff.activationBlockHash ||
         proof.stateRoot !== activeTrust.lastHandoff.activationStateRoot)) {
      throw new Error("account proof does not match validator activation block");
    }
    const statement = verifyAccountProof(proof, {
      expectedAddress: address,
      expectedNetworkId: networkId,
      minimumHeight: tip.height,
      trustedValidators: activeTrust.trustedValidators,
    });
    if (statement.accountStateRoot !== tip.accountStateRoot ||
        statement.tipHash !== tip.tipHash || statement.stateRoot !== tip.stateRoot ||
        statement.validatorSetId !== tip.validatorSetId ||
        statement.protocolVersion !== tip.protocolVersion ||
        JSON.stringify(statement.pendingProtocolUpgrade) !==
          JSON.stringify(tip.pendingProtocolUpgrade)) {
      throw new Error("account proof does not match verified finality chain");
    }
    return statement;
  };
  const server = createServer(async (request, response) => {
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
        !["/v1/verify-finality-chain", "/v1/verify-account-proof",
          "/v1/refresh-account"].includes(url.pathname)) {
      return send(response, 404, { error: "observer endpoint is unavailable" }, origin);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
      return send(response, 415, { error: "application/json is required" }, origin);
    }
    try {
      if (url.pathname === "/v1/refresh-account") {
        if (!nodeBaseUrl) return send(response, 404, { error: "node reader is not configured" }, origin);
        if (refreshPending) return send(response, 409, { error: "account refresh is already running" }, origin);
        const body = await readJson(request, 16);
        if (!body || Array.isArray(body) || Object.keys(body).length !== 0) {
          throw new Error("account refresh body is invalid");
        }
        if (refreshPending) return send(response, 409, { error: "account refresh is already running" }, origin);
        refreshPending = true;
        try {
          const health = await readNodeJson(nodeBaseUrl, "/health", 1_024);
          if (health?.networkId !== networkId || !Number.isSafeInteger(health.height) ||
              health.height < 1 || !HASH.test(health.tipHash ?? "") ||
              health.height < (verifiedTip?.height ?? 0)) {
            throw new Error("node height or network is unsupported");
          }
          while ((verifiedTip?.height ?? 0) < health.height) {
            const fromHeight = verifiedTip?.height ?? 0;
            const limit = Math.min(MAX_FINALITY_PROOFS, health.height - fromHeight);
            const finality = await readNodeJson(nodeBaseUrl,
              `/v1/finality-proofs?fromHeight=${fromHeight}&limit=${limit}`,
              MAX_FINALITY_CHAIN_BYTES + 64 * 1024);
            if (!Array.isArray(finality?.proofs) || finality.proofs.length !== limit) {
              throw new Error("node finality chain is incomplete");
            }
            const next = verifyChain(finality.proofs);
            commitTip(next, finality.proofs.at(-1).header.timestamp);
          }
          const next = verifiedTip;
          if (next.height !== health.height || next.tipHash !== health.tipHash) {
            throw new Error("node tip changed during account refresh");
          }
          const priorTip = verifiedTip;
          const proof = await readNodeJson(nodeBaseUrl,
            `/v1/accounts/${address}/proof`, MAX_ACCOUNT_PROOF_BYTES + 1_024);
          const statement = verifyAccount(proof, next);
          if (verifiedTip !== priorTip) {
            throw new Error("observer tip changed during account refresh");
          }
          return send(response, 200, {
            address, genesisHash: pinnedGenesis.tipHash, networkId, statement, verified: true,
          }, origin);
        } finally {
          refreshPending = false;
        }
      }
      if (url.pathname === "/v1/verify-finality-chain") {
        if (refreshPending) return send(response, 409,
          { error: "account refresh is already running" }, origin);
        refreshPending = true;
        try {
          const body = await readJson(request, MAX_FINALITY_CHAIN_BYTES + 64 * 1024);
          const next = verifyChain(body?.proofs);
          commitTip(next, body.proofs.at(-1).header.timestamp);
          return send(response, 200, {
            genesisHash: pinnedGenesis.tipHash, networkId, tip: next, verified: true,
          }, origin);
        } finally {
          refreshPending = false;
        }
      }
      const body = await readJson(request, MAX_ACCOUNT_PROOF_BYTES + 1_024);
      if (!body || Object.keys(body).sort().join(",") !== "proof") {
        throw new Error("account proof body is invalid");
      }
      const statement = verifyAccount(body.proof, verifiedTip);
      return send(response, 200, {
        address, genesisHash: pinnedGenesis.tipHash, networkId, statement, verified: true,
      }, origin);
    } catch {
      return send(response, 400, { error: "observer evidence could not be verified" }, origin);
    }
  });
  if (releaseSession) server.once("close", releaseSession);
  return server;
}

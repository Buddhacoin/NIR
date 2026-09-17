import { randomBytes } from "node:crypto";

import { hashObject, signObject, verifyObject } from "./crypto.mjs";

export const PEER_CLOCK_SKEW_MS = 30_000;

function requestFields({ body, method, networkId, nonce, path, signer, timestamp }) {
  return {
    bodyHash: hashObject(body, "PEER_BODY"), method, networkId, nonce, path, signer, timestamp,
  };
}

export function createPeerRequest({ body, method = "POST", networkId, path, wallet,
  timestamp = Date.now(), nonce = randomBytes(16).toString("hex") }) {
  const fields = requestFields({
    body, method, networkId, nonce, path, signer: wallet.address, timestamp,
  });
  return { ...fields, signature: signObject(fields, wallet, "PEER_REQUEST") };
}

export function verifyPeerRequest({ auth, body, method, networkId, path, seenNonces,
  trustedPeer, now = Date.now(), minimumTimestamp = 0 }) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new Error("peer authentication is required");
  if (!/^[0-9a-f]{32}$/.test(auth.nonce ?? "")) throw new Error("peer request nonce is invalid");
  if (!Number.isSafeInteger(auth.timestamp) || auth.timestamp < minimumTimestamp ||
      Math.abs(now - auth.timestamp) > PEER_CLOCK_SKEW_MS) {
    throw new Error("peer request timestamp is outside the allowed window");
  }
  if (seenNonces.has(auth.nonce)) throw new Error("peer request replay detected");
  const fields = requestFields({
    body, method, networkId, nonce: auth.nonce, path, signer: trustedPeer.address,
    timestamp: auth.timestamp,
  });
  if (auth.signer !== trustedPeer.address || auth.networkId !== networkId ||
      auth.method !== method || auth.path !== path || auth.bodyHash !== fields.bodyHash ||
      !verifyObject(fields, auth.signature, trustedPeer.publicKey, "PEER_REQUEST")) {
    throw new Error("peer request signature is invalid");
  }
  if (typeof seenNonces.cleanup === "function") seenNonces.cleanup(now);
  else {
    for (const [nonce, timestamp] of seenNonces) {
      if (now - timestamp > PEER_CLOCK_SKEW_MS) seenNonces.delete(nonce);
    }
  }
  seenNonces.set(auth.nonce, now);
  return auth.nonce;
}

function responseFields({ networkId, requestNonce, result, signer }) {
  return {
    networkId, requestNonce, resultHash: hashObject(result, "PEER_RESULT"), signer,
  };
}

export function createPeerResponse({ networkId, requestNonce, result, wallet }) {
  const fields = responseFields({ networkId, requestNonce, result, signer: wallet.address });
  return { ...fields, signature: signObject(fields, wallet, "PEER_RESPONSE") };
}

export function verifyPeerResponse({ auth, networkId, requestNonce, result, trustedPeer }) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new Error("peer response authentication is required");
  const fields = responseFields({ networkId, requestNonce, result, signer: trustedPeer.address });
  if (auth.signer !== trustedPeer.address || auth.networkId !== networkId ||
      auth.requestNonce !== requestNonce || auth.resultHash !== fields.resultHash ||
      !verifyObject(fields, auth.signature, trustedPeer.publicKey, "PEER_RESPONSE")) {
    throw new Error("peer response signature is invalid");
  }
  return result;
}

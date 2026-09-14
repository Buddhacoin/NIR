import assert from "node:assert/strict";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  createPeerRequest,
  createPeerResponse,
  PEER_CLOCK_SKEW_MS,
  verifyPeerRequest,
  verifyPeerResponse,
} from "../blockchain/peer-auth.mjs";

test("peer requests bind identity, network, route, body, freshness, and nonce", () => {
  const wallet = generateWallet();
  const trustedPeer = publicWallet(wallet);
  const body = { height: 7 };
  const now = 1_000_000;
  const auth = createPeerRequest({ body, networkId: "nir-test", path: "/v1/blocks", wallet, timestamp: now });
  const seenNonces = new Map();
  assert.equal(verifyPeerRequest({
    auth, body, method: "POST", networkId: "nir-test", now, path: "/v1/blocks",
    seenNonces, trustedPeer,
  }), auth.nonce);
  assert.throws(() => verifyPeerRequest({
    auth, body, method: "POST", networkId: "nir-test", now, path: "/v1/blocks",
    seenNonces, trustedPeer,
  }), /replay/);
  assert.throws(() => verifyPeerRequest({
    auth: createPeerRequest({ body, networkId: "nir-test", path: "/v1/blocks", wallet,
      timestamp: now - PEER_CLOCK_SKEW_MS - 1 }),
    body, method: "POST", networkId: "nir-test", now, path: "/v1/blocks",
    seenNonces: new Map(), trustedPeer,
  }), /timestamp/);
});

test("peer authentication rejects mutation and authenticates the response validator", () => {
  const coordinator = generateWallet();
  const validator = generateWallet();
  const body = { block: "original" };
  const auth = createPeerRequest({ body, networkId: "nir-test", path: "/v1/proposals", wallet: coordinator });
  assert.throws(() => verifyPeerRequest({
    auth, body: { block: "altered" }, method: "POST", networkId: "nir-test",
    path: "/v1/proposals", seenNonces: new Map(), trustedPeer: publicWallet(coordinator),
  }), /signature/);
  const result = { accepted: true };
  const response = createPeerResponse({
    networkId: "nir-test", requestNonce: auth.nonce, result, wallet: validator,
  });
  assert.deepEqual(verifyPeerResponse({
    auth: response, networkId: "nir-test", requestNonce: auth.nonce,
    result, trustedPeer: publicWallet(validator),
  }), result);
  assert.throws(() => verifyPeerResponse({
    auth: response, networkId: "nir-test", requestNonce: auth.nonce,
    result: { accepted: false }, trustedPeer: publicWallet(validator),
  }), /signature/);
});

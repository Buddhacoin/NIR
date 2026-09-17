import assert from "node:assert/strict";
import test from "node:test";

import { generateWallet } from "../blockchain/crypto.mjs";
import { createPaymentRequest, verifyPaymentRequest } from "../blockchain/payment-request.mjs";

test("a payment request binds recipient, amount, network, expiry, and memo", () => {
  const wallet = generateWallet();
  const now = 2_000_000_000_000;
  const request = createPaymentRequest({
    wallet,
    networkId: "nir-testnet",
    amount: "250000000",
    memo: "Order 42",
    expiresAt: now + 60_000,
    requestId: "a".repeat(64),
  });
  assert.deepEqual(verifyPaymentRequest(request, { networkId: "nir-testnet", now }), request);
  for (const mutation of [
    { amount: "250000001" },
    { memo: "Order 43" },
    { recipient: generateWallet().address },
    { expiresAt: request.expiresAt + 1 },
  ]) {
    assert.throws(() => verifyPaymentRequest({ ...request, ...mutation }, {
      networkId: "nir-testnet", now,
    }), /invalid|does not match/);
  }
});

test("payment requests fail closed across networks, expiry, and unknown fields", () => {
  const wallet = generateWallet();
  const now = 2_000_000_000_000;
  const request = createPaymentRequest({
    wallet,
    networkId: "nir-testnet",
    amount: "1",
    expiresAt: now + 60_000,
    requestId: "b".repeat(64),
  });
  assert.throws(() => verifyPaymentRequest(request, { networkId: "nir-other", now }),
    /another network/);
  assert.throws(() => verifyPaymentRequest(request, {
    networkId: "nir-testnet", now: request.expiresAt,
  }), /expired/);
  assert.throws(() => verifyPaymentRequest({ ...request, redirect: "https://evil.invalid" }, {
    networkId: "nir-testnet", now,
  }), /shape/);
});

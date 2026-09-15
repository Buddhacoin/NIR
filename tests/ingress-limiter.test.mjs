import assert from "node:assert/strict";
import test from "node:test";

import { IngressLimiter } from "../blockchain/ingress-limiter.mjs";

test("token bucket admits bursts, rejects excess, and refills over time", () => {
  const limiter = new IngressLimiter({ capacity: 2, refillPerMinute: 1 });
  assert.equal(limiter.consume("client", 1_000), 1);
  assert.equal(limiter.consume("client", 1_000), 0);
  assert.throws(() => limiter.consume("client", 1_000), /rate limit/);
  assert.equal(limiter.consume("client", 61_000), 0);
});

test("token bucket keeps a bounded least-recently-used identity table", () => {
  const limiter = new IngressLimiter({ capacity: 1, maxKeys: 2, refillPerMinute: 1 });
  limiter.consume("first", 1_000);
  limiter.consume("second", 1_000);
  limiter.consume("third", 1_000);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.consume("first", 1_000), 0);
  assert.equal(limiter.size, 2);
});

test("token bucket rejects unsafe configuration and request identities", () => {
  assert.throws(() => new IngressLimiter({ capacity: 0 }), /configuration/);
  const limiter = new IngressLimiter();
  assert.throws(() => limiter.consume(""), /identity/);
  assert.throws(() => limiter.consume("client", Date.now(), 21), /identity/);
});

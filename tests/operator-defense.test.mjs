import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedAllSettled,
  PeerReputation,
  ReplayNonceCache,
  VerificationScheduler,
} from "../blockchain/operator-defense.mjs";

class FakeScheduler {
  now = 0;
  #next = 1;
  #tasks = new Map();

  setTimeout = (callback, delay) => {
    const id = this.#next;
    this.#next += 1;
    this.#tasks.set(id, { callback, due: this.now + delay });
    return id;
  };

  clearTimeout = (id) => { this.#tasks.delete(id); };

  advance(milliseconds) {
    this.now += milliseconds;
    while (true) {
      const next = [...this.#tasks.entries()]
        .filter(([, task]) => task.due <= this.now)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next) return;
      this.#tasks.delete(next[0]);
      next[1].callback();
    }
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("message fanout applies backpressure and preserves result positions", async () => {
  let active = 0;
  let maximum = 0;
  const results = await boundedAllSettled(
    Array.from({ length: 40 }, (_, index) => index),
    async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(setImmediate);
      active -= 1;
      if (value === 17) throw new Error("objective peer failure");
      return value * 2;
    },
    4,
  );
  assert.equal(maximum, 4);
  assert.equal(results[3].value, 6);
  assert.equal(results[17].status, "rejected");
  assert.equal(results[39].value, 78);
});

test("expensive verification cannot starve authenticated quorum peers behind one proxy", async () => {
  const clock = new FakeScheduler();
  const scheduler = new VerificationScheduler({
    clock: () => clock.now,
    maxConcurrent: 3,
    maxPerIdentity: 1,
    maxQueued: 32,
    maxQueuedPerIdentity: 16,
    queueTimeoutMs: 5_000,
    scheduler: clock,
  });
  const gates = Array.from({ length: 12 }, deferred);
  const started = [];
  const evil = gates.slice(0, 9).map((gate, index) => scheduler.run("peer:evil", async () => {
    started.push(`evil-${index}`);
    await gate.promise;
  }));
  const honestA = scheduler.run("peer:honest-a", async () => {
    started.push("honest-a");
    await gates[9].promise;
  });
  const honestB = scheduler.run("peer:honest-b", async () => {
    started.push("honest-b");
    await gates[10].promise;
  });
  await new Promise(setImmediate);
  assert.deepEqual(new Set(started), new Set(["evil-0", "honest-a", "honest-b"]));
  assert.deepEqual(scheduler.metrics(), {
    active: 3,
    activeIdentities: 3,
    completed: 0,
    queued: 8,
    queuedIdentities: 1,
    queueRejected: 0,
    queueTimedOut: 0,
    started: 3,
  });
  assert.equal(JSON.stringify(scheduler.metrics()).includes("evil"), false);
  gates[9].resolve();
  gates[10].resolve();
  gates.slice(0, 9).forEach((gate) => gate.resolve());
  await Promise.all([...evil, honestA, honestB]);
  assert.equal(scheduler.metrics().active, 0);
  assert.equal(scheduler.metrics().completed, 11);
});

test("bounded queues reject floods and expire queued work deterministically", async () => {
  const clock = new FakeScheduler();
  const scheduler = new VerificationScheduler({
    clock: () => clock.now,
    maxConcurrent: 1,
    maxPerIdentity: 1,
    maxQueued: 2,
    maxQueuedPerIdentity: 2,
    queueTimeoutMs: 1_000,
    scheduler: clock,
  });
  const gate = deferred();
  const active = scheduler.run("peer:a", () => gate.promise);
  const queued = scheduler.run("peer:a", () => undefined);
  const queuedSecond = scheduler.run("peer:a", () => undefined);
  const rejected = scheduler.run("peer:a", () => undefined);
  await assert.rejects(rejected, /queue is full/);
  const queuedFailure = assert.rejects(queued, /queue timeout/);
  const secondFailure = assert.rejects(queuedSecond, /queue timeout/);
  clock.advance(1_001);
  await queuedFailure;
  await secondFailure;
  gate.resolve();
  await active;
  assert.equal(scheduler.metrics().queueRejected, 1);
  assert.equal(scheduler.metrics().queueTimedOut, 2);
});

test("rotating nonces are capped and timer cleanup does not need attacker traffic", () => {
  const clock = new FakeScheduler();
  const cache = new ReplayNonceCache({
    clock: () => clock.now,
    maxEntries: 16,
    scheduler: clock,
    ttlMs: 1_000,
  });
  for (let index = 0; index < 16; index += 1) cache.set(String(index).padStart(32, "0"), clock.now);
  assert.throws(() => cache.set("f".repeat(32), clock.now), /capacity/);
  assert.equal(cache.size, 16);
  clock.advance(1_001);
  assert.equal(cache.size, 0);
  cache.set("a".repeat(32), clock.now);
  assert.equal(cache.has("a".repeat(32)), true);
  cache.close();
});

test("strikes use authenticated identities, decay, cap, and recover safely", () => {
  let now = 0;
  const reputation = new PeerReputation({
    clock: () => now,
    decayMs: 1_000,
    maxEntries: 4,
    maxStrikes: 3,
    quarantineMs: 3_000,
    threshold: 2,
  });
  reputation.recordViolation("peer:operator-a", "invalid-block");
  reputation.recordViolation("peer:operator-a", "invalid-block");
  assert.throws(() => reputation.assertAllowed("peer:operator-a"), /quarantined/);
  assert.doesNotThrow(() => reputation.assertAllowed("peer:operator-b"));
  assert.equal(reputation.metrics().quarantinedPeers, 1);
  now = 3_001;
  assert.doesNotThrow(() => reputation.assertAllowed("peer:operator-a"));
  assert.equal(reputation.metrics().recoveries, 1);
  for (let index = 0; index < 10; index += 1) {
    reputation.recordViolation("peer:operator-c", "invalid-block");
  }
  assert.throws(() => reputation.assertAllowed("peer:operator-c"), /quarantined/);
});

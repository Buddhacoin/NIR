import assert from "node:assert/strict";
import test from "node:test";

import { createSessionGuard, reloadAfterPendingWrite } from "../src/session-guard.js";

function fakeClock() {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, due: time + delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= time) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

test("idle session locks at the deadline and cannot be extended after expiry", () => {
  const clock = fakeClock();
  let locks = 0;
  const guard = createSessionGuard({ idleMs: 300_000, onLock: () => { locks++; }, ...clock });
  clock.advance(299_999);
  assert.equal(locks, 0);
  clock.advance(1);
  assert.equal(locks, 1);
  assert.equal(guard.activity(), false);
  guard.resume();
  assert.equal(locks, 1);
});

test("genuine activity extends an active session but a suspended timer cannot bypass expiry", () => {
  const clock = fakeClock();
  let locks = 0;
  const guard = createSessionGuard({ idleMs: 300_000, onLock: () => { locks++; }, ...clock });
  clock.advance(200_000);
  guard.activity();
  clock.advance(200_000);
  assert.equal(locks, 0);
  clock.advance(100_000);
  assert.equal(locks, 1);
});

test("backgrounding locks once even while a timeout is pending", () => {
  const clock = fakeClock();
  let locks = 0;
  const guard = createSessionGuard({ idleMs: 300_000, onLock: () => { locks++; }, ...clock });
  guard.background();
  clock.advance(300_000);
  guard.background();
  assert.equal(locks, 1);
});

test("lock waits for an in-flight encrypted profile write before reloading", async () => {
  let settle;
  const write = new Promise((resolve) => { settle = resolve; });
  let reloads = 0;
  const completion = reloadAfterPendingWrite(write, () => { reloads++; });
  await Promise.resolve();
  assert.equal(reloads, 0);
  settle();
  await completion;
  assert.equal(reloads, 1);
});

test("failed profile write also reloads to the prior committed state", async () => {
  let reloads = 0;
  await reloadAfterPendingWrite(Promise.reject(new Error("storage unavailable")), () => { reloads++; });
  assert.equal(reloads, 1);
});

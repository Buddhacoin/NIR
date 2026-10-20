import assert from "node:assert/strict";
import test from "node:test";

import { PROOF_DIFFICULTY_V1, nextSearchLevel, solveTime } from "../blockchain/proof-difficulty.mjs";

const { window, targetSolveMs: target, expiryMs, minLevel, maxLevel } = PROOF_DIFFICULTY_V1;
const tasks = (times) => times.map((t, i) => ({ issuedAtMs: 1_000_000 * i, solvedAtMs: t === null ? null : 1_000_000 * i + t }));
const uniform = (t) => tasks(Array(window).fill(t));

test("the level moves toward the target solve time and stays inside its band", () => {
  assert.equal(nextSearchLevel(24, uniform(target)), 24);
  assert.equal(nextSearchLevel(24, uniform(target / 2)), 25);
  assert.equal(nextSearchLevel(24, uniform(target / 4)), 26);
  assert.equal(nextSearchLevel(24, uniform(3 * target)), 23);
  assert.equal(nextSearchLevel(24, uniform(5 * target)), 22);
  assert.equal(nextSearchLevel(24, uniform(null)), 22);
  assert.equal(nextSearchLevel(minLevel, uniform(null)), minLevel);
  assert.equal(nextSearchLevel(maxLevel, uniform(1)), maxLevel);
});

test("a minority of withheld or lucky answers cannot move the median", () => {
  const withheld = uniform(target);
  for (let i = 0; i < window / 2 - 1; i++) withheld[i].solvedAtMs = null;
  assert.equal(nextSearchLevel(24, withheld), 24);
  const lucky = uniform(target);
  for (let i = 0; i < window / 2 - 1; i++) lucky[i].solvedAtMs = lucky[i].issuedAtMs + 1;
  assert.equal(nextSearchLevel(24, lucky), 24);
  // The lower median breaks an even split toward harder tasks.
  lucky[window / 2 - 1].solvedAtMs = lucky[window / 2 - 1].issuedAtMs + 1;
  assert.equal(nextSearchLevel(24, lucky), 26);
});

test("late answers count as expired and malformed windows fail closed", () => {
  assert.equal(solveTime({ issuedAtMs: 0, solvedAtMs: expiryMs }), expiryMs);
  assert.equal(solveTime({ issuedAtMs: 0, solvedAtMs: expiryMs + 1 }), null);
  assert.throws(() => solveTime({ issuedAtMs: 10, solvedAtMs: 9 }), /precedes/);
  assert.throws(() => nextSearchLevel(24, uniform(target).slice(1)), /exactly/);
  assert.throws(() => nextSearchLevel(maxLevel + 1, uniform(target)), /out of range/);
  assert.throws(() => nextSearchLevel(24, tasks(Array(window).fill(-1))), /invalid|precedes/);
});

// Solvers whose time doubles with every level beyond their capacity, a
// stand-in for the measured growth. When solvers get stronger, the level follows.
test("the level settles near solver capacity and follows when solvers improve", () => {
  const solveAt = (level, capacity) => {
    const time = Math.round(target * 2 ** (level - capacity));
    return time > expiryMs ? null : time;
  };
  const run = (start, capacity, windows) => {
    let level = start;
    const path = [];
    for (let w = 0; w < windows; w++) {
      level = nextSearchLevel(level, uniform(solveAt(level, capacity)));
      path.push(level);
    }
    return path;
  };
  const settled = run(PROOF_DIFFICULTY_V1.initialLevel, 40, 30);
  assert.ok(settled.slice(-10).every((v) => Math.abs(v - 40) <= 1), settled.join(","));
  const improved = run(settled.at(-1), 70, 30);
  const reached = improved.findIndex((v) => Math.abs(v - 70) <= 1);
  assert.ok(reached !== -1 && reached < 20, improved.join(","));
  assert.ok(improved.slice(-10).every((v) => Math.abs(v - 70) <= 1), improved.join(","));
});

import assert from "node:assert/strict";
import test from "node:test";

import { PROOF_DIFFICULTY_V1, nextCliqueVertices, solveTime } from "../blockchain/proof-difficulty.mjs";

const { window, targetSolveMs: target, expiryMs } = PROOF_DIFFICULTY_V1;
const tasks = (times) => times.map((t, i) => ({ issuedAtMs: 1_000_000 * i, solvedAtMs: t === null ? null : 1_000_000 * i + t }));
const uniform = (t) => tasks(Array(window).fill(t));

test("the size moves toward the target solve time and stays inside its band", () => {
  assert.equal(nextCliqueVertices(64, uniform(target)), 64);
  assert.equal(nextCliqueVertices(64, uniform(target / 2)), 65);
  assert.equal(nextCliqueVertices(64, uniform(target / 4)), 68);
  assert.equal(nextCliqueVertices(64, uniform(3 * target)), 63);
  assert.equal(nextCliqueVertices(64, uniform(5 * target)), 60);
  assert.equal(nextCliqueVertices(64, uniform(null)), 60);
  assert.equal(nextCliqueVertices(PROOF_DIFFICULTY_V1.minVertices, uniform(null)), PROOF_DIFFICULTY_V1.minVertices);
  assert.equal(nextCliqueVertices(PROOF_DIFFICULTY_V1.maxVertices, uniform(1)), PROOF_DIFFICULTY_V1.maxVertices);
});

test("a minority of withheld or lucky answers cannot move the median", () => {
  const withheld = uniform(target);
  for (let i = 0; i < window / 2 - 1; i++) withheld[i].solvedAtMs = null;
  assert.equal(nextCliqueVertices(64, withheld), 64);
  const lucky = uniform(target);
  for (let i = 0; i < window / 2 - 1; i++) lucky[i].solvedAtMs = lucky[i].issuedAtMs + 1;
  assert.equal(nextCliqueVertices(64, lucky), 64);
  // The lower median breaks an even split toward harder tasks.
  lucky[window / 2 - 1].solvedAtMs = lucky[window / 2 - 1].issuedAtMs + 1;
  assert.equal(nextCliqueVertices(64, lucky), 68);
});

test("late answers count as expired and malformed windows fail closed", () => {
  assert.equal(solveTime({ issuedAtMs: 0, solvedAtMs: expiryMs }), expiryMs);
  assert.equal(solveTime({ issuedAtMs: 0, solvedAtMs: expiryMs + 1 }), null);
  assert.throws(() => solveTime({ issuedAtMs: 10, solvedAtMs: 9 }), /precedes/);
  assert.throws(() => nextCliqueVertices(64, uniform(target).slice(1)), /exactly/);
  assert.throws(() => nextCliqueVertices(15, uniform(target)), /out of range/);
  assert.throws(() => nextCliqueVertices(64, tasks(Array(window).fill(-1))), /invalid|precedes/);
});

// Solvers whose time doubles every four vertices beyond their capacity, a
// stand-in for exponential search. When solvers get stronger, the size follows.
test("the size settles near solver capacity and follows when solvers improve", () => {
  const solveAt = (vertices, capacity) => {
    const time = Math.round(target * 2 ** ((vertices - capacity) / 4));
    return time > expiryMs ? null : time;
  };
  const run = (start, capacity, windows) => {
    let vertices = start;
    const path = [];
    for (let w = 0; w < windows; w++) {
      vertices = nextCliqueVertices(vertices, uniform(solveAt(vertices, capacity)));
      path.push(vertices);
    }
    return path;
  };
  const settled = run(64, 100, 40);
  assert.ok(settled.slice(-10).every((v) => Math.abs(v - 100) <= 4), settled.join(","));
  const improved = run(settled.at(-1), 160, 40);
  const reached = improved.findIndex((v) => Math.abs(v - 160) <= 4);
  assert.ok(reached !== -1 && reached < 20, improved.join(","));
  assert.ok(improved.slice(-10).every((v) => Math.abs(v - 160) <= 4), improved.join(","));
});

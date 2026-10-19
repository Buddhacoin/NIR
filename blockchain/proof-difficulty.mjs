import { MIN_REWARD_INTERVAL_MS } from "./constants.mjs";
import { MAX_CLIQUE_VERTICES } from "./proof-tasks.mjs";

// Difficulty adjustment for network-generated proof tasks
// (docs/proof-mining.md §7.2.3). The network does not learn and does not know
// who solves its tasks; it watches only how fast answers arrive and resizes
// the next tasks. Stronger solvers therefore meet larger graphs.
export const PROOF_DIFFICULTY_V1 = Object.freeze({
  // Tasks per adjustment; the decision uses their median solve time.
  window: 16,
  // Target time from a task's block to the block that includes its first
  // valid answer, by finalized block timestamps.
  targetSolveMs: MIN_REWARD_INTERVAL_MS,
  // A task without an answer by then expires and counts as unsolved.
  expiryMs: 6 * MIN_REWARD_INTERVAL_MS,
  initialVertices: 64,
  minVertices: 16,
  maxVertices: MAX_CLIQUE_VERTICES,
});

function nonNegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

// Solve time of one task, or null when it expired without an answer.
export function solveTime({ issuedAtMs, solvedAtMs }, params = PROOF_DIFFICULTY_V1) {
  nonNegative(issuedAtMs, "task issue time");
  if (solvedAtMs === null) return null;
  const elapsed = nonNegative(solvedAtMs, "task answer time") - issuedAtMs;
  if (elapsed < 0) throw new Error("task answer precedes its task");
  return elapsed > params.expiryMs ? null : elapsed;
}

// The graph size for the next window, from the size used for the last window
// and that window's tasks in issue order. Median, not mean: one miner holding
// back answers or one lucky solve cannot move it.
export function nextCliqueVertices(vertices, tasks, params = PROOF_DIFFICULTY_V1) {
  if (!Number.isSafeInteger(vertices) || vertices < params.minVertices || vertices > params.maxVertices) {
    throw new Error("current task size is out of range");
  }
  if (!Array.isArray(tasks) || tasks.length !== params.window) {
    throw new Error(`difficulty adjustment needs exactly ${params.window} tasks`);
  }
  // Unsolved tasks sort after every solved one.
  const times = tasks.map((task) => solveTime(task, params))
    .sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b));
  const median = times[(params.window - 1) >> 1];
  // Hardness grows exponentially with the size. Far from the target, move by
  // about 1/16 of the size so a large jump in solver strength is caught up in
  // a few windows; near it, move by one vertex so the size settles instead of
  // jumping across the target band.
  const target = params.targetSolveMs;
  const far = Math.max(1, vertices >> 4);
  let next = vertices;
  if (median === null || median > 4 * target) next = vertices - far;
  else if (median > 2 * target) next = vertices - 1;
  else if (median * 4 <= target) next = vertices + far;
  else if (median * 2 <= target) next = vertices + 1;
  return Math.min(params.maxVertices, Math.max(params.minVertices, next));
}

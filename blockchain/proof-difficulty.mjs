import { CLIQUE_SEARCH_V1 } from "./clique-search.mjs";
import { MIN_REWARD_INTERVAL_MS } from "./constants.mjs";

// Difficulty adjustment for network-generated proof tasks
// (docs/proof-mining.md §7.2.3). The network does not learn and does not know
// who solves its tasks; it watches only how fast answers arrive and resizes
// the next tasks. Stronger solvers therefore meet harder levels: larger
// cliques in graphs that hold fewer of them (clique-search.mjs).
export const PROOF_DIFFICULTY_V1 = Object.freeze({
  // Tasks per adjustment; the decision uses their median solve time.
  window: 16,
  // Target time from a task's block to the block that includes its first
  // valid answer, by finalized block timestamps.
  targetSolveMs: MIN_REWARD_INTERVAL_MS,
  // A task without an answer by then expires and counts as unsolved.
  expiryMs: 6 * MIN_REWARD_INTERVAL_MS,
  // Provisional. Plain backtracking in JavaScript on one core solved level
  // 40 (15 vertices among 1578) in 10-67 s and level 36 in 0.05-10 s; a SAT
  // solver was 100-1000 times slower. Starting low is safer: fast windows
  // raise the level within one window, while tasks that are too hard each
  // take an hour to expire.
  initialLevel: 40,
  minLevel: 0,
  maxLevel: CLIQUE_SEARCH_V1.maxLevel,
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

// The level for the next window, from the level used for the last window and
// that window's tasks in issue order. Median, not mean: one miner holding back
// answers or one lucky solve cannot move it.
export function nextSearchLevel(level, tasks, params = PROOF_DIFFICULTY_V1) {
  if (!Number.isSafeInteger(level) || level < params.minLevel || level > params.maxLevel) {
    throw new Error("current task level is out of range");
  }
  if (!Array.isArray(tasks) || tasks.length !== params.window) {
    throw new Error(`difficulty adjustment needs exactly ${params.window} tasks`);
  }
  // Unsolved tasks sort after every solved one.
  const times = tasks.map((task) => solveTime(task, params))
    .sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b));
  const median = times[(params.window - 1) >> 1];
  // Levels are already geometric: each makes the search a few times harder.
  // Far from the target move two levels, near it one, so the level settles
  // instead of jumping across the target band.
  const target = params.targetSolveMs;
  let next = level;
  if (median === null || median > 4 * target) next = level - 2;
  else if (median > 2 * target) next = level - 1;
  else if (median * 4 <= target) next = level + 2;
  else if (median * 2 <= target) next = level + 1;
  return Math.min(params.maxLevel, Math.max(params.minLevel, next));
}

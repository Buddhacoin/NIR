import { CLIQUE_SEARCH_V1, checkCliqueSearchAnswer } from "./clique-search.mjs";
import { hashObject } from "./crypto.mjs";
import { PROOF_DIFFICULTY_V1, nextSearchLevel } from "./proof-difficulty.mjs";

// State machine for network clique tasks (docs/proof-mining.md §5, §7.2.3).
// Pure and deterministic: the chain feeds it beacon rounds, transactions and
// block boundaries, and moves balances by the refunds and burns it returns.
//
// Each finalized beacon round issues one task at the current level. A miner
// first commits to an answer without showing it, then reveals it between
// `revealDelayBlocks` and `revealWindowBlocks` after the commit. The earliest
// commit with a valid reveal wins: once a valid reveal exists and no earlier
// commit for the task is still unrevealed, the task is solved. A commit
// copied from someone else's reveal is later than theirs and loses, and the
// recipient is bound inside the commitment.

export const PROOF_MINING_V1 = Object.freeze({
  revealDelayBlocks: 2,
  revealWindowBlocks: 16,
  // Locked by every commit; returned unless the commit is never revealed
  // while its task is still open, which is how withholding is charged.
  commitBond: 1_000_000n,
  maxOpenTasks: 64,
  maxCommitsPerTask: 256,
  maxPendingRewards: 1_024,
  search: CLIQUE_SEARCH_V1,
});

const HEX64 = /^[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(`proof mining ${message}`);
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`);
  return value;
}

export function createProofMiningState(difficulty = PROOF_DIFFICULTY_V1) {
  return { level: difficulty.initialLevel, tasks: new Map(), commits: new Map(), pendingRewards: [] };
}

export function proofTaskSeed({ networkId, round, beaconValue }) {
  return hashObject({ beaconValue, networkId, round }, "PROOF_TASK_CLIQUE_V1");
}

export function proofAnswerHash(vertices) {
  return hashObject({ vertices }, "PROOF_ANSWER_V1");
}

export function proofAnswerCommitment({ networkId, taskRound, recipient, salt, vertices }) {
  return hashObject({ answerHash: proofAnswerHash(vertices), networkId, recipient, salt, taskRound },
    "PROOF_ANSWER_COMMITMENT_V1");
}

// Called when a beacon round is finalized in a block.
export function issueProofTask(state, { networkId, round, beaconValue, height, timestampMs },
  difficulty = PROOF_DIFFICULTY_V1, params = PROOF_MINING_V1) {
  safeInteger(round, "task round");
  if (typeof beaconValue !== "string" || !HEX64.test(beaconValue)) fail("beacon value is invalid");
  if (state.tasks.has(round)) fail("task round was already issued");
  const open = [...state.tasks.values()].filter((task) => task.status === "open").length;
  // Too many unanswered tasks: skip this round rather than grow without bound.
  if (open >= params.maxOpenTasks) return null;
  const task = {
    round,
    seed: proofTaskSeed({ networkId, round, beaconValue }),
    level: state.level,
    issuedHeight: safeInteger(height, "task height"),
    issuedAtMs: safeInteger(timestampMs, "task time"),
    closesAtMs: timestampMs + difficulty.expiryMs,
    status: "open",
    solvedAtMs: null,
  };
  state.tasks.set(round, task);
  return task;
}

export function applyProofAnswerCommit(state, { commitment, taskRound, sender, height, index, timestampMs },
  params = PROOF_MINING_V1) {
  if (typeof commitment !== "string" || !HEX64.test(commitment)) fail("commitment is invalid");
  if (state.commits.has(commitment)) fail("commitment was already submitted");
  const task = state.tasks.get(taskRound);
  if (!task || task.status !== "open" || timestampMs > task.closesAtMs) fail("task is not open");
  const count = [...state.commits.values()].filter((c) => c.taskRound === taskRound).length;
  if (count >= params.maxCommitsPerTask) fail("task has too many commits");
  state.commits.set(commitment, {
    commitment,
    taskRound,
    sender,
    bond: params.commitBond,
    height: safeInteger(height, "commit height"),
    index: safeInteger(index, "commit index"),
    timestampMs: safeInteger(timestampMs, "commit time"),
    recipient: null,
  });
}

export function applyProofAnswerReveal(state, { networkId, commitment, recipient, salt, vertices, height },
  params = PROOF_MINING_V1) {
  const commit = state.commits.get(commitment);
  if (!commit || commit.recipient !== null) fail("reveal has no unrevealed commit");
  const task = state.tasks.get(commit.taskRound);
  if (!task || task.status !== "open") fail("task is not open");
  if (height < commit.height + params.revealDelayBlocks || height > commit.height + params.revealWindowBlocks) {
    fail("reveal is outside its window");
  }
  if (typeof salt !== "string" || !HEX64.test(salt)) fail("salt is invalid");
  if (proofAnswerCommitment({ networkId, taskRound: commit.taskRound, recipient, salt, vertices }) !== commitment) {
    fail("reveal does not match its commitment");
  }
  checkCliqueSearchAnswer(task.seed, task.level, vertices, params.search);
  commit.recipient = recipient;
}

const earlier = (a, b) => a.height < b.height || (a.height === b.height && a.index < b.index);

// Called after a block's transactions. Returns the bonds to return and to burn.
export function endProofMiningBlock(state, { networkId, height, timestampMs },
  difficulty = PROOF_DIFFICULTY_V1, params = PROOF_MINING_V1) {
  const refunds = [];
  let burned = 0n;
  const release = (commit, burn) => {
    state.commits.delete(commit.commitment);
    if (burn) burned += commit.bond;
    else refunds.push({ address: commit.sender, amount: commit.bond });
  };
  // Commits never revealed in their window: charged while the task is open.
  for (const commit of [...state.commits.values()]) {
    if (commit.recipient === null && height >= commit.height + params.revealWindowBlocks) {
      release(commit, state.tasks.get(commit.taskRound)?.status === "open");
    }
  }
  for (const task of [...state.tasks.values()].sort((a, b) => a.round - b.round)) {
    if (task.status !== "open") continue;
    const commits = [...state.commits.values()].filter((c) => c.taskRound === task.round);
    const revealed = commits.filter((c) => c.recipient !== null).sort((a, b) => (earlier(a, b) ? -1 : 1));
    const pending = commits.filter((c) => c.recipient === null);
    const best = revealed[0];
    if (best && pending.every((c) => earlier(best, c))) {
      if (state.pendingRewards.length >= params.maxPendingRewards) fail("pending rewards are full");
      task.status = "solved";
      task.solvedAtMs = best.timestampMs;
      state.pendingRewards.push({
        fingerprint: hashObject({ commitment: best.commitment, networkId, round: task.round }, "PROOF_TASK_REWARD_V1"),
        recipient: best.recipient,
        taskRound: task.round,
      });
      // Later commits lost a fair race; their bonds return.
      for (const commit of commits) release(commit, false);
    } else if (commits.length === 0 && timestampMs > task.closesAtMs) {
      task.status = "expired";
    }
  }
  // Retarget once the oldest `window` tasks are all closed, in issue order.
  for (;;) {
    const oldest = [...state.tasks.values()].sort((a, b) => a.round - b.round).slice(0, difficulty.window);
    if (oldest.length < difficulty.window || oldest.some((task) => task.status === "open")) break;
    state.level = nextSearchLevel(state.level, oldest.map((task) => ({
      issuedAtMs: task.issuedAtMs, solvedAtMs: task.solvedAtMs,
    })), difficulty);
    for (const task of oldest) state.tasks.delete(task.round);
  }
  return { refunds, burned };
}

// Winners waiting for the next block allowed to issue; the chain splits one
// epoch budget equally among them.
export function takeProofRewards(state, limit) {
  return state.pendingRewards.splice(0, safeInteger(limit, "reward limit"));
}

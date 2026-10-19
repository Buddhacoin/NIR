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
  return { level: difficulty.initialLevel, tasks: new Map(), commits: new Map(), pendingRewards: [],
    escrows: new Map() };
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

// Minted rewards wait in escrow before they can be spent, like progress
// rewards; `allocations` come from the chain's shared epoch budget.
export function escrowProofRewards(state, allocations, unlockHeight) {
  for (const { amount, fingerprint, recipient } of allocations) {
    if (state.escrows.has(fingerprint)) fail("reward was already escrowed");
    state.escrows.set(fingerprint, { amount, recipient, unlockHeight: safeInteger(unlockHeight, "unlock height") });
  }
}

export function matureProofRewards(state, height) {
  const credits = [];
  for (const [fingerprint, escrow] of [...state.escrows].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (height >= escrow.unlockHeight) {
      credits.push({ address: escrow.recipient, amount: escrow.amount });
      state.escrows.delete(fingerprint);
    }
  }
  return credits;
}

// Rebuilds the state from a consensus snapshot, where maps are sorted
// [key, value] lists and amounts are decimal strings. Rejects anything the
// state machine itself could not have produced.
export function parseProofMiningSnapshot(value, difficulty = PROOF_DIFFICULTY_V1, params = PROOF_MINING_V1) {
  const object = (v, keys, label) => {
    if (!v || typeof v !== "object" || Array.isArray(v) ||
        Object.keys(v).sort().join("\0") !== [...keys].sort().join("\0")) {
      fail(`snapshot ${label} is malformed`);
    }
    return v;
  };
  const entries = (v, label, max) => {
    if (!Array.isArray(v) || v.length > max) fail(`snapshot ${label} is malformed`);
    return v.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) fail(`snapshot ${label} is malformed`);
      return entry;
    });
  };
  const amount = (v, label) => {
    if (typeof v !== "string" || !/^(?:0|[1-9][0-9]{0,30})$/u.test(v)) fail(`snapshot ${label} is invalid`);
    return BigInt(v);
  };
  const hex = (v, label) => {
    if (typeof v !== "string" || !HEX64.test(v)) fail(`snapshot ${label} is invalid`);
    return v;
  };
  const text = (v, label) => {
    if (typeof v !== "string" || v.length === 0 || v.length > 256) fail(`snapshot ${label} is invalid`);
    return v;
  };
  object(value, ["commits", "escrows", "level", "pendingRewards", "tasks"], "proof mining state");
  const level = safeInteger(value.level, "snapshot level");
  if (level < difficulty.minLevel || level > difficulty.maxLevel) fail("snapshot level is out of range");
  const maxTasks = params.maxOpenTasks + difficulty.window * 4;
  const tasks = new Map(entries(value.tasks, "tasks", maxTasks).map(([key, task]) => {
    object(task, ["closesAtMs", "issuedAtMs", "issuedHeight", "level", "round", "seed", "solvedAtMs", "status"], "task");
    if (task.round !== key || !["open", "solved", "expired"].includes(task.status) ||
        (task.status === "solved") !== (task.solvedAtMs !== null)) {
      fail("snapshot task is inconsistent");
    }
    return [safeInteger(key, "task round"), {
      round: key, seed: hex(task.seed, "task seed"), level: safeInteger(task.level, "task level"),
      issuedHeight: safeInteger(task.issuedHeight, "task height"),
      issuedAtMs: safeInteger(task.issuedAtMs, "task time"),
      closesAtMs: safeInteger(task.closesAtMs, "task close time"), status: task.status,
      solvedAtMs: task.solvedAtMs === null ? null : safeInteger(task.solvedAtMs, "task solve time"),
    }];
  }));
  const commits = new Map(entries(value.commits, "commits", params.maxOpenTasks * params.maxCommitsPerTask)
    .map(([key, commit]) => {
      object(commit, ["bond", "commitment", "height", "index", "recipient", "sender", "taskRound", "timestampMs"], "commit");
      if (commit.commitment !== hex(key, "commitment") || !tasks.has(commit.taskRound)) {
        fail("snapshot commit is inconsistent");
      }
      return [key, {
        commitment: key, taskRound: commit.taskRound, sender: text(commit.sender, "commit sender"),
        bond: amount(commit.bond, "commit bond"), height: safeInteger(commit.height, "commit height"),
        index: safeInteger(commit.index, "commit index"),
        timestampMs: safeInteger(commit.timestampMs, "commit time"),
        recipient: commit.recipient === null ? null : text(commit.recipient, "commit recipient"),
      }];
    }));
  if (!Array.isArray(value.pendingRewards) || value.pendingRewards.length > params.maxPendingRewards) {
    fail("snapshot pending rewards are malformed");
  }
  const pendingRewards = value.pendingRewards.map((reward) => {
    object(reward, ["fingerprint", "recipient", "taskRound"], "pending reward");
    return { fingerprint: hex(reward.fingerprint, "reward fingerprint"),
      recipient: text(reward.recipient, "reward recipient"), taskRound: safeInteger(reward.taskRound, "reward round") };
  });
  const escrows = new Map(entries(value.escrows, "escrows", params.maxPendingRewards).map(([key, escrow]) => {
    object(escrow, ["amount", "recipient", "unlockHeight"], "escrow");
    return [hex(key, "escrow fingerprint"), { amount: amount(escrow.amount, "escrow amount"),
      recipient: text(escrow.recipient, "escrow recipient"),
      unlockHeight: safeInteger(escrow.unlockHeight, "escrow unlock height") }];
  }));
  return { level, tasks, commits, pendingRewards, escrows };
}

// What a miner needs, in plain JSON: the level, open tasks, the reveal
// window, and the tip's height and time, so a miner times tasks by the chain's
// clock rather than its own.
export function proofMiningView(state, { height, timestampMs }, params = PROOF_MINING_V1) {
  if (state === null) return { active: false, height, timestampMs };
  return {
    active: true,
    height,
    timestampMs,
    level: state.level,
    commitBond: params.commitBond.toString(),
    revealDelayBlocks: params.revealDelayBlocks,
    revealWindowBlocks: params.revealWindowBlocks,
    openTasks: [...state.tasks.values()].filter((task) => task.status === "open")
      .sort((a, b) => a.round - b.round)
      .map(({ round, seed, level, issuedHeight, issuedAtMs, closesAtMs }) =>
        ({ round, seed, level, issuedHeight, issuedAtMs, closesAtMs })),
    pendingRewards: state.pendingRewards.length,
  };
}

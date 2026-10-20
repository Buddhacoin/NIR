import assert from "node:assert/strict";
import test from "node:test";

import { CLIQUE_SEARCH_V1, cliqueEdge, cliqueSearchParameters } from "../blockchain/clique-search.mjs";
import { PROOF_DIFFICULTY_V1 } from "../blockchain/proof-difficulty.mjs";
import {
  PROOF_MINING_V1, applyProofAnswerCommit, applyProofAnswerReveal, createProofMiningState,
  endProofMiningBlock, issueProofTask, proofAnswerCommitment, takeProofRewards,
} from "../blockchain/proof-mining-state.mjs";

const networkId = "nir-testnet";
// Small cliques, found by plain backtracking.
const search = { ...CLIQUE_SEARCH_V1, baseClique: 4 };
const params = { ...PROOF_MINING_V1, search };
const difficulty = { ...PROOF_DIFFICULTY_V1, window: 2, initialLevel: 5 };
const minute = 60_000;
const alice = "nir1" + "a".repeat(64);
const bob = "nir1" + "b".repeat(64);
const mallory = "nir1" + "c".repeat(64);
const saltA = "1".repeat(64);
const saltB = "2".repeat(64);

function findClique(seed, level) {
  const { n, k } = cliqueSearchParameters(level, search);
  const extend = (chosen, from) => {
    if (chosen.length === k) return chosen;
    for (let v = from; v < n; v++) {
      if (chosen.every((u) => cliqueEdge(seed, n, u, v))) {
        const found = extend([...chosen, v], v + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return extend([], 0);
}

function setup() {
  const state = createProofMiningState(difficulty);
  const task = issueProofTask(state, { networkId, round: 1, beaconValue: "9".repeat(64), height: 10, timestampMs: 0 },
    difficulty, params);
  return { state, task, answer: findClique(task.seed, task.level) };
}

const commitFor = (task, recipient, salt, vertices) =>
  proofAnswerCommitment({ networkId, taskRound: task.round, recipient, salt, vertices });

function commit(state, task, { recipient, salt, vertices, sender = recipient, height, index = 0, timestampMs = minute }) {
  const commitment = commitFor(task, recipient, salt, vertices);
  applyProofAnswerCommit(state, { commitment, taskRound: task.round, sender, height, index, timestampMs }, params);
  return commitment;
}

const reveal = (state, commitment, recipient, salt, vertices, height) =>
  applyProofAnswerReveal(state, { networkId, commitment, recipient, salt, vertices, height }, params);

const end = (state, height, timestampMs = minute) =>
  endProofMiningBlock(state, { networkId, height, timestampMs }, difficulty, params);

test("a committed answer revealed in its window solves the task and returns the bond", () => {
  const { state, task, answer } = setup();
  assert.ok(answer);
  const c = commit(state, task, { recipient: alice, salt: saltA, vertices: answer, height: 11 });
  assert.throws(() => reveal(state, c, alice, saltA, answer, 12), /outside its window/);
  reveal(state, c, alice, saltA, answer, 13);
  const { refunds, burned } = end(state, 13);
  assert.equal(burned, 0n);
  assert.deepEqual(refunds, [{ address: alice, amount: params.commitBond }]);
  assert.equal(state.tasks.get(1).status, "solved");
  assert.equal(state.tasks.get(1).solvedAtMs, minute);
  const [reward] = takeProofRewards(state, 10);
  assert.equal(reward.recipient, alice);
  assert.match(reward.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(state.commits.size, 0);
});

test("copying a revealed answer cannot win, and a commitment binds its recipient", () => {
  const { state, task, answer } = setup();
  const honest = commit(state, task, { recipient: alice, salt: saltA, vertices: answer, height: 11 });
  // Mallory reads the answer and commits it for herself one block later.
  const copy = commit(state, task, { recipient: mallory, salt: saltB, vertices: answer, height: 12 });
  // Revealing Alice's commitment with another recipient does not match it.
  assert.throws(() => reveal(state, honest, mallory, saltA, answer, 14), /does not match/);
  reveal(state, copy, mallory, saltB, answer, 14);
  // Mallory revealed first, but Alice's earlier commit is still pending.
  end(state, 14);
  assert.equal(state.tasks.get(1).status, "open");
  reveal(state, honest, alice, saltA, answer, 15);
  const { refunds } = end(state, 15);
  assert.equal(takeProofRewards(state, 10)[0].recipient, alice);
  assert.deepEqual(refunds.map((r) => r.address).sort(), [alice, mallory].sort());
});

test("an earlier commit that is never revealed delays the task only for its window and loses its bond", () => {
  const { state, task, answer } = setup();
  const garbage = "f".repeat(64);
  applyProofAnswerCommit(state, { commitment: garbage, taskRound: 1, sender: mallory, height: 11, index: 0, timestampMs: minute }, params);
  const honest = commit(state, task, { recipient: bob, salt: saltB, vertices: answer, height: 11, index: 1 });
  reveal(state, honest, bob, saltB, answer, 13);
  end(state, 13);
  assert.equal(state.tasks.get(1).status, "open");
  const { refunds, burned } = end(state, 11 + params.revealWindowBlocks);
  assert.equal(burned, params.commitBond);
  assert.deepEqual(refunds, [{ address: bob, amount: params.commitBond }]);
  assert.equal(takeProofRewards(state, 10)[0].recipient, bob);
});

test("wrong answers, salts, late reveals and closed tasks are rejected", () => {
  const { state, task, answer } = setup();
  const wrong = [...answer.slice(0, -1), answer.at(-1) + 1].sort((a, b) => a - b);
  const c1 = commit(state, task, { recipient: alice, salt: saltA, vertices: wrong, height: 11 });
  assert.throws(() => reveal(state, c1, alice, saltA, wrong, 13), /non-adjacent|increasing|exactly/);
  const c2 = commit(state, task, { recipient: bob, salt: saltB, vertices: answer, height: 11, index: 1 });
  assert.throws(() => reveal(state, c2, bob, saltA, answer, 13), /does not match/);
  assert.throws(() => reveal(state, c2, bob, saltB, answer, 11 + params.revealWindowBlocks + 1), /outside/);
  assert.throws(() => applyProofAnswerCommit(state, { commitment: c2, taskRound: 1, sender: bob, height: 12, index: 0, timestampMs: minute }, params), /already/);
  assert.throws(() => applyProofAnswerCommit(state, { commitment: "e".repeat(64), taskRound: 1, sender: bob, height: 12, index: 0, timestampMs: difficulty.expiryMs + 1 }, params), /not open/);
  assert.throws(() => applyProofAnswerCommit(state, { commitment: "e".repeat(64), taskRound: 2, sender: bob, height: 12, index: 0, timestampMs: minute }, params), /not open/);
});

test("an unanswered task expires and difficulty follows solve times in issue order", () => {
  const state = createProofMiningState(difficulty);
  const issue = (round, t) => issueProofTask(state, { networkId, round, beaconValue: String(round % 10).repeat(64), height: round, timestampMs: t }, difficulty, params);
  // Two tasks solved within a minute: the level rises by two.
  for (const round of [1, 2]) {
    const task = issue(round, 0);
    const answer = findClique(task.seed, task.level);
    const c = commit(state, task, { recipient: alice, salt: saltA, vertices: answer, height: 10, index: round });
    reveal(state, c, alice, saltA, answer, 12);
  }
  end(state, 12);
  assert.equal(state.level, difficulty.initialLevel + 2);
  assert.equal(state.tasks.size, 0);
  // Two tasks nobody answers: they expire and the level falls by two.
  issue(3, 0);
  issue(4, 0);
  end(state, 20, difficulty.expiryMs);
  assert.equal(state.tasks.size, 2);
  end(state, 21, difficulty.expiryMs + 1);
  assert.equal(state.level, difficulty.initialLevel);
  assert.equal(takeProofRewards(state, 10).length, 2);
});

test("open tasks and pending rewards are bounded", () => {
  const state = createProofMiningState(difficulty);
  const small = { ...params, maxOpenTasks: 2 };
  for (const round of [1, 2]) {
    assert.ok(issueProofTask(state, { networkId, round, beaconValue: "1".repeat(64), height: round, timestampMs: 0 }, difficulty, small));
  }
  assert.equal(issueProofTask(state, { networkId, round: 3, beaconValue: "1".repeat(64), height: 3, timestampMs: 0 }, difficulty, small), null);
  assert.throws(() => issueProofTask(state, { networkId, round: 1, beaconValue: "1".repeat(64), height: 4, timestampMs: 0 }, difficulty, small), /already/);
  assert.throws(() => issueProofTask(state, { networkId, round: 5, beaconValue: "XYZ", height: 4, timestampMs: 0 }, difficulty, small), /beacon/);
});

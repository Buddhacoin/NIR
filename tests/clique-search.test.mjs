import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIQUE_SEARCH_V1, checkCliqueSearchAnswer, cliqueEdge, cliqueSearchParameters,
} from "../blockchain/clique-search.mjs";
import { cliqueInstance } from "../blockchain/proof-tasks.mjs";

const seed = "5e".repeat(32);

test("levels map to clique and graph sizes by exact arithmetic", () => {
  // Independently: the least n with comb(n, k) >= 2 ** (t + k * (k - 1) // 2) in Python.
  const expected = { 0: [275, 10], 7: [108, 10], 8: [385, 11], 24: [772, 13], 28: [506, 13],
    31: [369, 13], 32: [1101, 14], 80: [9778, 20], 159: [191238, 29] };
  for (const [level, [n, k]] of Object.entries(expected)) {
    assert.deepEqual(cliqueSearchParameters(Number(level)), { n, k });
  }
  for (const level of [-1, 160, 1.5]) assert.throws(() => cliqueSearchParameters(level), /out of range/);
});

test("edges are read straight from the seed stream that builds the whole graph", () => {
  for (const n of [5, 23, 40]) {
    const { graph } = cliqueInstance(seed, n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const bit = i !== j && ((graph >> BigInt(i * n + j)) & 1n) === 1n;
        assert.equal(cliqueEdge(seed, n, i, j), bit, `${n}: ${i}-${j}`);
      }
    }
  }
});

// Small parameters, where a clique is found by plain backtracking.
const small = { ...CLIQUE_SEARCH_V1, baseClique: 4 };

function findClique(level) {
  const { n, k } = cliqueSearchParameters(level, small);
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

test("a found clique is accepted and every malformed answer is rejected", () => {
  const level = 5;
  const answer = findClique(level);
  assert.ok(answer);
  const { n, k } = checkCliqueSearchAnswer(seed, level, answer, small);
  assert.equal(answer.length, k);
  const nonEdge = (() => {
    for (let v = 0; v < n; v++) if (!cliqueEdge(seed, n, answer[0], v) && v !== answer[0]) return v;
    return null;
  })();
  const broken = [...answer.slice(0, -1), nonEdge].sort((a, b) => a - b);
  for (const [label, vertices, error] of [
    ["too short", answer.slice(1), /exactly/],
    ["too long", [...answer, n - 1], /exactly/],
    ["unsorted", [...answer].reverse(), /increasing/],
    ["duplicate", [answer[0], ...answer.slice(0, -1)], /increasing/],
    ["out of range", [...answer.slice(0, -1), n], /increasing/],
    ["non-adjacent", broken, /non-adjacent|increasing/],
  ]) {
    assert.throws(() => checkCliqueSearchAnswer(seed, level, vertices, small), error, label);
  }
  assert.throws(() => checkCliqueSearchAnswer("5E".repeat(32), level, answer, small), /seed/);
  // The same vertices answer a different seed only by chance; here they do not.
  assert.throws(() => checkCliqueSearchAnswer("6f".repeat(32), level, answer, small), /non-adjacent/);
});

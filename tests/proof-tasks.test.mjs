import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkProofSolution } from "../blockchain/proof-export.mjs";
import { runKernelCheck } from "../blockchain/proof-kernel.mjs";
import {
  CLIQUE_LIBRARY_SHA3, cliqueInstance, cliqueTaskExport, cliqueTaskSource, cliqueThreshold,
} from "../blockchain/proof-tasks.mjs";
import {
  CLIQUE_FIXTURES, CLIQUE_TASK_SAMPLES, findClique,
} from "./fixtures/proof-mining/generate-clique.mjs";

const fixture = (name) => readFileSync(new URL(`fixtures/proof-mining/${name}`, import.meta.url), "utf8");
const library = readFileSync(new URL("../protocol/proof-tasks/clique-library.ndjson", import.meta.url), "utf8");
const checkerPath = process.env.NIR_PROOF_CHECKER;
const kernel = { skip: checkerPath ? false : "set NIR_PROOF_CHECKER to the nanoda_bin built by rust/proof-checker/build.sh" };

test("a seed determines the task, and different seeds give different graphs", () => {
  const seed = "ab".repeat(32);
  assert.deepEqual(cliqueInstance(seed, 40), cliqueInstance(seed, 40));
  assert.notEqual(cliqueInstance(seed, 40).graph, cliqueInstance("cd".repeat(32), 40).graph);
  const { n, graph } = cliqueInstance(seed, 40);
  for (let i = 0; i < n; i++) {
    assert.equal((graph >> BigInt(i * n + i)) & 1n, 0n, "no loops");
    for (let j = 0; j < n; j++) {
      assert.equal((graph >> BigInt(i * n + j)) & 1n, (graph >> BigInt(j * n + i)) & 1n, "undirected");
    }
  }
  assert.ok(graph < 1n << BigInt(n * n));
});

test("the clique size sits where fewer than one clique is expected", () => {
  // Independently: the least k with comb(n, k) < 2 ** (k * (k - 1) // 2) in Python.
  assert.deepEqual([6, 8, 10, 64, 128, 1_024].map(cliqueThreshold), [4, 5, 5, 9, 11, 16]);
  for (const [seed, n] of [["0".repeat(63), 40], ["ab".repeat(32), 2], ["ab".repeat(32), 1_025],
    ["AB".repeat(32), 40], ["ab".repeat(32), 4.5]]) {
    assert.throws(() => cliqueInstance(seed, n), /seed|size/);
  }
});

test("task exports match Lean's exporter byte for byte", () => {
  assert.match(CLIQUE_LIBRARY_SHA3, /^[0-9a-f]{64}$/);
  const suffixes = JSON.parse(fixture("clique-task-samples.json"));
  CLIQUE_TASK_SAMPLES.forEach((sample, i) => {
    assert.equal(cliqueTaskExport(sample), library + suffixes[i]);
  });
  assert.equal(cliqueTaskSource(CLIQUE_TASK_SAMPLES[0]),
    "def NIR.statement : Prop := NIR.Clique.HasClique 5 3 123456789\n");
});

test("a network task can be proved or refuted, and each answer binds to its task", async (t) => {
  for (const [name, { seed, n }] of Object.entries(CLIQUE_FIXTURES)) {
    const instance = cliqueInstance(seed, n);
    assert.equal(findClique(instance) === null, name === "refuted");
    const solution = fixture(`clique-${name}.ndjson`);
    assert.equal(checkProofSolution(cliqueTaskExport(instance), solution).outcome, name);
    await t.test(`kernel accepts the ${name} solution`, kernel, async () => {
      assert.equal((await runKernelCheck(solution, { checkerPath })).accepted, true);
    });
  }
  const otherTask = cliqueTaskExport(cliqueInstance(CLIQUE_FIXTURES.refuted.seed, 6));
  assert.throws(() => checkProofSolution(otherTask, fixture("clique-proved.ndjson")),
    /changes the task declaration NIR\.statement/);
});

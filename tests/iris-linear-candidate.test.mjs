import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateIrisLinearCandidate, evaluateIrisPostCommitStress,
  hashIrisModelCommit, recheckIrisPostCommitRecord } from "../blockchain/iris-linear-candidate.mjs";

const root = join(import.meta.dirname, "..");
const sample = readFileSync(join(root, "examples/iris_integer_linear.json"));

test("data-only model scores public Iris features and binds canonical bytes", () => {
  const checked = evaluateIrisLinearCandidate(root, sample);
  assert.equal(checked.status, "local-iris-data-model-evaluated");
  assert.equal(checked.baselineAccuracyBps, 9000);
  assert.equal(checked.candidateAccuracyBps, 10000);
  assert.equal(checked.caseCount, 30);
  assert.equal(checked.hiddenChallenges, false);
  assert.equal(checked.independentOperators, false);
  assert.equal(checked.networkSubmitted, false);
  assert.equal(checked.rewardEligible, false);
  assert.equal(checked.walletChanged, false);
  assert.equal(evaluateIrisLinearCandidate(root, Buffer.from(sample.toString().trimEnd())).modelHash,
    checked.modelHash);
  const altered = JSON.parse(sample);
  altered.bias[2] = -400000;
  const other = evaluateIrisLinearCandidate(root, Buffer.from(JSON.stringify(altered)));
  assert.notEqual(other.modelHash, checked.modelHash);
  assert.notEqual(other.candidateAccuracyBps, checked.candidateAccuracyBps);
});

test("model intake rejects code, ambiguous JSON, nonintegers, and excess bytes", () => {
  const parsed = JSON.parse(sample);
  for (const changed of [
    { ...parsed, command: "/bin/sh" },
    { ...parsed, path: "/Users/operator/.ssh/id_ed25519" },
    { ...parsed, weights: [[true, 0, 0, 0], ...parsed.weights.slice(1)] },
    { ...parsed, weights: [[0.5, 0, 0, 0], ...parsed.weights.slice(1)] },
    { ...parsed, bias: [1_000_001, 0, 0] },
    { ...parsed, weights: [[20_001, 0, 0, 0], ...parsed.weights.slice(1)] },
  ]) assert.throws(() => evaluateIrisLinearCandidate(root, Buffer.from(JSON.stringify(changed))));
  for (const bytes of [
    Buffer.from(` ${sample.toString().trimEnd()}`),
    Buffer.from('{"bias":[0,0,0],"format":"nir-iris-integer-linear-v1","format":"evil","weights":[]}'),
    Buffer.from("x".repeat(4097)), Buffer.from([0xff]),
  ]) assert.throws(() => evaluateIrisLinearCandidate(root, bytes));
});

test("evaluation fails closed on changed or symlinked public dataset", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-linear-iris-test-"));
  try {
    mkdirSync(join(temporary, "examples"));
    const path = join(temporary, "examples/iris.data");
    const original = readFileSync(join(root, "examples/iris.data"));
    writeFileSync(path, Buffer.concat([original, Buffer.from("extra")]));
    assert.throws(() => evaluateIrisLinearCandidate(temporary, sample));
    rmSync(path);
    symlinkSync(join(root, "examples/iris.data"), path);
    assert.throws(() => evaluateIrisLinearCandidate(temporary, sample));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("post-commit local stress binds exact bytes and is reproducible only after seed reveal", () => {
  const seed = Buffer.alloc(32, 7);
  const checked = evaluateIrisPostCommitStress(root, sample, seed);
  assert.equal(checked.status, "local-postcommit-iris-stress");
  assert.equal(checked.scope, "public-iris-synthetic-perturbations-only");
  assert.equal(checked.commitHash, hashIrisModelCommit(sample));
  assert.equal(checked.modelHash, evaluateIrisLinearCandidate(root, sample).modelHash);
  assert.equal(checked.caseCount, 90);
  assert.equal(checked.hiddenChallenges, false);
  assert.equal(checked.independentOperators, false);
  assert.equal(checked.rewardEligible, false);
  assert.deepEqual(evaluateIrisPostCommitStress(root, sample, seed), checked);
  assert.notEqual(evaluateIrisPostCommitStress(root, sample, Buffer.alloc(32, 8)).seed,
    checked.seed);
  assert.notEqual(hashIrisModelCommit(Buffer.from(sample.toString().trimEnd())), checked.commitHash);
  assert.throws(() => evaluateIrisPostCommitStress(root, sample, Buffer.alloc(31)));
  assert.throws(() => hashIrisModelCommit(Buffer.from("import os")));
});

test("local role rechecks all public synthetic cases and rejects forged claims", () => {
  const record = evaluateIrisPostCommitStress(root, sample, Buffer.alloc(32, 9));
  const same = recheckIrisPostCommitRecord(root, sample, record);
  assert.equal(same.status, "local-iris-recheck-matched");
  assert.equal(same.caseCount, 90);
  assert.equal(same.operatorIdentityVerified, false);
  assert.equal(same.rewardEligible, false);
  for (const forged of [
    { ...record, candidateAccuracyBps: record.candidateAccuracyBps + 1 },
    { ...record, rewardEligible: true },
    { ...record, independentOperators: true },
    { ...record, seed: "a".repeat(64) },
    { ...record, extra: "claim" },
  ]) assert.equal(recheckIrisPostCommitRecord(root, sample, forged).status,
    "local-iris-recheck-mismatch");
  const changedModel = JSON.parse(sample);
  changedModel.bias[2] = -400000;
  assert.equal(recheckIrisPostCommitRecord(root,
    Buffer.from(JSON.stringify(changedModel)), record).status, "local-iris-recheck-mismatch");
  assert.throws(() => recheckIrisPostCommitRecord(root, sample, { ...record, seed: "bad" }));
  assert.throws(() => recheckIrisPostCommitRecord(root, Buffer.from("import os"), record));
});

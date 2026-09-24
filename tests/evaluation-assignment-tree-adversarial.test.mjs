import assert from "node:assert/strict";
import test from "node:test";

import {
  assertActiveEvaluationAssignmentRegistry,
  createEvaluationAssignmentWitness,
  evaluationAssignmentRoot,
  evaluationAssignments,
  MAX_EVALUATION_ASSIGNMENTS,
  verifyEvaluationAssignmentProof,
} from "../blockchain/evaluation-assignment-tree.mjs";

const H = (digit) => digit.repeat(64);
const A = (digit) => `sha256:${H(digit)}`;
const ADDRESS = (digit) => `nir1${H(digit)}`;

function commitment(candidateId, seed = "a") {
  return [candidateId, {
    artifactHash: A("1"),
    baselineContentHash: A("2"),
    baselineHash: A("3"),
    challengeHeight: 12,
    challengeSeed: H(seed),
    committedHeight: 10,
    committee: [ADDRESS("4"), ADDRESS("5"), ADDRESS("6")],
    contentHash: A("7"),
    parents: [A("8")],
    recipient: ADDRESS("9"),
    suiteCommitment: H("b"),
  }];
}

test("assignment tree has a domain-separated deterministic empty root", () => {
  const first = evaluationAssignmentRoot(new Map());
  const second = evaluationAssignmentRoot([]);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, "0".repeat(64));
  assert.equal(first, second);
});

test("assignment root is insertion-order independent and witness binds exact value", () => {
  const first = commitment(H("c"), "d");
  const second = commitment(H("e"), "f");
  const left = new Map([first, second]);
  const right = new Map([second, first]);
  assert.equal(evaluationAssignmentRoot(left), evaluationAssignmentRoot(right));
  assert.deepEqual(
    evaluationAssignments(left).map(({ candidateId }) => candidateId),
    [H("c"), H("e")],
  );

  const witness = createEvaluationAssignmentWitness(left, H("c"));
  assert.equal(witness.inclusionProof.siblings.length, 256);
  assert.deepEqual(
    verifyEvaluationAssignmentProof(
      witness.assignment, witness.inclusionProof, witness.evaluationAssignmentRoot,
    ),
    witness.assignment,
  );

  const reordered = {
    ...witness.assignment,
    committee: [...witness.assignment.committee].reverse(),
  };
  assert.throws(() => verifyEvaluationAssignmentProof(
    reordered, witness.inclusionProof, witness.evaluationAssignmentRoot,
  ), /value is invalid/);
});

test("assignment witness rejects forged root, path, depth and extra fields", () => {
  const entries = new Map([commitment(H("c"))]);
  const witness = createEvaluationAssignmentWitness(entries, H("c"));
  const siblings = [...witness.inclusionProof.siblings];
  siblings[0] = H("0");
  assert.throws(() => verifyEvaluationAssignmentProof(
    witness.assignment, { ...witness.inclusionProof, siblings }, witness.evaluationAssignmentRoot,
  ), /root does not match/);
  assert.throws(() => verifyEvaluationAssignmentProof(
    witness.assignment,
    { ...witness.inclusionProof, siblings: witness.inclusionProof.siblings.slice(1) },
    witness.evaluationAssignmentRoot,
  ), /proof is invalid/);
  assert.throws(() => verifyEvaluationAssignmentProof(
    witness.assignment, { ...witness.inclusionProof, unexpected: true },
    witness.evaluationAssignmentRoot,
  ), /proof is invalid/);
  assert.throws(() => verifyEvaluationAssignmentProof(
    { ...witness.assignment, candidateId: H("d") }, witness.inclusionProof,
    witness.evaluationAssignmentRoot,
  ), /root does not match/);
});

test("unassigned commitments do not enter the assignment tree", () => {
  const pending = commitment(H("c"))[1];
  pending.challengeHeight = null;
  pending.challengeSeed = null;
  pending.committee = null;
  assert.deepEqual(evaluationAssignments(new Map([[H("c"), pending]])), []);
  assert.equal(
    evaluationAssignmentRoot(new Map([[H("c"), pending]])),
    evaluationAssignmentRoot(new Map()),
  );
  assert.throws(
    () => createEvaluationAssignmentWitness(new Map([[H("c"), pending]]), H("c")),
    /not available/,
  );
});

test("assignment tree rejects key/value mismatch and collections beyond capacity", () => {
  const entries = new Map([commitment(H("c"))]);
  const assignment = createEvaluationAssignmentWitness(entries, H("c")).assignment;
  assert.throws(
    () => evaluationAssignmentRoot([[H("d"), assignment]]),
    /key does not match/,
  );
  const oversized = Array.from(
    { length: MAX_EVALUATION_ASSIGNMENTS + 1 },
    (_, index) => [index.toString(16).padStart(64, "0"), {
      challengeSeed: null, challengeHeight: null, committee: null,
    }],
  );
  assert.throws(() => evaluationAssignments(oversized), /entries are invalid/);
});

test("historical proofs remain valid against their signed root after active-registry removal", () => {
  const entries = new Map([commitment(H("c"))]);
  const witness = createEvaluationAssignmentWitness(entries, H("c"));
  entries.delete(H("c"));
  assert.notEqual(evaluationAssignmentRoot(entries), witness.evaluationAssignmentRoot);
  assert.deepEqual(verifyEvaluationAssignmentProof(
    witness.assignment, witness.inclusionProof, witness.evaluationAssignmentRoot,
  ), witness.assignment);
});

test("active assignment registry rejects stale, missing, and altered lifecycle entries", () => {
  const active = new Map([commitment(H("c"))]);
  const assignment = createEvaluationAssignmentWitness(active, H("c")).assignment;
  const registry = new Map([[H("c"), assignment]]);
  assert.deepEqual(assertActiveEvaluationAssignmentRegistry(active, registry), [assignment]);

  active.delete(H("c"));
  assert.throws(() => assertActiveEvaluationAssignmentRegistry(active, registry),
    /registry is inconsistent/);
  assert.doesNotThrow(() => assertActiveEvaluationAssignmentRegistry(active, new Map()));

  const restoredActive = new Map([commitment(H("c"))]);
  assert.throws(() => assertActiveEvaluationAssignmentRegistry(restoredActive, new Map()),
    /registry is inconsistent/);
  assert.throws(() => assertActiveEvaluationAssignmentRegistry(restoredActive, new Map([[
    H("c"), { ...assignment, challengeSeed: H("f") },
  ]])), /registry is inconsistent/);
});

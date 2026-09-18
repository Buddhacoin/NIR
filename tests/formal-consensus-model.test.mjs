import assert from "node:assert/strict";
import test from "node:test";

import {
  checkBoundedLivenessAssumptions,
  executeModelTrace,
  runBoundedFinalityModel,
  runBoundedValidatorTransitionModel,
  runFormalConsensusSuite,
} from "../formal/consensus-model.mjs";

test("bounded consensus suite exhausts the declared state space without a safety counterexample", () => {
  const report = runFormalConsensusSuite();

  assert.equal(report.ok, true);
  assert.equal(report.counterexample, null);
  assert.ok(report.finality.exploredStates > 100_000);
  assert.ok(report.finality.transitions > 900_000);
  assert.ok(report.finality.coverage.partialPrepareStates > 0);
  assert.ok(report.finality.coverage.partialCommitStates > 0);
  assert.ok(report.finality.coverage.duplicateDeliveries > 0);
  assert.deepEqual(report.finality.invariants, {
    lockedValuePreservation: true,
    noConflictingFinalityAtHeight: true,
  });
});

test("durable prepare lock survives restart and rejects a conflicting later-round vote", () => {
  const result = executeModelTrace([
    { type: "prepare", validator: 0, value: "A" },
    { reporters: 0b0111, type: "advance-round" },
    { type: "restart", validator: 0 },
    { type: "prepare", validator: 0, value: "B" },
  ]);

  assert.equal(result.accepted, false);
  assert.equal(result.appliedTrace.length, 3);
  assert.equal(result.state.round, 1);
  assert.equal(result.state.locks[0], 0);
});

test("highest observed certificate preserves its value after a round change", () => {
  const result = executeModelTrace([
    { type: "prepare", validator: 0, value: "A" },
    { type: "prepare", validator: 1, value: "A" },
    { type: "prepare", validator: 2, value: "A" },
    { certificate: { round: 0, value: "A" }, type: "observe", validator: 0 },
    { reporters: 0b0111, type: "advance-round" },
    { type: "prepare", validator: 0, value: "B" },
  ]);

  assert.equal(result.accepted, false);
  assert.equal(result.state.round, 1);
  assert.equal(result.state.justification, 0);
});

test("unsafe unlock mutant yields a machine-readable counterexample trace", () => {
  const report = runBoundedFinalityModel({ maxDepth: 4, unsafeUnlock: true });

  assert.equal(report.ok, false);
  assert.equal(report.counterexample.invariant, "locked-value-preservation");
  assert.ok(Array.isArray(report.counterexample.trace));
  assert.ok(report.counterexample.trace.length > 0);
  assert.doesNotThrow(() => JSON.stringify(report.counterexample));
});

test("validator transition requires both sets and rejects old-only finality after activation", () => {
  const report = runBoundedValidatorTransitionModel();

  assert.equal(report.ok, true);
  assert.equal(report.assignments, 972);
  assert.equal(report.invariants.jointActivationRequiresOldAndNewQuorums, true);
  assert.equal(report.invariants.noConflictingJointActivation, true);
  assert.equal(report.invariants.noOldSetFinalityAfterActivation, true);
});

test("liveness claim is conditional and permanent quorum loss is an expected stall", () => {
  const report = checkBoundedLivenessAssumptions();

  assert.equal(report.ok, true);
  assert.equal(report.normalRoundFinalized, true);
  assert.equal(report.replacementRoundFinalized, true);
  assert.equal(report.lossyNetworkWithoutQuorum.expectedToStall, true);
  assert.ok(report.assumptions.includes("eventual synchrony after the modeled timeout"));
});

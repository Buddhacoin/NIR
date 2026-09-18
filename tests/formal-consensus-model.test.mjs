import assert from "node:assert/strict";
import test from "node:test";

import {
  executeModelTrace,
  findConflictingFinalityMutant,
  runBoundedFinalityModel,
  runBoundedValidatorTransitionModel,
  runConsensusScenarioSmokeChecks,
} from "../formal/consensus-model.mjs";

test("bounded finality model explores local rounds and independent deliveries", () => {
  const report = runBoundedFinalityModel();

  assert.equal(report.ok, true);
  assert.equal(report.counterexample, null);
  assert.ok(report.exploredStates > 100_000);
  assert.ok(report.coverage.finalizedStates > 0);
  assert.ok(report.coverage.individualCertificateDeliveries > 0);
  assert.ok(report.coverage.perValidatorRoundStates > 0);
  assert.ok(report.coverage.timeoutCertificateStates > 0);
  assert.deepEqual(report.invariants, {
    durableCommitLockPreservation: true,
    noConflictingFinalityAtHeight: true,
  });
});

test("prepare decisions are round-local and may change after a value-bound timeout quorum", () => {
  const result = executeModelTrace([
    { type: "prepare", validator: 0, value: "A" },
    { type: "timeout", validator: 0, value: "B" },
    { type: "timeout", validator: 1, value: "B" },
    { type: "timeout", validator: 2, value: "B" },
    { type: "advance", validator: 0, value: "B" },
    { type: "prepare", validator: 0, value: "B" },
  ]);

  assert.equal(result.accepted, true);
  assert.equal(result.state.rounds[0], 1);
  assert.equal(result.state.prepares[0] & 1, 1);
  assert.equal(result.state.prepares[3] & 1, 1);
  assert.equal(result.state.locks[0], -1);
});

test("validators advance independently and cannot use a timeout certificate for another value", () => {
  const independent = executeModelTrace([
    { type: "timeout", validator: 0, value: "A" },
    { type: "timeout", validator: 1, value: "A" },
    { type: "timeout", validator: 2, value: "A" },
    { type: "advance", validator: 1, value: "A" },
  ]);
  assert.equal(independent.accepted, true);
  assert.deepEqual(independent.state.rounds, [0, 1, 0, 0]);

  const wrongValue = executeModelTrace([
    { type: "timeout", validator: 0, value: "A" },
    { type: "timeout", validator: 1, value: "A" },
    { type: "timeout", validator: 2, value: "A" },
    { type: "advance", validator: 1, value: "B" },
  ]);
  assert.equal(wrongValue.accepted, false);
});

test("restart drops only volatile observations and preserves commit lock and local round", () => {
  const result = executeModelTrace([
    { type: "prepare", validator: 0, value: "A" },
    { type: "prepare", validator: 1, value: "A" },
    { type: "prepare", validator: 2, value: "A" },
    { certificate: { round: 0, value: "A" }, type: "observe", validator: 0 },
    { certificate: { round: 0, value: "A" }, type: "commit", validator: 0 },
    { type: "restart", validator: 0 },
  ]);
  assert.equal(result.accepted, true);
  assert.equal(result.state.seen[0], 0);
  assert.equal(result.state.locks[0], 0);
  assert.equal(result.state.commits[0] & 1, 1);
});

test("commit-lock mutant produces actual conflicting finality", () => {
  const counterexample = findConflictingFinalityMutant();

  assert.equal(counterexample.invariant, "no-conflicting-finality");
  assert.equal(counterexample.state.finalized, "CONFLICT");
  assert.ok(counterexample.trace.some(({ type, value }) => type === "timeout" && value === "B"));
});

test("validator transition records phases and rejects stale certificates", () => {
  const report = runBoundedValidatorTransitionModel();

  assert.equal(report.ok, true);
  assert.equal(report.assignments, 972);
  assert.equal(report.history.length, 2);
  assert.deepEqual(report.terminalState, { epoch: 1, height: 11, phase: "active-new" });
  assert.equal(report.rejectedStaleCertificates, 3);
  assert.equal(report.invariants.staleCertificatesRejectedAfterActivation, true);
});

test("normal and replacement paths are explicitly scenario smoke checks, not liveness proof", () => {
  const report = runConsensusScenarioSmokeChecks();

  assert.equal(report.ok, true);
  assert.equal(report.claim, "scenario-smoke-check-only");
  assert.equal(report.normalRoundFinalized, true);
  assert.equal(report.replacementRoundFinalized, true);
});

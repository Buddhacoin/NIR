import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { before } from "node:test";

import { canonicalJson } from "../blockchain/crypto.mjs";
import {
  runRealValidatorRecoveryRehearsal, validateRealValidatorRecoveryReport,
} from "../blockchain/testnet-drill-real-runtime.mjs";

let successful;
before(async () => { successful = await runRealValidatorRecoveryRehearsal(); });

function rehash(report) {
  const value = structuredClone(report); delete value.transcriptHash;
  return { ...value, transcriptHash: createHash("sha256").update(canonicalJson(value)).digest("hex") };
}

test("real validator outage/restart/catch-up produces authenticated recovery evidence", () => {
  assert.equal(successful.validation.scenarioStatus, "PASS");
  assert.equal(Object.hasOwn(successful.validation, "status"), false);
  assert.equal(successful.validation.authenticatedRecovery, true);
  assert.equal(successful.validation.blockHeight, 2);
  assert.equal(successful.report.blocks[1].certificate.length >= 3, true);
  assert.equal(successful.report.observations.beforeOutage.result.height, 1);
  assert.equal(successful.report.observations.afterRestart.result.height, 1);
  assert.equal(successful.report.observations.afterRecovery.result.height, 2);
  assert.equal(successful.cleanup.status, "PASS");
  assert.equal(successful.cleanup.attempted, 5);
  assert.deepEqual(validateRealValidatorRecoveryReport(successful.report), successful.validation);
});

test("the real validator rejects an exact authenticated request replay", () => {
  assert.equal(successful.report.controller.replayRejected, true);
  assert.equal(successful.report.controller.replayStatus, 400);
  const forged = structuredClone(successful.report);
  forged.controller.replayRejected = false;
  assert.throws(() => validateRealValidatorRecoveryReport(rehash(forged)), /controller evidence/);
});

test("restart proof binds a new process to the same signed validator identity and final tip", () => {
  assert.notEqual(successful.report.controller.oldProcessId,
    successful.report.controller.newProcessId);
  assert.equal(successful.report.observations.beforeOutage.result.address,
    successful.report.observations.afterRecovery.result.address);
  const forged = structuredClone(successful.report);
  forged.observations.afterRecovery.result.tipHash = "0".repeat(64);
  forged.observations.afterRecovery.response.result.tipHash = "0".repeat(64);
  assert.throws(() => validateRealValidatorRecoveryReport(rehash(forged)), /signature/);
});

test("partial real-runtime failure is bounded and returns a successful cleanup report", async () => {
  await assert.rejects(runRealValidatorRecoveryRehearsal({ _crashAfterStart: 1 }), (error) => {
    assert.match(error.message, /injected real validator crash/);
    assert.equal(error.cleanupReport.status, "PASS");
    assert.equal(error.cleanupReport.rootRemoved, true);
    assert.equal(error.cleanupReport.failures, 0);
    return true;
  });
});

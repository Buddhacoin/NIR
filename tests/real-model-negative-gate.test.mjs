import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createProgressClaim } from "../blockchain/chain.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function executePublicIrisModels() {
  return JSON.parse(execFileSync("python3", ["-m", "tests.emit_iris_negative_fixture"], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024, timeout: 15_000,
  }));
}

test("actual local model bundle remains ineligible for a signed progress reward", () => {
  const first = executePublicIrisModels();
  const second = executePublicIrisModels();
  assert.deepEqual(second, first, "the measured public-data rehearsal must reproduce");
  assert.equal(first.format, "nir-real-model-negative-gate-fixture-v1");
  assert.match(first.bundleHash, /^[0-9a-f]{64}$/);
  assert.match(first.challengeSeed, /^[0-9a-f]{64}$/);
  assert.equal(first.challengeEpoch, 11);

  const { commitment, report, chainEvaluation } = first;
  assert.equal(report.baseline_accuracy_bps, 9_000);
  assert.equal(report.candidate_accuracy_bps, 9_666);
  assert.equal(report.gain_ppm, 66_600);
  assert.equal(report.energy_attested, false);
  assert.equal(chainEvaluation.energyAttested, false);
  assert.equal(chainEvaluation.criticalSafetyPass, false);
  assert.equal(chainEvaluation.safetyBps, 0);
  assert.equal(chainEvaluation.executionBundleHash, first.bundleHash);
  assert.equal(chainEvaluation.artifactHash, commitment.artifact_hash);
  assert.equal(chainEvaluation.baselineHash, commitment.baseline_hash);
  assert.equal(chainEvaluation.candidateId, commitment.candidate_id);
  assert.equal(chainEvaluation.suiteCommitment, commitment.suite_commitment);
  assert.equal(chainEvaluation.gainPpm, report.gain_ppm);
  assert.equal(chainEvaluation.candidateEnergyWh, report.candidate_energy_wh);
  assert.equal(chainEvaluation.baselineEnergyWh, report.baseline_energy_wh);

  // Map only exact public commitments needed for the score gate. This fixture
  // has no finalized admission, assignment, trusted energy meter or evaluators.
  const evaluation = {
    ...chainEvaluation,
    baselineContentHash: commitment.baseline_content_hash,
    contentHash: commitment.content_hash,
    parents: commitment.parents,
  };
  const ephemeralRecipient = generateWallet().address;
  assert.throws(() => createProgressClaim({
    networkId: commitment.network_id,
    epoch: first.challengeEpoch,
    recipient: ephemeralRecipient,
    evaluation,
    evaluatorWallets: [],
  }), /safety is outside protocol limits/);
  assert.throws(() => createProgressClaim({
    networkId: commitment.network_id,
    epoch: first.challengeEpoch,
    recipient: ephemeralRecipient,
    evaluation: { ...evaluation, criticalSafetyPass: true, safetyBps: 10_000 },
    evaluatorWallets: [],
  }), /evaluation energy must be positive and attested/);
});

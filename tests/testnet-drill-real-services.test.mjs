import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { before } from "node:test";

import { canonicalJson } from "../blockchain/crypto.mjs";
import {
  runRealBeaconArchiveRehearsal, validateRealBeaconArchiveReport,
} from "../blockchain/testnet-drill-real-services.mjs";

const RELEASE = `sha3-256:${"e".repeat(64)}`;
let successful;
before(async () => {
  successful = await runRealBeaconArchiveRehearsal({ releaseCheckpointHash: RELEASE });
});

function rehash(report) {
  const value = structuredClone(report); delete value.transcriptHash;
  return { ...value, transcriptHash:
    createHash("sha256").update(canonicalJson(value)).digest("hex") };
}

test("real beacon quorum and independent archive recovery bind release and validator tip", () => {
  assert.equal(successful.validation.scenarioStatus, "PASS");
  assert.equal(successful.validation.beaconQuorumRecovery, true);
  assert.equal(successful.validation.archiveRecovery, true);
  assert.equal(successful.report.releaseCheckpointHash, RELEASE);
  assert.equal(successful.report.beacon.validatorTip,
    successful.report.validator.validation.tipHash);
  assert.equal(successful.report.beacon.recoveryShares.length, 3);
  assert.equal(successful.report.archive.recovery.matchingSources, 2);
  assert.equal(successful.cleanup.status, "PASS");
  assert.equal(successful.validatorCleanup.status, "PASS");
  assert.deepEqual(validateRealBeaconArchiveReport(successful.report), successful.validation);
});

test("beacon replay state and issued share survive a real process restart", () => {
  assert.equal(successful.report.beacon.replayStatus, 409);
  assert.equal(successful.report.beacon.restartReplayRejected, true);
  assert.deepEqual(successful.report.beacon.restartStableShare,
    successful.report.beacon.firstShares[2]);
  const replayed = structuredClone(successful.report);
  replayed.beacon.firstShares[1] = structuredClone(replayed.beacon.firstShares[0]);
  assert.throws(() => validateRealBeaconArchiveReport(rehash(replayed)),
    /duplicated|invalid|quorum/);
});

test("beacon and archive outage claims cannot bypass their real quorum evidence", () => {
  const beaconBypass = structuredClone(successful.report);
  beaconBypass.beacon.recoveryShares.pop();
  assert.throws(() => validateRealBeaconArchiveReport(rehash(beaconBypass)), /quorum/);

  const archiveBypass = structuredClone(successful.report);
  archiveBypass.archive.artifacts[1] = structuredClone(archiveBypass.archive.artifacts[0]);
  assert.throws(() => validateRealBeaconArchiveReport(rehash(archiveBypass)),
    /independent|operator|artifact|recovery/);
});

test("real beacon crash returns bounded fail-closed cleanup", async () => {
  await assert.rejects(runRealBeaconArchiveRehearsal({
    _crashBeaconAfterStart: 1, releaseCheckpointHash: RELEASE,
  }), (error) => {
    assert.match(error.message, /injected real beacon crash/);
    assert.equal(error.cleanupReport.status, "PASS");
    assert.equal(error.cleanupReport.rootRemoved, true);
    assert.equal(error.cleanupReport.failures, 0);
    return true;
  });
});

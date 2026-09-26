import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

import { PROTOCOL_VERSION } from "../blockchain/constants.mjs";
import { canonicalJson, generateWallet, hashObject, publicWallet } from "../blockchain/crypto.mjs";
import { createOfflineReleaseBundle } from "../blockchain/offline-release-bundle.mjs";
import {
  appendReleaseTransparencyEntry, approveReleaseLogProposal, contextForReleaseLog,
  createReleaseAuthoritySet, createReleaseProposal, createReleaseTransparencyAnchor,
  loadReleaseTransparencyLog,
} from "../blockchain/offline-release-governance.mjs";
import {
  createReleaseWitnessReceipt, createReleaseWitnessSet,
} from "../blockchain/offline-release-witness.mjs";
import { signReleaseManifest } from "../blockchain/release-manifest.mjs";
import {
  runRealBeaconArchiveRehearsal, validateRealBeaconArchiveReport,
} from "../blockchain/testnet-drill-real-services.mjs";

const NETWORK_ID = "nir-real-recovery-devnet";
let successful;
const protectedRestarts = new Set();

async function assertRestartPortProtected(kind, port) {
  const competitor = createServer();
  await new Promise((resolve, reject) => {
    competitor.once("error", (error) => error.code === "EADDRINUSE" ? resolve() : reject(error));
    competitor.listen(port, "127.0.0.1", () => {
      competitor.close(); reject(new Error(`${kind} restart port became stealable`));
    });
  });
  protectedRestarts.add(kind);
}

before(async () => {
  successful = await runRealBeaconArchiveRehearsal({
    async _afterArchiveRestartPortRelease({ port }) {
      await assertRestartPortProtected("archive", port);
    },
    async _afterBeaconRestartPortRelease({ port }) {
      await assertRestartPortProtected("beacon", port);
    },
    releaseEvidence: releaseFixture(),
  });
});

function releaseFixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-real-release-"));
  try {
    const signer = generateWallet(); const releaseVersion = "0.9.0";
    const sourceRevision = "a".repeat(64);
    const sourcePayload = { files: [{ executable: false, path: "package.json",
      sha3_256: createHash("sha256").update("package").digest("hex"), size: 7 }],
    format: "nir-source-release-v1", releaseVersion, sourceRevision };
    const sourceManifest = { ...sourcePayload,
      manifestHash: hashObject(sourcePayload, "RELEASE_MANIFEST_HASH") };
    const signedRelease = signReleaseManifest(sourceManifest, signer);
    const source = join(root, "source"); mkdirSync(source, { mode: 0o700 });
    writeFileSync(join(source, "payload.txt"), "public release\n", { mode: 0o644 });
    const bundle = createOfflineReleaseBundle(source, ["payload.txt"], { networkId: NETWORK_ID,
      previousBundleHash: null, protocolVersion: PROTOCOL_VERSION, releaseVersion, sourceRevision });
    const authorities = Array.from({ length: 3 }, generateWallet);
    const authoritySet = createReleaseAuthoritySet({ authorities: authorities.map((wallet, index) =>
      ({ ...publicWallet(wallet), operatorId: `release-${index}` })), generation: 1,
    rotationDelayEntries: 2, threshold: 2 });
    const anchor = createReleaseTransparencyAnchor({ initialSet: authoritySet,
      logId: "real-rehearsal-release", networkId: NETWORK_ID });
    const log = join(root, "log"); const checkpoints = join(root, "checkpoints");
    mkdirSync(log, { mode: 0o700 }); mkdirSync(checkpoints, { mode: 0o700 });
    const state = loadReleaseTransparencyLog(anchor, log, checkpoints);
    const proposal = createReleaseProposal({ anchor, bundle, state });
    const context = contextForReleaseLog(anchor, state);
    const approvals = authorities.slice(0, 2).map((wallet, index) =>
      approveReleaseLogProposal(proposal, context, { operatorId: `release-${index}`, wallet }));
    const checkpoint = appendReleaseTransparencyEntry({ anchor, approvals,
      checkpointDirectory: checkpoints, logDirectory: log, proposal }).checkpoint;
    const witnesses = Array.from({ length: 4 }, generateWallet);
    const witnessSet = createReleaseWitnessSet({ threshold: 3,
      witnesses: witnesses.map((wallet, index) => ({ ...publicWallet(wallet),
        operatorId: `witness-${index}` })) });
    const observedAt = Date.now();
    const witnessReceipts = witnesses.slice(0, 3).map((wallet, index) =>
      createReleaseWitnessReceipt({ anchor, checkpoint, observedAt,
        operatorId: `witness-${index}`, wallet, witnessSet }));
    return { anchor, bundle, checkpoint, maxAgeMs: 60_000, maxFutureSkewMs: 1_000,
      signedRelease, trustedAddress: signer.address, witnessReceipts, witnessSet };
  } finally { rmSync(root, { force: true, recursive: true }); }
}

function rehash(report) {
  const value = structuredClone(report); delete value.transcriptHash;
  return { ...value, transcriptHash:
    createHash("sha256").update(canonicalJson(value)).digest("hex") };
}

test("real beacon quorum and independent archive recovery bind release and validator tip", () => {
  assert.equal(successful.validation.scenarioStatus, "PASS");
  assert.equal(successful.validation.beaconQuorumRecovery, true);
  assert.equal(successful.validation.archiveRecovery, true);
  assert.equal(successful.validation.releaseCheckpointHash,
    successful.report.releaseEvidence.checkpoint.checkpointHash);
  assert.equal(successful.report.beacon.validatorTip,
    successful.report.validator.validation.tipHash);
  assert.equal(successful.report.beacon.recoveryShares.length, 3);
  assert.equal(successful.report.beacon.firstShares.length, 4);
  assert.deepEqual(successful.report.beacon.authorities,
    [...successful.report.validator.report.genesis.beaconAuthorities]
      .sort((left, right) => left.address < right.address ? -1 : left.address > right.address ? 1 : 0));
  assert.equal(successful.report.archive.recovery.matchingSources, 2);
  assert.equal(successful.cleanup.status, "PASS");
  assert.equal(successful.validatorCleanup.status, "PASS");
  assert.deepEqual([...protectedRestarts].sort(), ["archive", "beacon"]);
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

test("on-chain authority registry, validator tip, and run binding fail closed", () => {
  const registry = structuredClone(successful.report);
  registry.beacon.authorities[0].operatorId = "substituted-beacon";
  assert.throws(() => validateRealBeaconArchiveReport(rehash(registry)), /active on-chain registry/);
  const generation = structuredClone(successful.report);
  generation.beacon.generation += 1;
  assert.throws(() => validateRealBeaconArchiveReport(rehash(generation)),
    /active on-chain registry/);
  const setId = structuredClone(successful.report);
  setId.beacon.setId = "0".repeat(64);
  assert.throws(() => validateRealBeaconArchiveReport(rehash(setId)),
    /active on-chain registry/);
  const tip = structuredClone(successful.report);
  tip.beacon.validatorTip = "f".repeat(64);
  assert.throws(() => validateRealBeaconArchiveReport(rehash(tip)), /validator|release checkpoint/);
  const mixed = structuredClone(successful.report);
  mixed.releaseEvidence = releaseFixture();
  assert.throws(() => validateRealBeaconArchiveReport(rehash(mixed)), /release|candidate|transcript/);
});

test("release signer, witness quorum, and exact release binding fail closed", () => {
  const signer = structuredClone(successful.report);
  signer.releaseEvidence.trustedAddress = generateWallet().address;
  assert.throws(() => validateRealBeaconArchiveReport(rehash(signer)), /signature is not trusted/);
  const quorum = structuredClone(successful.report);
  quorum.releaseEvidence.witnessReceipts.pop();
  assert.throws(() => validateRealBeaconArchiveReport(rehash(quorum)), /quorum/);
  const latestObservation = Math.max(...successful.report.releaseEvidence.witnessReceipts
    .map(({ observedAt }) => observedAt));
  assert.throws(() => validateRealBeaconArchiveReport(successful.report, {
    now: latestObservation + successful.report.releaseEvidence.maxAgeMs + 1,
  }), /stale/);
  const release = structuredClone(successful.report);
  release.beacon.releaseManifestHash = "0".repeat(64);
  assert.throws(() => validateRealBeaconArchiveReport(rehash(release)), /release checkpoint/);
});

test("services CLI rejects symlinked release evidence before launching runtimes", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-real-cli-"));
  try {
    const target = join(root, "evidence.json"); const link = join(root, "evidence-link.json");
    writeFileSync(target, "{}\n", { mode: 0o600 }); symlinkSync(target, link);
    const result = spawnSync(process.execPath,
      ["blockchain/testnet-drill-real-runtime-cli.mjs", "services", link], {
        cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 2_000,
      });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERR_REHEARSAL/);
    assert.equal(result.stdout, "");
  } finally { rmSync(root, { force: true, recursive: true }); }
});

test("real beacon crash returns bounded fail-closed cleanup", async () => {
  await assert.rejects(runRealBeaconArchiveRehearsal({
    _crashBeaconAfterStart: 1, releaseEvidence: releaseFixture(),
  }), (error) => {
    assert.match(error.message, /injected real beacon crash/);
    assert.equal(error.cleanupReport.status, "PASS");
    assert.equal(error.cleanupReport.rootRemoved, true);
    assert.equal(error.cleanupReport.failures, 0);
    return true;
  });
});

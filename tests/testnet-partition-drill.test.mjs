import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet, hashObject, publicWallet } from "../blockchain/crypto.mjs";
import {
  createTestnetPartitionDrillEvidence, createTestnetPartitionDrillPlan,
  runTestnetPartitionDrillCommand, validateTestnetPartitionDrillEvidence,
  validateTestnetPartitionDrillPlan, signTestnetDrillObservation,
  signTestnetDrillQuorumHash,
} from "../blockchain/testnet-partition-drill.mjs";

const NOW = 2_100_000_000_000;
const CHECKPOINT = `sha3-256:${"c".repeat(64)}`;
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }

function preflight() {
  const checks = [
    { details: { ageMs: 100, sources: 2 }, id: "backup-restore-freshness", status: "PASS" },
    { details: { eligible: 4, minimumBondAtomic: "1000000000" },
      id: "bonded-validator-eligibility", status: "PASS" },
    { details: { selectionHash: digest("selection"), witnesses: 3 },
      id: "external-witness-quorum", status: "PASS" },
    { details: { genesisHash: digest("genesis"), planCommitment: digest("plan") },
      id: "genesis", status: "PASS" },
    { details: { ingressProfiles: 4, ports: 14 }, id: "host-readiness", status: "PASS" },
    { details: { scannedFiles: 1 }, id: "public-artifact-scan", status: "PASS" },
    { details: { bundleHash: `sha3-256:${"b".repeat(64)}`, checkpointHash: CHECKPOINT,
      sequence: 1 }, id: "release", status: "PASS" },
    { details: { identities: 18, operators: 14, tlsPins: 4 },
      id: "role-and-key-separation", status: "PASS" },
  ];
  const payload = { checks, format: "nir-developer-testnet-preflight-report-v1",
    networkId: "nir-adversarial-drill-devnet", observedAt: NOW,
    summary: { failed: 0, passed: 8, status: "PASS" }, version: 1 };
  return { ...payload, reportHash: hashObject(payload, "DEVELOPER_TESTNET_PREFLIGHT_REPORT_V1") };
}

let walletsByAddress = new Map();
function identities(count, prefix) {
  return Array.from({ length: count }, (_, index) => {
    const wallet = generateWallet(); walletsByAddress.set(wallet.address, wallet);
    return { ...publicWallet(wallet), operatorId: `${prefix}-${index}` };
  });
}

function topology() {
  walletsByAddress = new Map();
  const validators = identities(4, "validator");
  return {
    archives: identities(2, "archive"), beacons: identities(4, "beacon"),
    certificateRotation: { newPin: digest("new-pin"), oldPin: digest("old-pin"),
      overlapEndHeight: 110, overlapStartHeight: 100, validator: validators[0].address },
    format: "nir-testnet-drill-topology-v1", networkId: "nir-adversarial-drill-devnet",
    releaseCheckpointHash: CHECKPOINT, validators, version: 1,
  };
}

function completeEvidence(plan, { completedAt = NOW, result = "PASS" } = {}) {
  const startedAt = completedAt - 10_000;
  return createTestnetPartitionDrillEvidence({ completedAt, networkId: plan.networkId,
    planHash: plan.planHash, releaseCheckpointHash: plan.releaseCheckpointHash,
    scenarios: plan.scenarios.map((scenario, index) => ({
      id: scenario.id,
      observations: scenario.requiredObservations.map((observation) => {
        const identity = [...plan.topology.validators, ...plan.topology.beacons,
          ...plan.topology.archives].find(({ operatorId }) => operatorId === observation.operatorId);
        return signTestnetDrillObservation(plan, scenario.id, {
          evidenceHash: digest(`${scenario.id}:${observation.id}`), id: observation.id,
          observedAt: startedAt + index + 1, result,
        }, walletsByAddress.get(identity.address));
      }),
      outcome: result,
      quorumHashes: scenario.requiredQuorumHashes === 0 ? [] : [signTestnetDrillQuorumHash(
        plan, scenario.id, {
        blockHash: digest(`block:${scenario.id}`), height: 100 + index,
        stateRoot: digest(`state:${scenario.id}`), validatorSetHash: digest("validator-set"),
      }, scenario.quorumEligible.slice(0, 3).map((address) => walletsByAddress.get(address)))],
    })), startedAt,
  });
}

function rehash(evidence) {
  const { evidenceHash: _ignored, format: _format, version: _version, ...fields } = evidence;
  return createTestnetPartitionDrillEvidence(fields);
}

test("planner deterministically covers every required adversarial scenario", () => {
  const report = preflight(); const source = topology();
  const first = createTestnetPartitionDrillPlan(report, source);
  const reordered = structuredClone(source);
  reordered.validators.reverse(); reordered.beacons.reverse(); reordered.archives.reverse();
  const second = createTestnetPartitionDrillPlan(report, reordered);
  assert.deepEqual(second, first);
  assert.deepEqual(first.scenarios.map(({ type }) => type), [
    "validator-outage", "two-two-partition", "three-one-partition", "message-adversary",
    "beacon-outage", "archive-corruption", "certificate-rotation-overlap",
  ]);
  assert.equal(first.scenarios[1].requiredQuorumHashes, 0);
  assert.equal(first.scenarios[2].requiredQuorumHashes, 1);
  assert.deepEqual(validateTestnetPartitionDrillPlan(first), first);
});

test("complete fresh observations and quorum hashes validate to signed-free PASS", () => {
  const plan = createTestnetPartitionDrillPlan(preflight(), topology());
  const evidence = completeEvidence(plan);
  const result = validateTestnetPartitionDrillEvidence(plan, evidence, { now: NOW });
  assert.equal(result.status, "PASS");
  assert.equal(result.results.length, 7);
  assert.equal(JSON.stringify(result).includes("signature"), false);
});

test("false PASS cannot omit observations, quorum hashes, or claim finality in a 2/2 split", () => {
  const plan = createTestnetPartitionDrillPlan(preflight(), topology());
  const missingObservation = structuredClone(completeEvidence(plan));
  missingObservation.scenarios[0].observations.pop();
  assert.throws(() => validateTestnetPartitionDrillEvidence(plan, rehash(missingObservation),
    { now: NOW }), /incomplete/);

  const missingQuorum = structuredClone(completeEvidence(plan));
  missingQuorum.scenarios[0].quorumHashes = [];
  assert.throws(() => validateTestnetPartitionDrillEvidence(plan, rehash(missingQuorum),
    { now: NOW }), /quorum/);

  const falseSplitFinality = structuredClone(completeEvidence(plan));
  falseSplitFinality.scenarios[1].quorumHashes =
    [structuredClone(falseSplitFinality.scenarios[0].quorumHashes[0])];
  assert.throws(() => validateTestnetPartitionDrillEvidence(plan, rehash(falseSplitFinality),
    { now: NOW }), /quorum|forbidden finality/);
});

test("mixed network/release, duplicated operators, and stale evidence fail closed", () => {
  const report = preflight(); const source = topology();
  const plan = createTestnetPartitionDrillPlan(report, source);
  const mixed = structuredClone(completeEvidence(plan)); mixed.networkId = "nir-other-devnet";
  assert.throws(() => validateTestnetPartitionDrillEvidence(plan, rehash(mixed), { now: NOW }),
    /another plan/);
  const wrongRelease = structuredClone(completeEvidence(plan));
  wrongRelease.releaseCheckpointHash = `sha3-256:${"d".repeat(64)}`;
  assert.throws(() => validateTestnetPartitionDrillEvidence(plan, rehash(wrongRelease),
    { now: NOW }), /another plan/);
  const duplicate = structuredClone(source);
  duplicate.archives[0].operatorId = duplicate.validators[0].operatorId;
  assert.throws(() => createTestnetPartitionDrillPlan(report, duplicate), /reuses/);
  const stale = completeEvidence(plan, { completedAt: NOW - 86_400_001 });
  assert.throws(() => validateTestnetPartitionDrillEvidence(plan, stale,
    { maxAgeMs: 86_400_000, now: NOW }), /stale/);
});

test("model mutations cannot preserve PASS by replaying operators or foreign quorum signers", () => {
  const plan = createTestnetPartitionDrillPlan(preflight(), topology());
  for (let index = 0; index < 32; index += 1) {
    const mutated = structuredClone(completeEvidence(plan));
    const scenario = mutated.scenarios[index % mutated.scenarios.length];
    if (index % 2 === 0) {
      scenario.observations[0].operatorId = "replayed-wrong-operator";
    } else if (scenario.quorumHashes.length > 0) {
      scenario.quorumHashes[0].signatures[0].validator = generateWallet().address;
    } else {
      scenario.observations[0].id = "unknown-observation";
    }
    assert.throws(() => validateTestnetPartitionDrillEvidence(plan, rehash(mutated), { now: NOW }));
  }
});

test("forged, duplicate, cross-scenario, and cross-plan signatures are rejected", () => {
  const source = topology(); const report = preflight();
  const plan = createTestnetPartitionDrillPlan(report, source);

  const forged = structuredClone(completeEvidence(plan));
  const signature = forged.scenarios[0].observations[0].signature;
  forged.scenarios[0].observations[0].signature =
    `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  assert.throws(() => validateTestnetPartitionDrillEvidence(plan, rehash(forged), { now: NOW }),
    /observation/);

  const duplicated = structuredClone(completeEvidence(plan));
  duplicated.scenarios[0].quorumHashes[0].signatures[1] =
    structuredClone(duplicated.scenarios[0].quorumHashes[0].signatures[0]);
  assert.throws(() => validateTestnetPartitionDrillEvidence(plan, rehash(duplicated), { now: NOW }),
    /duplicate/);

  const crossScenario = structuredClone(completeEvidence(plan));
  const rotation = crossScenario.scenarios.find(({ id }) => id === "07-certificate-overlap");
  [rotation.observations[0].signature, rotation.observations[1].signature] =
    [rotation.observations[1].signature, rotation.observations[0].signature];
  assert.throws(() => validateTestnetPartitionDrillEvidence(plan, rehash(crossScenario),
    { now: NOW }), /observation/);

  const otherPayload = { ...report, observedAt: report.observedAt + 1 };
  delete otherPayload.reportHash;
  const otherReport = { ...otherPayload,
    reportHash: hashObject(otherPayload, "DEVELOPER_TESTNET_PREFLIGHT_REPORT_V1") };
  const otherPlan = createTestnetPartitionDrillPlan(otherReport, source);
  const crossPlan = structuredClone(completeEvidence(plan));
  crossPlan.planHash = otherPlan.planHash;
  assert.throws(() => validateTestnetPartitionDrillEvidence(otherPlan, rehash(crossPlan),
    { now: NOW }), /observation|signature/);
});

test("bounded CLI roots reject symlinks, unexpected files, and post-open root swaps", () => {
  const report = preflight(); const source = topology();
  const root = mkdtempSync(join(tmpdir(), "nir-drill-plan-"));
  try {
    writeJson(join(root, "preflight-report.json"), report);
    writeJson(join(root, "topology.json"), source);
    assert.equal(runTestnetPartitionDrillCommand(root, "plan").scenarios.length, 7);
    writeJson(join(root, "unexpected.json"), {});
    assert.throws(() => runTestnetPartitionDrillCommand(root, "plan"), /unexpected/);
    rmSync(join(root, "unexpected.json"));
    rmSync(join(root, "topology.json")); symlinkSync("preflight-report.json", join(root, "topology.json"));
    assert.throws(() => runTestnetPartitionDrillCommand(root, "plan"), /unsafe|ELOOP/);
  } finally { rmSync(root, { recursive: true, force: true }); }

  const swapped = mkdtempSync(join(tmpdir(), "nir-drill-swap-")); const moved = `${swapped}-moved`;
  try {
    writeJson(join(swapped, "preflight-report.json"), report);
    writeJson(join(swapped, "topology.json"), source);
    let changed = false;
    assert.throws(() => runTestnetPartitionDrillCommand(swapped, "plan", {
      _afterFileOpen: ({ name }) => {
        if (!changed && name === "preflight-report.json") {
          changed = true; renameSync(swapped, moved); mkdirSync(swapped, { mode: 0o700 });
          writeJson(join(swapped, "preflight-report.json"), report);
          writeJson(join(swapped, "topology.json"), source);
        }
      },
    }), /root changed/);
  } finally {
    rmSync(swapped, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});

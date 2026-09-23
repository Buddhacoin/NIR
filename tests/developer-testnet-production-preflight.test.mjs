import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, generateWallet, hashObject, publicWallet } from "../blockchain/crypto.mjs";
import {
  evaluateDeveloperTestnetProductionPreflight,
  validateDeveloperTestnetProductionPreflightReport,
} from "../blockchain/developer-testnet-production-preflight.mjs";
import {
  acceptRehearsalAttestationQuorum,
  createRehearsalAttestorSet, exportRehearsalAttestationStoreTranscript, signRehearsalStatement,
} from "../blockchain/rehearsal-attestation.mjs";
import { createTestnetPartitionDrillPlan } from "../blockchain/testnet-partition-drill.mjs";

const NOW = 10_000;
const NETWORK = "nir-production-preflight-devnet";
const CHECKPOINT = `sha3-256:${"7".repeat(64)}`;
const GENESIS = "8".repeat(64);
const MANIFEST = "9".repeat(64);
const TIP = "a".repeat(64);

function developerReport() {
  const checks = [
    { details: { ageMs: 0, sources: 2 }, id: "backup-restore-freshness", status: "PASS" },
    { details: { eligible: 4, minimumBondAtomic: "1000000000" },
      id: "bonded-validator-eligibility", status: "PASS" },
    { details: { selectionHash: "1".repeat(64), witnesses: 3 },
      id: "external-witness-quorum", status: "PASS" },
    { details: { genesisHash: GENESIS, planCommitment: "2".repeat(64) }, id: "genesis", status: "PASS" },
    { details: { ingressProfiles: 4, ports: 14 }, id: "host-readiness", status: "PASS" },
    { details: { scannedFiles: 1 }, id: "public-artifact-scan", status: "PASS" },
    { details: { bundleHash: `sha3-256:${"3".repeat(64)}`, checkpointHash: CHECKPOINT, sequence: 1 },
      id: "release", status: "PASS" },
    { details: { identities: 14, operators: 14, tlsPins: 4 },
      id: "role-and-key-separation", status: "PASS" },
  ];
  const payload = { checks, format: "nir-developer-testnet-preflight-report-v1", networkId: NETWORK,
    observedAt: NOW, summary: { failed: 0, passed: 8, status: "PASS" }, version: 1 };
  return { ...payload, reportHash: hashObject(payload, "DEVELOPER_TESTNET_PREFLIGHT_REPORT_V1") };
}

function identity(wallet, operatorId) { return { ...publicWallet(wallet), operatorId }; }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-production-preflight-"));
  const report = developerReport();
  const validators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const archives = Array.from({ length: 2 }, generateWallet);
  const topology = { archives: archives.map((wallet, index) => identity(wallet, `archive-${index}`)),
    beacons: beacons.map((wallet, index) => identity(wallet, `beacon-${index}`)),
    certificateRotation: { newPin: "4".repeat(64), oldPin: "5".repeat(64),
      overlapEndHeight: 20, overlapStartHeight: 10, validator: validators[0].address },
    format: "nir-testnet-drill-topology-v1", networkId: NETWORK,
    releaseCheckpointHash: CHECKPOINT,
    validators: validators.map((wallet, index) => identity(wallet, `validator-${index}`)), version: 1 };
  const plan = createTestnetPartitionDrillPlan(report, topology);
  const attestors = Array.from({ length: 4 }, generateWallet);
  const operatorSet = createRehearsalAttestorSet({ threshold: 3,
    operators: attestors.map((wallet, index) => identity(wallet, `reviewer-${index}`)) });
  const statement = { drillPlanHash: plan.planHash, expiresAt: NOW + 1_000,
    format: "nir-rehearsal-attestation-v1", genesisHash: GENESIS, networkId: NETWORK,
    observedAt: NOW - 100, releaseCheckpointHash: CHECKPOINT, releaseManifestHash: MANIFEST,
    reportHash: `sha3-256:${"6".repeat(64)}`, runNonce: "b".repeat(64), setId: operatorSet.setId,
    validatorTip: TIP, version: 1 };
  const attestations = attestors.slice(0, 3).map((wallet, index) =>
    signRehearsalStatement(statement, { operatorId: `reviewer-${index}`, wallet }, operatorSet));
  const store = join(root, "store");
  const accepted = acceptRehearsalAttestationQuorum(store, attestations, { now: NOW, operatorSet });
  const context = { finalizedTip: TIP, genesisHash: GENESIS, releaseManifestHash: MANIFEST };
  return { accepted, attestations, attestors, context, operatorSet, plan, report, root, statement, store };
}

function evaluate(values, changes = {}) {
  return evaluateDeveloperTestnetProductionPreflight({
    attestationInput: values.accepted.preflightInput,
    attestationStoreTranscript: exportRehearsalAttestationStoreTranscript(values.store),
    developerReport: values.report, drillPlan: values.plan, expectedContext: values.context,
    now: NOW, operatorSet: values.operatorSet, ...changes,
  });
}

function check(report, id) { return report.checks.find((entry) => entry.id === id); }

test("external M-of-N evidence upgrades only the exact developer context", () => {
  const values = fixture();
  try {
    const result = evaluate(values);
    assert.equal(result.summary.status, "PASS");
    assert.equal(result.readiness, "EXTERNAL-EVIDENCE-PASS");
    assert.equal(check(result, "external-operator-attestation").details.operators, 3);
    assert.deepEqual(validateDeveloperTestnetProductionPreflightReport(result), result);
    assert.equal(canonicalJson(result).includes(values.root), false);
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("missing, stale, mixed-plan/release/tip evidence becomes explicit non-leaking FAIL", () => {
  const values = fixture();
  try {
    const missing = evaluate(values, { attestationInput: undefined });
    assert.equal(missing.summary.status, "FAIL");
    assert.equal(check(missing, "external-operator-attestation").status, "FAIL");
    assert.deepEqual(validateDeveloperTestnetProductionPreflightReport(missing), missing);
    const stale = evaluate(values, { now: NOW + 1_001 });
    assert.equal(check(stale, "external-operator-attestation").status, "FAIL");
    const mixed = evaluate(values, { expectedContext: { ...values.context, finalizedTip: "c".repeat(64) } });
    assert.equal(check(mixed, "production-context-binding").status, "FAIL");
    assert.equal(canonicalJson(mixed).includes(values.root), false);
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("durable head rollback and a newer accepted run invalidate an older package", () => {
  const values = fixture();
  try {
    const secondStatement = { ...values.statement, observedAt: NOW, expiresAt: NOW + 2_000,
      runNonce: "d".repeat(64) };
    const secondAttestations = values.attestors.slice(0, 3).map((wallet, index) =>
      signRehearsalStatement(secondStatement,
        { operatorId: `reviewer-${index}`, wallet }, values.operatorSet));
    acceptRehearsalAttestationQuorum(values.store, secondAttestations,
      { now: NOW + 1, operatorSet: values.operatorSet });
    const old = evaluate(values, { now: NOW + 1 });
    assert.equal(check(old, "durable-attestation-head").status, "FAIL");
    assert.equal(old.summary.status, "FAIL");
    const forgedInput = structuredClone(values.accepted.preflightInput);
    forgedInput.package.attestations.push(structuredClone(forgedInput.package.attestations[0]));
    const equivocation = evaluate(values, { attestationInput: forgedInput, now: NOW + 1 });
    assert.equal(check(equivocation, "external-operator-attestation").status, "FAIL");

    const transcript = exportRehearsalAttestationStoreTranscript(values.store);
    const fabricated = structuredClone(transcript);
    fabricated.records.at(-1).recordHash = "e".repeat(64);
    fabricated.head.headHash = "e".repeat(64);
    const fabricatedReport = evaluate(values,
      { attestationStoreTranscript: fabricated, now: NOW + 1 });
    assert.equal(check(fabricatedReport, "durable-attestation-head").status, "FAIL");
    for (const mutate of [
      (value) => value.records.pop(),
      (value) => value.records.reverse(),
      (value) => { value.records[0].record.previousRecordHash = "f".repeat(64); },
    ]) {
      const mutant = structuredClone(transcript); mutate(mutant);
      assert.equal(check(evaluate(values,
        { attestationStoreTranscript: mutant, now: NOW + 1 }),
      "durable-attestation-head").status, "FAIL");
    }
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

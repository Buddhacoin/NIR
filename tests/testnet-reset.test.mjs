import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SAFETY_POLICY_V1_COMMITMENT } from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  createResetDrill,
  createResetManifest,
  genesisIdentity,
  incidentReportHash,
  signResetManifest,
  verifyResetManifest,
} from "../blockchain/testnet-reset.mjs";

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
  }));
}

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const base = {
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [{
      artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64),
      capabilitiesBps: { "reasoning-v1": 1 },
    }],
    evaluators: members(evaluators, "evaluator"),
    genesisTimestamp: 0,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: members(validators, "validator"),
  };
  const oldGenesis = { ...base, networkId: "nir-reset-old" };
  const newGenesis = { ...base, networkId: "nir-reset-new" };
  const report = Buffer.from("Incident IR-2026-09: testnet reset rehearsal.\n");
  const oldIdentity = genesisIdentity(oldGenesis);
  const newIdentity = genesisIdentity(newGenesis);
  const plan = createResetManifest({
    incidentReportHash: incidentReportHash(report),
    newGenesisHash: newIdentity.genesisHash,
    newNetworkId: newIdentity.networkId,
    notBefore: 1_000,
    oldGenesisHash: oldIdentity.genesisHash,
    oldNetworkId: oldIdentity.networkId,
    reason: "Rehearse an explicit valueless testnet incident reset.",
  });
  return { newGenesis, oldGenesis, plan, report, validators };
}

function approve(plan, validators, trustedValidators, count) {
  let result = plan;
  for (const wallet of validators.slice(0, count)) {
    result = signResetManifest(result, wallet, {
      validators: trustedValidators,
    });
  }
  return result;
}

function signedFixture(count = 3) {
  const values = fixture();
  return {
    ...values,
    signed: approve(values.plan, values.validators, values.oldGenesis.validators, count),
  };
}

test("reset manifests require exact fields, distinct identities, and a validator quorum", () => {
  const values = signedFixture();
  const options = {
    currentTimestamp: 1_000,
    expectedIncidentReportHash: incidentReportHash(values.report),
    newGenesis: values.newGenesis,
    oldGenesis: values.oldGenesis,
    validators: values.oldGenesis.validators,
  };
  const verified = verifyResetManifest(values.signed, options);
  assert.equal(verified.approvals.length, 3);
  assert.equal(verified.quorum, 3);

  const insufficient = signedFixture(2);
  assert.throws(() => verifyResetManifest(insufficient.signed, {
    ...options,
    newGenesis: insufficient.newGenesis,
    oldGenesis: insufficient.oldGenesis,
    validators: insufficient.oldGenesis.validators,
    expectedIncidentReportHash: incidentReportHash(insufficient.report),
  }), /quorum/);
  assert.throws(() => verifyResetManifest({ ...values.signed, unexpected: true }, options),
    /shape/);
  const duplicated = structuredClone(values.signed);
  duplicated.approvals = [duplicated.approvals[0], duplicated.approvals[0]];
  assert.throws(() => verifyResetManifest(duplicated, options), /duplicated|unordered/);
  const forged = structuredClone(values.signed);
  forged.approvals[0].signature = "AAAA";
  assert.throws(() => verifyResetManifest(forged, options), /forged/);
  assert.throws(() => signResetManifest(values.signed, values.validators[0], {
    validators: values.oldGenesis.validators,
  }), /unused trusted validator/);
  const approvalWithUnknownField = structuredClone(values.signed);
  approvalWithUnknownField.approvals[0].unexpected = true;
  assert.throws(() => verifyResetManifest(approvalWithUnknownField, options), /shape/);
  assert.throws(() => verifyResetManifest(values.signed, {
    ...options, currentTimestamp: 999,
  }), /not yet eligible/);
  assert.throws(() => verifyResetManifest(values.signed, {
    ...options, expectedIncidentReportHash: "f".repeat(64),
  }), /reviewed inputs/);

  const identity = genesisIdentity(values.oldGenesis);
  assert.throws(() => createResetManifest({
    incidentReportHash: incidentReportHash(values.report),
    newGenesisHash: "f".repeat(64),
    newNetworkId: identity.networkId,
    notBefore: 1_000,
    oldGenesisHash: identity.genesisHash,
    oldNetworkId: identity.networkId,
    reason: "This request improperly reuses the network identity.",
  }), /new network ID/);
  assert.throws(() => createResetManifest({
    incidentReportHash: incidentReportHash(values.report),
    newGenesisHash: identity.genesisHash,
    newNetworkId: "nir-other-network",
    notBefore: 1_000,
    oldGenesisHash: identity.genesisHash,
    oldNetworkId: identity.networkId,
    reason: "This request improperly reuses the genesis identity.",
  }), /new genesis hash/);
});

test("reset drill proves transaction-domain separation and exposes no destructive action", () => {
  const values = signedFixture();
  const report = createResetDrill(values.signed, {
    currentTimestamp: 1_000,
    expectedIncidentReportHash: incidentReportHash(values.report),
    newGenesis: values.newGenesis,
    oldGenesis: values.oldGenesis,
    validators: values.oldGenesis.validators,
  });
  assert.equal(report.oldDomainAcceptsSignature, true);
  assert.equal(report.newDomainRejectsOldSignature, true);
  assert.equal(report.liveDataTouched, false);
  assert.equal(report.destructiveExecutionAvailable, false);
  assert.match(report.destructiveExecutionPolicy, /outside this tool/);
});

test("reset CLI plans, verifies, and drills only into a new isolated directory", () => {
  const values = signedFixture();
  const root = mkdtempSync(join(tmpdir(), "nir-reset-test-"));
  const cli = new URL("../blockchain/testnet-reset-cli.mjs", import.meta.url).pathname;
  const oldPath = join(root, "old-genesis.json");
  const newPath = join(root, "new-genesis.json");
  const incidentPath = join(root, "incident.md");
  const requestPath = join(root, "request.json");
  const manifestPath = join(root, "reset.json");
  const drillPath = join(root, "isolated-drill");
  try {
    writeFileSync(oldPath, `${JSON.stringify(values.oldGenesis, null, 2)}\n`);
    writeFileSync(newPath, `${JSON.stringify(values.newGenesis, null, 2)}\n`);
    writeFileSync(incidentPath, values.report);
    writeFileSync(requestPath, `${JSON.stringify({
      notBefore: 1_000,
      reason: "Rehearse an explicit valueless testnet incident reset.",
    })}\n`);
    const oldBefore = readFileSync(oldPath);
    const planned = spawnSync(process.execPath, [
      cli, "plan", oldPath, newPath, incidentPath, requestPath,
    ], { encoding: "utf8" });
    assert.equal(planned.status, 0, planned.stderr);
    assert.deepEqual(JSON.parse(planned.stdout), values.plan);
    writeFileSync(manifestPath, `${JSON.stringify(values.signed)}\n`);

    const verified = spawnSync(process.execPath, [
      cli, "verify", oldPath, newPath, incidentPath, manifestPath,
    ], { encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).verified, true);
    const drilled = spawnSync(process.execPath, [
      cli, "drill", oldPath, newPath, incidentPath, manifestPath, drillPath,
    ], { encoding: "utf8" });
    assert.equal(drilled.status, 0, drilled.stderr);
    const evidence = JSON.parse(readFileSync(join(drillPath, "RESET-DRILL.json"), "utf8"));
    assert.equal(evidence.oldGenesisPreserved, true);
    assert.equal(evidence.newDomainRejectsOldSignature, true);
    assert.equal(evidence.destructiveExecutionAvailable, false);
    assert.deepEqual(readFileSync(oldPath), oldBefore);

    const secondDrill = spawnSync(process.execPath, [
      cli, "drill", oldPath, newPath, incidentPath, manifestPath, drillPath,
    ], { encoding: "utf8" });
    assert.equal(secondDrill.status, 1);
    assert.match(secondDrill.stderr, /new directory/);
    assert.deepEqual(readFileSync(oldPath), oldBefore);

    const badRequest = join(root, "bad-request.json");
    writeFileSync(badRequest, JSON.stringify({
      extra: true,
      notBefore: 1_000,
      reason: "Unknown fields must be rejected by the planner.",
    }));
    const rejected = spawnSync(process.execPath, [
      cli, "plan", oldPath, newPath, incidentPath, badRequest,
    ], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /shape/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

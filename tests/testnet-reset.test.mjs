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
  resetValidatorTopology,
  signResetManifest,
  verifyResetManifest,
} from "../blockchain/testnet-reset.mjs";
import { createValidatorHandoff } from "../blockchain/validator-handoff.mjs";

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
  const handoffs = [];
  const topology = resetValidatorTopology(oldGenesis, handoffs, 0);
  const plan = createResetManifest({
    activeValidatorSetId: topology.activeValidatorSetId,
    incidentReportHash: incidentReportHash(report),
    newGenesisHash: newIdentity.genesisHash,
    newNetworkId: newIdentity.networkId,
    notBefore: 1_000,
    oldFinalizedHeight: 0,
    oldGenesisHash: oldIdentity.genesisHash,
    oldNetworkId: oldIdentity.networkId,
    reason: "Rehearse an explicit valueless testnet incident reset.",
    validatorTopologyHash: topology.validatorTopologyHash,
  });
  return { handoffs, newGenesis, oldGenesis, plan, report, validators };
}

function approve(plan, validators, oldGenesis, handoffs, count) {
  let result = plan;
  for (const wallet of validators.slice(0, count)) {
    result = signResetManifest(result, wallet, {
      handoffs,
      oldGenesis,
    });
  }
  return result;
}

function signedFixture(count = 3) {
  const values = fixture();
  return {
    ...values,
    signed: approve(
      values.plan, values.validators, values.oldGenesis, values.handoffs, count,
    ),
  };
}

test("reset manifests require exact fields, distinct identities, and a validator quorum", () => {
  const values = signedFixture();
  const options = {
    currentTimestamp: 1_000,
    expectedIncidentReportHash: incidentReportHash(values.report),
    handoffs: values.handoffs,
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
    handoffs: insufficient.handoffs,
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
    handoffs: values.handoffs,
    oldGenesis: values.oldGenesis,
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
  const topology = resetValidatorTopology(values.oldGenesis, [], 0);
  assert.throws(() => createResetManifest({
    activeValidatorSetId: topology.activeValidatorSetId,
    incidentReportHash: incidentReportHash(values.report),
    newGenesisHash: "f".repeat(64),
    newNetworkId: identity.networkId,
    notBefore: 1_000,
    oldFinalizedHeight: 0,
    oldGenesisHash: identity.genesisHash,
    oldNetworkId: identity.networkId,
    reason: "This request improperly reuses the network identity.",
    validatorTopologyHash: topology.validatorTopologyHash,
  }), /new network ID/);
  assert.throws(() => createResetManifest({
    activeValidatorSetId: topology.activeValidatorSetId,
    incidentReportHash: incidentReportHash(values.report),
    newGenesisHash: identity.genesisHash,
    newNetworkId: "nir-other-network",
    notBefore: 1_000,
    oldFinalizedHeight: 0,
    oldGenesisHash: identity.genesisHash,
    oldNetworkId: identity.networkId,
    reason: "This request improperly reuses the genesis identity.",
    validatorTopologyHash: topology.validatorTopologyHash,
  }), /new genesis hash/);
});

test("reset drill proves transaction-domain separation and exposes no destructive action", () => {
  const values = signedFixture();
  const report = createResetDrill(values.signed, {
    currentTimestamp: 1_000,
    expectedIncidentReportHash: incidentReportHash(values.report),
    handoffs: values.handoffs,
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

test("reset authorization advances to the finalized active validator set", () => {
  const values = fixture();
  const nextWallets = [
    values.validators[0], values.validators[1], generateWallet(), generateWallet(),
  ];
  const nextValidators = nextWallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `rotated-validator-${index}`,
  }));
  const handoff = createValidatorHandoff({
    activationBlockHash: "a".repeat(64),
    activationHeight: 10,
    activationStateRoot: "b".repeat(64),
    networkId: values.oldGenesis.networkId,
    nextValidators,
    previousValidators: values.oldGenesis.validators,
  }, values.validators.slice(0, 3), nextWallets.slice(0, 3));
  const handoffs = [handoff];
  const topology = resetValidatorTopology(values.oldGenesis, handoffs, 20);
  const oldIdentity = genesisIdentity(values.oldGenesis);
  const newIdentity = genesisIdentity(values.newGenesis);
  const plan = createResetManifest({
    activeValidatorSetId: topology.activeValidatorSetId,
    incidentReportHash: incidentReportHash(values.report),
    newGenesisHash: newIdentity.genesisHash,
    newNetworkId: newIdentity.networkId,
    notBefore: 1_000,
    oldFinalizedHeight: 20,
    oldGenesisHash: oldIdentity.genesisHash,
    oldNetworkId: oldIdentity.networkId,
    reason: "Authorize reset with the validator set active at finalized height twenty.",
    validatorTopologyHash: topology.validatorTopologyHash,
  });
  const signed = approve(plan, nextWallets, values.oldGenesis, handoffs, 3);
  assert.equal(verifyResetManifest(signed, {
    currentTimestamp: 1_000,
    expectedIncidentReportHash: incidentReportHash(values.report),
    handoffs,
    newGenesis: values.newGenesis,
    oldGenesis: values.oldGenesis,
  }).activeValidatorSetId, topology.activeValidatorSetId);

  assert.throws(() => signResetManifest(plan, values.validators[2], {
    handoffs, oldGenesis: values.oldGenesis,
  }), /unused trusted validator/);

  const staleTopology = resetValidatorTopology(values.oldGenesis, [], 20);
  const stalePlan = createResetManifest({
    ...plan,
    activeValidatorSetId: staleTopology.activeValidatorSetId,
    validatorTopologyHash: staleTopology.validatorTopologyHash,
  });
  const staleSigned = approve(stalePlan, values.validators, values.oldGenesis, [], 3);
  assert.throws(() => verifyResetManifest(staleSigned, {
    currentTimestamp: 1_000,
    expectedIncidentReportHash: incidentReportHash(values.report),
    handoffs,
    newGenesis: values.newGenesis,
    oldGenesis: values.oldGenesis,
  }), /forged|reviewed inputs/);

  const forgedHandoff = structuredClone(handoff);
  forgedHandoff.previousAttestations[0].signature = "AAAA";
  assert.throws(() => resetValidatorTopology(
    values.oldGenesis, [forgedHandoff], 20,
  ), /attestation|trust chain/);
  assert.throws(() => resetValidatorTopology(
    values.oldGenesis, handoffs, 9,
  ), /later than/);
});

test("reset CLI plans, verifies, and drills only into a new isolated directory", () => {
  const values = signedFixture();
  const root = mkdtempSync(join(tmpdir(), "nir-reset-test-"));
  const cli = new URL("../blockchain/testnet-reset-cli.mjs", import.meta.url).pathname;
  const oldPath = join(root, "old-genesis.json");
  const handoffsPath = join(root, "validator-handoffs.json");
  const newPath = join(root, "new-genesis.json");
  const incidentPath = join(root, "incident.md");
  const requestPath = join(root, "request.json");
  const manifestPath = join(root, "reset.json");
  const drillPath = join(root, "isolated-drill");
  try {
    writeFileSync(oldPath, `${JSON.stringify(values.oldGenesis, null, 2)}\n`);
    writeFileSync(handoffsPath, `${JSON.stringify(values.handoffs, null, 2)}\n`);
    writeFileSync(newPath, `${JSON.stringify(values.newGenesis, null, 2)}\n`);
    writeFileSync(incidentPath, values.report);
    writeFileSync(requestPath, `${JSON.stringify({
      notBefore: 1_000,
      oldFinalizedHeight: 0,
      reason: "Rehearse an explicit valueless testnet incident reset.",
    })}\n`);
    const oldBefore = readFileSync(oldPath);
    const planned = spawnSync(process.execPath, [
      cli, "plan", oldPath, handoffsPath, newPath, incidentPath, requestPath,
    ], { encoding: "utf8" });
    assert.equal(planned.status, 0, planned.stderr);
    assert.deepEqual(JSON.parse(planned.stdout), values.plan);
    writeFileSync(manifestPath, `${JSON.stringify(values.signed)}\n`);

    const verified = spawnSync(process.execPath, [
      cli, "verify", oldPath, handoffsPath, newPath, incidentPath, manifestPath,
    ], { encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).verified, true);
    const drilled = spawnSync(process.execPath, [
      cli, "drill", oldPath, handoffsPath, newPath, incidentPath, manifestPath, drillPath,
    ], { encoding: "utf8" });
    assert.equal(drilled.status, 0, drilled.stderr);
    const evidence = JSON.parse(readFileSync(join(drillPath, "RESET-DRILL.json"), "utf8"));
    assert.equal(evidence.oldGenesisPreserved, true);
    assert.equal(evidence.newDomainRejectsOldSignature, true);
    assert.equal(evidence.destructiveExecutionAvailable, false);
    assert.deepEqual(readFileSync(oldPath), oldBefore);

    const secondDrill = spawnSync(process.execPath, [
      cli, "drill", oldPath, handoffsPath, newPath, incidentPath, manifestPath, drillPath,
    ], { encoding: "utf8" });
    assert.equal(secondDrill.status, 1);
    assert.match(secondDrill.stderr, /new directory/);
    assert.deepEqual(readFileSync(oldPath), oldBefore);

    const badRequest = join(root, "bad-request.json");
    writeFileSync(badRequest, JSON.stringify({
      extra: true,
      notBefore: 1_000,
      oldFinalizedHeight: 0,
      reason: "Unknown fields must be rejected by the planner.",
    }));
    const rejected = spawnSync(process.execPath, [
      cli, "plan", oldPath, handoffsPath, newPath, incidentPath, badRequest,
    ], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /shape/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

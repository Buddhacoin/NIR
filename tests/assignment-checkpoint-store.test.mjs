import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  verifyAssignmentWithCheckpointTrustStore,
} from "../blockchain/assignment-checkpoint-store.mjs";
import {
  createCheckpointTrustStore, loadCheckpointTrustStore, verifyAndAdvanceCheckpointTrustStore,
} from "../blockchain/checkpoint-trust-store.mjs";
import { canonicalJson } from "../blockchain/crypto.mjs";

function loadFixture() {
  return JSON.parse(execFileSync(process.execPath, [
    new URL("./assignment_chain_fixture.mjs", import.meta.url).pathname,
  ], { env: { ...process.env, NIR_ASSIGNMENT_FIXTURE_V4: "1" } }));
}

function request(value) {
  const leaf = value.consensusAssignment;
  const keys = new Map(value.evaluators.map(({ address, publicKey }) => [address, publicKey]));
  const candidate = {
    artifact_hash: value.commitmentTransaction.artifactHash,
    baseline_content_hash: value.commitmentTransaction.baselineContentHash,
    baseline_hash: value.commitmentTransaction.baselineHash,
    candidate_id: value.commitmentTransaction.candidateId,
    committed_epoch: value.transactionBlockHeight,
    content_hash: value.commitmentTransaction.contentHash,
    network_id: value.commitmentTransaction.networkId,
    parents: value.commitmentTransaction.parents,
    recipient: value.commitmentTransaction.recipient,
    suite_commitment: value.commitmentTransaction.suiteCommitment,
  };
  const candidateCommitmentHash = createHash("sha256")
    .update("NIR_CANDIDATE_COMMITMENT\0", "ascii")
    .update(canonicalJson(candidate), "utf8").digest("hex");
  const assignment = {
    adapterProtocol: leaf.adapterProtocol, authorityMode: leaf.authorityMode,
    authoritySetHash: leaf.authoritySetHash, baselineArtifactHash: leaf.baselineHash,
    baselineContentHash: leaf.baselineContentHash, candidateArtifactHash: leaf.artifactHash,
    candidateCommitmentHash, candidateContentHash: leaf.contentHash,
    candidateId: leaf.candidateId, challengeEpoch: leaf.challengeEpoch,
    challengeSeed: leaf.challengeSeed, committedHeight: leaf.committedHeight,
    decisionHeight: leaf.challengeHeight, environmentCommitment: leaf.environmentCommitment,
    evaluators: leaf.committee.map((evaluatorId) => ({ evaluatorId,
      publicKey: keys.get(evaluatorId) })), expiresAtHeight: leaf.expiresAtHeight,
    format: "nir-finalized-evaluation-assignment-v2", genesisHash: value.genesisHash,
    networkId: value.networkId, parents: leaf.parents, recipient: leaf.recipient,
    safetyPolicyHash: leaf.safetyPolicyHash,
    sourceFinalityHeight: leaf.sourceFinalityHeight,
    sourceFinalityStateRoot: leaf.sourceFinalityStateRoot,
    suiteCommitment: leaf.suiteCommitment,
  };
  return {
    assignment, assignmentProof: value.assignmentProof, checkpoint: value.checkpoint,
    checkpointTrustPackage: value.checkpointTrustPackage,
    commitmentTransaction: value.commitmentTransaction,
    consensusAssignment: value.consensusAssignment, decisionAnchor: value.decisionAnchor,
    finalityProofs: value.finalityProofs, handoffs: [], inclusionAnchor: value.inclusionAnchor,
    sourceAnchor: value.sourceAnchor, transactionBlockHeight: value.transactionBlockHeight,
    transactionProof: value.transactionProof,
  };
}

function setup(name, value) {
  const root = mkdtempSync(join(tmpdir(), `nir-assignment-store-${name}-`));
  const path = join(root, "trust");
  createCheckpointTrustStore(path, value.previousCheckpointTrustPackage, {
    expectedChainIdentityGenesisHash: value.genesisHash,
    expectedNetworkId: value.networkId,
    expectedPolicyId: value.checkpointTrustPolicyId,
  });
  return { path, root };
}

const value = loadFixture();

test("exact V4 assignment advances its durable checkpoint floor only after complete verification", () => {
  const target = setup("atomic", value);
  try {
    const input = request(value);
    const before = loadCheckpointTrustStore(target.path).record;
    assert.equal(before.sequence, 1);

    const forged = structuredClone(input);
    forged.assignment.safetyPolicyHash = "0".repeat(64);
    assert.throws(() => verifyAssignmentWithCheckpointTrustStore(target.path, forged),
      /does not match/);
    assert.deepEqual(loadCheckpointTrustStore(target.path).record, before);

    const verified = verifyAssignmentWithCheckpointTrustStore(target.path, input);
    assert.equal(verified.result.exactAssignmentIncluded, true);
    assert.equal(verified.trustRecord.sequence, 2);
    assert.equal(verified.trustRecord.revision, 1);
    const replay = verifyAssignmentWithCheckpointTrustStore(target.path, input);
    assert.equal(replay.trustRecord.recordHash, verified.trustRecord.recordHash);
    assert.equal(replay.trustRecord.revision, 1);
  } finally { rmSync(target.root, { recursive: true, force: true }); }
});

test("stored verification rejects caller trust injection, rollback, and a live concurrent writer", () => {
  const target = setup("adversarial", value);
  try {
    const input = request(value);
    assert.throws(() => verifyAssignmentWithCheckpointTrustStore(target.path, {
      ...input, expectedCheckpointPolicyId: value.checkpointTrustPolicyId,
    }), /request is invalid/);
    const unchanged = loadCheckpointTrustStore(target.path).record;
    const tooDeep = structuredClone(input);
    let nested = {};
    tooDeep.handoffs = [nested];
    for (let index = 0; index < 70; index += 1) nested = nested.next = {};
    assert.throws(() => verifyAssignmentWithCheckpointTrustStore(target.path, tooDeep),
      /nesting|bounded canonical JSON/);
    assert.deepEqual(loadCheckpointTrustStore(target.path).record, unchanged);
    assert.throws(() => verifyAndAdvanceCheckpointTrustStore(
      target.path, value.checkpointTrustPackage, async () => true,
    ), /must be synchronous/);
    assert.deepEqual(loadCheckpointTrustStore(target.path).record, unchanged);
    assert.throws(() => verifyAndAdvanceCheckpointTrustStore(
      target.path, value.checkpointTrustPackage, () => ({ uncloneable: () => true }),
    ), /clone|function/i);
    assert.deepEqual(loadCheckpointTrustStore(target.path).record, unchanged);
    writeFileSync(`${target.path}.lock`, `${JSON.stringify({
      format: "nir-checkpoint-trust-store-lock-v1", pid: process.pid,
      token: "a".repeat(64), version: 1,
    })}\n`, { mode: 0o600 });
    assert.throws(() => verifyAssignmentWithCheckpointTrustStore(target.path, input), /live owner/);
    rmSync(`${target.path}.lock`);
    verifyAssignmentWithCheckpointTrustStore(target.path, input);
    const advanced = loadCheckpointTrustStore(target.path).record;
    const rollback = { ...input, checkpointTrustPackage: value.previousCheckpointTrustPackage };
    assert.throws(() => verifyAssignmentWithCheckpointTrustStore(target.path, rollback),
      /anti-replay|rollback|replayed|view/);
    assert.deepEqual(loadCheckpointTrustStore(target.path).record, advanced);
  } finally { rmSync(target.root, { recursive: true, force: true }); }
});

test("canonical CLI verifies atomically and rejects symlinked assignment input", () => {
  const target = setup("cli", value);
  try {
    const inputPath = join(target.root, "assignment.json");
    writeFileSync(inputPath, `${canonicalJson(request(value))}\n`, { mode: 0o600 });
    const command = ["blockchain/assignment-checkpoint-store-cli.mjs", "verify",
      target.path, inputPath];
    const completed = spawnSync(process.execPath, command,
      { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(completed.status, 0, completed.stderr);
    const output = JSON.parse(completed.stdout);
    assert.equal(output.result.exactAssignmentIncluded, true);
    assert.equal(output.trustRecord.sequence, 2);

    const linkPath = join(target.root, "assignment-link.json");
    symlinkSync(inputPath, linkPath);
    const rejected = spawnSync(process.execPath,
      ["blockchain/assignment-checkpoint-store-cli.mjs", "verify", target.path, linkPath],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /failed/i);
    assert.equal(readFileSync(`${target.path}.primary`, "utf8").includes('"sequence":2'), true);
  } finally { rmSync(target.root, { recursive: true, force: true }); }
});

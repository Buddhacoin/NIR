import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { verifyAssignmentChainAnchor } from "../blockchain/assignment-chain-anchor.mjs";
import { canonicalJson } from "../blockchain/crypto.mjs";

function fixture(version = 3) {
  return JSON.parse(execFileSync(process.execPath, [
    new URL("./assignment_chain_fixture.mjs", import.meta.url).pathname,
  ], { env: { ...process.env,
    [version === 4 ? "NIR_ASSIGNMENT_FIXTURE_V4" : "NIR_ASSIGNMENT_FIXTURE_V3"]: "1" } }));
}

function request(version = 3) {
  const value = fixture(version);
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
    adapterProtocol: leaf.adapterProtocol,
    authorityMode: leaf.authorityMode,
    authoritySetHash: leaf.authoritySetHash,
    baselineArtifactHash: leaf.baselineHash,
    baselineContentHash: leaf.baselineContentHash,
    candidateArtifactHash: leaf.artifactHash,
    candidateCommitmentHash,
    candidateContentHash: leaf.contentHash,
    candidateId: leaf.candidateId,
    challengeEpoch: leaf.challengeEpoch,
    challengeSeed: leaf.challengeSeed,
    committedHeight: leaf.committedHeight,
    decisionHeight: leaf.challengeHeight,
    environmentCommitment: leaf.environmentCommitment,
    evaluators: leaf.committee.map((evaluatorId) => ({ evaluatorId,
      publicKey: keys.get(evaluatorId) })),
    expiresAtHeight: leaf.expiresAtHeight,
    format: "nir-finalized-evaluation-assignment-v2",
    genesisHash: value.genesisHash,
    networkId: value.networkId,
    parents: leaf.parents,
    recipient: leaf.recipient,
    safetyPolicyHash: leaf.safetyPolicyHash,
    sourceFinalityHeight: leaf.sourceFinalityHeight,
    sourceFinalityStateRoot: leaf.sourceFinalityStateRoot,
    suiteCommitment: leaf.suiteCommitment,
  };
  return { value, input: {
    assignment, assignmentProof: value.assignmentProof, checkpoint: value.checkpoint,
    checkpointTrustPackage: value.checkpointTrustPackage ?? null,
    expectedCheckpointPolicyId: value.checkpointTrustPolicyId ?? null,
    minimumCheckpointHeight: value.minimumCheckpointHeight ?? null,
    minimumCheckpointSequence: value.minimumCheckpointSequence ?? null,
    commitmentTransaction: value.commitmentTransaction,
    consensusAssignment: value.consensusAssignment,
    decisionAnchor: value.decisionAnchor, expectedGenesisHash: value.genesisHash,
    expectedNetworkId: value.networkId, finalityProofs: value.finalityProofs, handoffs: [],
    inclusionAnchor: value.inclusionAnchor, sourceAnchor: value.sourceAnchor,
    transactionBlockHeight: value.transactionBlockHeight,
    transactionProof: value.transactionProof,
    trustedValidators: version === 4 ? [] : value.trustedValidators,
  } };
}

test("v3 exact assignment authenticates semantic preimage and separate anchors", () => {
  const { input } = request();
  const result = verifyAssignmentChainAnchor(input);
  assert.equal(result.exactAssignmentIncluded, true);
  assert.match(result.assignmentHash, /^[0-9a-f]{64}$/);
  assert.equal(result.finalizedHeight, input.sourceAnchor.height);
  const reordered = {
    stateRoot: input.sourceAnchor.stateRoot,
    blockHash: input.sourceAnchor.blockHash,
    height: input.sourceAnchor.height,
  };
  assert.equal(verifyAssignmentChainAnchor({
    ...input, sourceAnchor: reordered,
  }).exactAssignmentIncluded, true);
});

test("v4 exact assignment uses a bounded v28 checkpoint after a long history", () => {
  const { input, value } = request(4);
  assert.ok(input.checkpoint.height > 512);
  assert.ok(input.finalityProofs.length < 10);
  const result = verifyAssignmentChainAnchor(input);
  assert.equal(result.exactAssignmentIncluded, true);
  assert.equal(result.assignmentHash.length, 64);
  assert.throws(() => verifyAssignmentChainAnchor({
    ...input, checkpoint: { ...input.checkpoint, chainIdentityGenesisHash: "0".repeat(64) },
  }), /checkpoint envelope is invalid/);
  assert.throws(() => verifyAssignmentChainAnchor({
    ...input, transactionBlockHeight: input.checkpoint.height,
  }), /must precede the commitment transaction/);
  assert.equal(value.checkpointTrustPackage.format, "nir-checkpoint-trust-package-v1");
  assert.throws(() => verifyAssignmentChainAnchor({
    ...input, expectedCheckpointPolicyId: `sha3-256:${"0".repeat(64)}`,
  }), /pinned trust policy/);
  assert.throws(() => verifyAssignmentChainAnchor({
    ...input, minimumCheckpointSequence: input.minimumCheckpointSequence + 1,
  }), /anti-replay floor|replayed/);
  assert.throws(() => verifyAssignmentChainAnchor({
    ...input, minimumCheckpointHeight: input.minimumCheckpointHeight + 1,
  }), /replayed/);
  assert.throws(() => verifyAssignmentChainAnchor({
    ...input, trustedValidators: value.trustedValidators,
  }), /validators must come from the trust package/);
  assert.throws(() => verifyAssignmentChainAnchor({
    ...input, checkpointTrustPackage: null,
    checkpointFinalityProof: value.checkpointTrustPackage.finalityProof,
  }), /unwitnessed assignment checkpoint is disabled/);
});

test("v3 exact assignment rejects replay, non-genesis trust and semantic substitution", () => {
  const { input } = request();
  assert.throws(() => verifyAssignmentChainAnchor({
    ...input, assignment: { ...input.assignment, unknown: true },
  }), /schema is invalid/);
  assert.throws(() => verifyAssignmentChainAnchor({
    ...input, assignment: { ...input.assignment, safetyPolicyHash: "0".repeat(64) },
  }), /does not match/);
  assert.throws(() => verifyAssignmentChainAnchor({
    ...input, inclusionAnchor: { ...input.inclusionAnchor,
      evaluationAssignmentRoot: "0".repeat(64) },
  }), /anchors are invalid/);
  assert.throws(() => verifyAssignmentChainAnchor({
    ...input, checkpoint: { ...input.checkpoint, height: 1 },
  }), /anchors are invalid|discontinuous/);
  assert.throws(() => verifyAssignmentChainAnchor({
    ...input, decisionAnchor: { ...input.decisionAnchor,
      height: input.decisionAnchor.height + 1 },
  }), /anchors are invalid/);
});

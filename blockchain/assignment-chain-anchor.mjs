import { createHash } from "node:crypto";

import { addressFromPublicKey, canonicalJson, hashObject } from "./crypto.mjs";
import { verifyFinalityProofChain, verifyRecentFinalityCheckpoint } from "./light-client.mjs";
import { verifyTransactionProof } from "./transaction-tree.mjs";
import { verifyEvaluationAssignmentProof } from "./evaluation-assignment-tree.mjs";

const HASH = /^[0-9a-f]{64}$/;
const ARTIFACT = /^sha256:[0-9a-f]{64}$/;

export function verifyAssignmentChainAnchor({
  assignment, assignmentProof = null, checkpoint, commitmentTransaction,
  consensusAssignment = null, expectedGenesisHash,
  expectedNetworkId, finalityProofs, handoffs = [], transactionBlockHeight,
  transactionProof, trustedValidators, sourceAnchor = null, decisionAnchor = null,
  inclusionAnchor = null, checkpointFinalityProof = null,
}) {
  const exactV2 = assignment?.format === "nir-finalized-evaluation-assignment-v2";
  const exactV2Fields = [
    "adapterProtocol", "authorityMode", "authoritySetHash", "baselineArtifactHash",
    "baselineContentHash", "candidateArtifactHash", "candidateCommitmentHash",
    "candidateContentHash", "candidateId", "challengeEpoch", "challengeSeed",
    "committedHeight", "decisionHeight", "environmentCommitment", "evaluators",
    "expiresAtHeight", "format", "genesisHash", "networkId", "parents", "recipient",
    "safetyPolicyHash", "sourceFinalityHeight", "sourceFinalityStateRoot", "suiteCommitment",
  ].sort().join("\0");
  if (!assignment || (!exactV2 &&
      assignment.format !== "nir-finalized-evaluation-assignment-v1-experimental") ||
      assignment.networkId !== expectedNetworkId || assignment.genesisHash !== expectedGenesisHash ||
      !HASH.test(expectedGenesisHash ?? "") || !Number.isSafeInteger(transactionBlockHeight) ||
      transactionBlockHeight < 1 || !Array.isArray(finalityProofs) || finalityProofs.length < 1 ||
      (checkpoint?.height === 0 && checkpoint.tipHash !== expectedGenesisHash)) {
    throw new Error("assignment chain anchor envelope is invalid");
  }
  if (exactV2 && (Object.getPrototypeOf(assignment) !== Object.prototype ||
      Object.keys(assignment).sort().join("\0") !== exactV2Fields ||
      !Array.isArray(assignment.evaluators) || assignment.evaluators.length < 1 ||
      assignment.evaluators.length > 64 || assignment.evaluators.some((member) =>
        !member || Object.getPrototypeOf(member) !== Object.prototype ||
        Object.keys(member).sort().join("\0") !== "evaluatorId\0publicKey" ||
        typeof member.publicKey !== "string" || member.publicKey.length > 8_000) ||
      !Array.isArray(assignment.parents) || assignment.parents.length < 1 ||
      assignment.parents.length > 32)) {
    throw new Error("assignment v2 schema is invalid");
  }
  const compactCheckpoint = checkpointFinalityProof === null ? null
    : verifyRecentFinalityCheckpoint(checkpointFinalityProof, {
      expectedGenesisHash, expectedNetworkId, trustedValidators,
    });
  if (compactCheckpoint && !exactV2) {
    throw new Error("recent assignment checkpoint requires assignment v2");
  }
  if (compactCheckpoint && (!checkpoint ||
      checkpoint.height !== compactCheckpoint.height ||
      checkpoint.tipHash !== compactCheckpoint.tipHash ||
      checkpoint.stateRoot !== compactCheckpoint.stateRoot ||
      checkpoint.protocolVersion !== compactCheckpoint.protocolVersion ||
      checkpoint.validatorSetId !== compactCheckpoint.validatorSetId ||
      checkpoint.chainIdentityGenesisHash !== expectedGenesisHash)) {
    throw new Error("recent assignment checkpoint envelope is invalid");
  }
  if (compactCheckpoint && checkpoint.height >= transactionBlockHeight) {
    throw new Error("recent assignment checkpoint must precede the commitment transaction");
  }
  const tip = verifyFinalityProofChain(finalityProofs, {
    checkpoint, expectedNetworkId, handoffs, trustedValidators,
    expectedChainIdentityGenesisHash: compactCheckpoint ? expectedGenesisHash : null,
  });
  const headerAnchor = (height) => {
    if (height === checkpoint?.height) {
      return { blockHash: checkpoint.tipHash, height, stateRoot: checkpoint.stateRoot };
    }
    const proof = finalityProofs.find(({ header }) => header?.height === height);
    return proof && { blockHash: proof.hash, height, stateRoot: proof.header.stateRoot };
  };
  if (exactV2) {
    const anchorKeys = (anchor, inclusion = false) => anchor &&
      Object.keys(anchor).sort().join("\0") === (inclusion
        ? "blockHash\0evaluationAssignmentRoot\0height\0stateRoot"
        : "blockHash\0height\0stateRoot") &&
      Number.isSafeInteger(anchor.height) && anchor.height >= 0 &&
      HASH.test(anchor.blockHash ?? "") && HASH.test(anchor.stateRoot ?? "") &&
      (!inclusion || HASH.test(anchor.evaluationAssignmentRoot ?? ""));
    const anchorMatches = (actual, expected) => actual &&
      actual.blockHash === expected.blockHash && actual.height === expected.height &&
      actual.stateRoot === expected.stateRoot;
    if (!anchorKeys(sourceAnchor) || !anchorKeys(decisionAnchor) ||
        !anchorKeys(inclusionAnchor, true) ||
        (!compactCheckpoint && (checkpoint?.height !== 0 ||
          checkpoint.tipHash !== expectedGenesisHash)) ||
        !anchorMatches(headerAnchor(sourceAnchor.height), sourceAnchor) ||
        !anchorMatches(headerAnchor(decisionAnchor.height), decisionAnchor) ||
        inclusionAnchor.height !== tip.height || inclusionAnchor.blockHash !== tip.tipHash ||
        inclusionAnchor.stateRoot !== tip.stateRoot ||
        inclusionAnchor.evaluationAssignmentRoot !== tip.evaluationAssignmentRoot ||
        sourceAnchor.height + 1 !== decisionAnchor.height ||
        decisionAnchor.height !== inclusionAnchor.height) {
      throw new Error("assignment v2 finality anchors are invalid");
    }
  } else if (sourceAnchor !== null || decisionAnchor !== null || inclusionAnchor !== null) {
    throw new Error("legacy assignment cannot carry v3 anchors");
  }
  const extendedAssignment = consensusAssignment?.format === "nir-evaluation-assignment-v2";
  if (!extendedAssignment && (tip.height !== assignment.finalizedHeight ||
      tip.stateRoot !== assignment.finalizedStateRoot)) {
    throw new Error("assignment finalized state anchor does not match the light-client tip");
  }
  if ((assignmentProof === null) !== (consensusAssignment === null)) {
    throw new Error("consensus assignment proof pair is incomplete");
  }
  let chainAssignmentIncluded = false;
  if (consensusAssignment !== null) {
    if (!tip.evaluationAssignmentRoot) {
      throw new Error("finalized header predates consensus assignment proofs");
    }
    const verified = verifyEvaluationAssignmentProof(
      consensusAssignment, assignmentProof, tip.evaluationAssignmentRoot,
    );
    const evaluatorIds = assignment.evaluators?.map(({ evaluatorId }) => evaluatorId);
    if (verified.candidateId !== assignment.candidateId ||
        verified.committedHeight !== transactionBlockHeight ||
        verified.challengeSeed !== assignment.challengeSeed ||
        verified.challengeEpoch !== assignment.challengeEpoch ||
        verified.artifactHash !== assignment.candidateArtifactHash ||
        verified.contentHash !== assignment.candidateContentHash ||
        verified.baselineHash !== assignment.baselineArtifactHash ||
        verified.baselineContentHash !== assignment.baselineContentHash ||
        verified.suiteCommitment !== assignment.suiteCommitment ||
        verified.recipient !== commitmentTransaction?.recipient ||
        JSON.stringify(verified.parents) !== JSON.stringify(commitmentTransaction?.parents) ||
        JSON.stringify(verified.committee) !== JSON.stringify(evaluatorIds)) {
      throw new Error("consensus assignment does not match the external assignment bindings");
    }
    if (verified.format === "nir-evaluation-assignment-v2") {
      const externalEvaluators = assignment.evaluators?.map(
        ({ evaluatorId, publicKey }) => ({
          evaluatorId,
          publicKeyHash: hashObject(publicKey, "EVALUATION_ASSIGNMENT_PUBLIC_KEY_V1"),
        }),
      );
      if (assignment.evaluators?.some(({ evaluatorId, publicKey }) =>
        addressFromPublicKey(publicKey) !== evaluatorId)) {
        throw new Error("external assignment evaluator key is invalid");
      }
      if (verified.sourceFinalityHeight !== (exactV2
        ? assignment.sourceFinalityHeight : assignment.finalizedHeight) ||
          verified.sourceFinalityStateRoot !== (exactV2
            ? assignment.sourceFinalityStateRoot : assignment.finalizedStateRoot) ||
          verified.environmentCommitment !== assignment.environmentCommitment ||
          verified.adapterProtocol !== assignment.adapterProtocol ||
          verified.safetyPolicyHash !== assignment.safetyPolicyHash ||
          verified.authoritySetHash !== assignment.authoritySetHash ||
          verified.expiresAtHeight !== assignment.expiresAtHeight ||
          JSON.stringify(verified.evaluators) !== JSON.stringify(externalEvaluators)) {
        throw new Error("extended consensus assignment does not match the external assignment");
      }
      const sourceHeader = verified.sourceFinalityHeight === checkpoint?.height
        ? checkpoint
        : finalityProofs.find(({ header }) =>
          header?.height === verified.sourceFinalityHeight)?.header;
      if (!sourceHeader || sourceHeader.stateRoot !== verified.sourceFinalityStateRoot ||
          verified.sourceFinalityHeight >= tip.height) {
        throw new Error("extended assignment source finality is not authenticated");
      }
      if (exactV2) {
        const exactEvaluatorIds = assignment.evaluators?.map(({ evaluatorId }) => evaluatorId);
        if (sourceAnchor.height !== assignment.sourceFinalityHeight ||
            sourceAnchor.stateRoot !== assignment.sourceFinalityStateRoot ||
            decisionAnchor.height !== assignment.decisionHeight ||
            verified.challengeHeight !== assignment.decisionHeight ||
            verified.committedHeight !== assignment.committedHeight ||
            verified.authorityMode !== assignment.authorityMode ||
            verified.recipient !== assignment.recipient ||
            JSON.stringify(verified.parents) !== JSON.stringify(assignment.parents) ||
            JSON.stringify(verified.committee) !== JSON.stringify(exactEvaluatorIds)) {
          throw new Error("consensus assignment does not match assignment v2 semantics");
        }
      }
    } else if (exactV2) {
      throw new Error("assignment v2 requires the protocol-v27 consensus leaf");
    }
    chainAssignmentIncluded = true;
  }
  const transactionHeader = finalityProofs.find(
    ({ header }) => header?.height === transactionBlockHeight,
  )?.header;
  if (!transactionHeader) throw new Error("commitment transaction header is not finalized");
  verifyTransactionProof(commitmentTransaction, transactionProof, transactionHeader.transactionsRoot);
  if (!commitmentTransaction || commitmentTransaction.type !== "progress-commitment" ||
      commitmentTransaction.networkId !== expectedNetworkId ||
      commitmentTransaction.candidateId !== assignment.candidateId ||
      commitmentTransaction.artifactHash !== assignment.candidateArtifactHash ||
      commitmentTransaction.contentHash !== assignment.candidateContentHash ||
      commitmentTransaction.baselineHash !== assignment.baselineArtifactHash ||
      commitmentTransaction.baselineContentHash !== assignment.baselineContentHash ||
      commitmentTransaction.suiteCommitment !== assignment.suiteCommitment ||
      !ARTIFACT.test(commitmentTransaction.artifactHash ?? "") ||
      !ARTIFACT.test(commitmentTransaction.contentHash ?? "")) {
    throw new Error("finalized progress commitment does not match the assignment");
  }
  if (exactV2) {
    const candidateCommitment = {
      artifact_hash: commitmentTransaction.artifactHash,
      baseline_content_hash: commitmentTransaction.baselineContentHash,
      baseline_hash: commitmentTransaction.baselineHash,
      candidate_id: commitmentTransaction.candidateId,
      committed_epoch: transactionBlockHeight,
      content_hash: commitmentTransaction.contentHash,
      network_id: commitmentTransaction.networkId,
      parents: commitmentTransaction.parents,
      recipient: commitmentTransaction.recipient,
      suite_commitment: commitmentTransaction.suiteCommitment,
    };
    const candidateCommitmentHash = createHash("sha256")
      .update("NIR_CANDIDATE_COMMITMENT\0", "ascii")
      .update(canonicalJson(candidateCommitment), "utf8").digest("hex");
    if (candidateCommitmentHash !== assignment.candidateCommitmentHash) {
      throw new Error("assignment v2 candidate commitment hash is invalid");
    }
  }
  const result = {
    candidateCommitmentIncluded: true,
    chainAssignmentIncluded,
    exactAssignmentIncluded: exactV2 && chainAssignmentIncluded,
    finalizedHeight: extendedAssignment
      ? consensusAssignment.sourceFinalityHeight : tip.height,
    finalizedStateRoot: extendedAssignment
      ? consensusAssignment.sourceFinalityStateRoot : tip.stateRoot,
    transactionBlockHeight,
  };
  if (exactV2) result.assignmentHash = hashObject(assignment, "NIR_EVAL_ASSIGN_V2");
  return result;
}

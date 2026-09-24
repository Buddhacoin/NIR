import { verifyFinalityProofChain } from "./light-client.mjs";
import { verifyTransactionProof } from "./transaction-tree.mjs";
import { verifyEvaluationAssignmentProof } from "./evaluation-assignment-tree.mjs";

const HASH = /^[0-9a-f]{64}$/;
const ARTIFACT = /^sha256:[0-9a-f]{64}$/;

export function verifyAssignmentChainAnchor({
  assignment, assignmentProof = null, checkpoint, commitmentTransaction,
  consensusAssignment = null, expectedGenesisHash,
  expectedNetworkId, finalityProofs, handoffs = [], transactionBlockHeight,
  transactionProof, trustedValidators,
}) {
  if (!assignment || assignment.format !== "nir-finalized-evaluation-assignment-v1-experimental" ||
      assignment.networkId !== expectedNetworkId || assignment.genesisHash !== expectedGenesisHash ||
      !HASH.test(expectedGenesisHash ?? "") || !Number.isSafeInteger(transactionBlockHeight) ||
      transactionBlockHeight < 1 || !Array.isArray(finalityProofs) || finalityProofs.length < 1 ||
      (checkpoint?.height === 0 && checkpoint.tipHash !== expectedGenesisHash)) {
    throw new Error("assignment chain anchor envelope is invalid");
  }
  const tip = verifyFinalityProofChain(finalityProofs, {
    checkpoint, expectedNetworkId, handoffs, trustedValidators,
  });
  if (tip.height !== assignment.finalizedHeight ||
      tip.stateRoot !== assignment.finalizedStateRoot) {
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
  return {
    candidateCommitmentIncluded: true,
    chainAssignmentIncluded,
    exactAssignmentIncluded: false,
    finalizedHeight: tip.height,
    finalizedStateRoot: tip.stateRoot,
    transactionBlockHeight,
  };
}

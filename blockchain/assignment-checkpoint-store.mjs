import { canonicalJson } from "./crypto.mjs";
import { verifyAssignmentChainAnchor } from "./assignment-chain-anchor.mjs";
import { verifyAndAdvanceCheckpointTrustStore } from "./checkpoint-trust-store.mjs";

export const MAX_STORED_ASSIGNMENT_VERIFICATION_BYTES = 32 * 1024 * 1024;

const INPUT_FIELDS = [
  "assignment", "assignmentProof", "checkpoint", "checkpointTrustPackage",
  "commitmentTransaction", "consensusAssignment", "decisionAnchor", "finalityProofs",
  "handoffs", "inclusionAnchor", "sourceAnchor", "transactionBlockHeight",
  "transactionProof",
].sort().join("\0");

function boundedRequest(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== INPUT_FIELDS ||
      value.assignment?.format !== "nir-finalized-evaluation-assignment-v2" ||
      value.checkpointTrustPackage?.format !== "nir-checkpoint-trust-package-v1" ||
      !Array.isArray(value.finalityProofs) || !Array.isArray(value.handoffs)) {
    throw new Error("stored assignment verification request is invalid");
  }
  let encoded;
  try { encoded = Buffer.byteLength(canonicalJson(value), "utf8"); }
  catch { throw new Error("stored assignment verification request is not bounded canonical JSON"); }
  if (encoded < 2 || encoded > MAX_STORED_ASSIGNMENT_VERIFICATION_BYTES) {
    throw new Error("stored assignment verification request is outside the bounded limit");
  }
  return structuredClone(value);
}

/**
 * Verify an exact V4 assignment against the identity, witness policy and monotonic
 * floors pinned in a durable checkpoint store.  The store is advanced only after
 * every assignment, finality, inclusion and commitment check succeeds.
 */
export function verifyAssignmentWithCheckpointTrustStore(storePath, requestValue, options = {}) {
  const request = boundedRequest(requestValue);
  const transaction = verifyAndAdvanceCheckpointTrustStore(
    storePath, request.checkpointTrustPackage,
    ({ currentRecord }) => {
      const result = verifyAssignmentChainAnchor({
        ...request,
        expectedCheckpointPolicyId: currentRecord.policyId,
        expectedGenesisHash: currentRecord.chainIdentityGenesisHash,
        expectedNetworkId: currentRecord.networkId,
        minimumCheckpointHeight: currentRecord.height,
        minimumCheckpointSequence: currentRecord.sequence,
        trustedValidators: [],
      });
      if (result.exactAssignmentIncluded !== true ||
          result.chainAssignmentIncluded !== true ||
          result.candidateCommitmentIncluded !== true) {
        throw new Error("stored assignment verification did not prove the complete assignment");
      }
      return result;
    }, options,
  );
  return { result: transaction.result, trustRecord: transaction.store.record };
}

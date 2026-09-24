import base64
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from nir.assignment_chain_proof import (
    AssignmentChainProof,
    MAX_FINALITY_PROOFS,
    verify_assignment_chain_anchor,
)
from nir.execution_receipt import (
    AssignedEvaluator,
    FinalizedEvaluationAssignment,
    evaluator_id_for_public_key,
)
from nir.model import ProtocolError
from nir.runner import CandidateCommitment


class AssignmentChainProofAdversarialTests(unittest.TestCase):
    def setUp(self):
        transaction = {
            "artifactHash": "sha256:" + "1" * 64,
            "baselineHash": "sha256:" + "2" * 64,
            "baselineContentHash": "sha256:" + "3" * 64,
            "candidateId": "4" * 64,
            "contentHash": "sha256:" + "5" * 64,
            "networkId": "nir-test",
            "parents": ["sha256:" + "6" * 64],
            "recipient": "recipient",
            "suiteCommitment": "7" * 64,
            "type": "progress-commitment",
        }
        commitment = CandidateCommitment.from_dict({
            "artifact_hash": transaction["artifactHash"],
            "baseline_hash": transaction["baselineHash"],
            "baseline_content_hash": transaction["baselineContentHash"],
            "candidate_id": transaction["candidateId"],
            "committed_epoch": 10,
            "content_hash": transaction["contentHash"],
            "network_id": transaction["networkId"],
            "parents": transaction["parents"],
            "recipient": transaction["recipient"],
            "suite_commitment": transaction["suiteCommitment"],
        })
        public_key = base64.b64encode(b"proof-evaluator-key" * 80).decode("ascii")
        evaluator_id = evaluator_id_for_public_key(public_key)
        self.assignment = FinalizedEvaluationAssignment(
            network_id="nir-test", genesis_hash="8" * 64,
            candidate_commitment_hash=commitment.commitment_hash,
            candidate_id=transaction["candidateId"], finalized_height=12,
            finalized_state_root="9" * 64, challenge_seed="a" * 64,
            challenge_epoch=10, environment_commitment="b" * 64,
            suite_commitment=transaction["suiteCommitment"],
            baseline_artifact_hash=transaction["baselineHash"],
            baseline_content_hash=transaction["baselineContentHash"],
            candidate_artifact_hash=transaction["artifactHash"],
            candidate_content_hash=transaction["contentHash"],
            adapter_protocol="nir-application-adapter-v1",
            safety_policy_hash="c" * 64, authority_set_hash="d" * 64,
            evaluators=(AssignedEvaluator(evaluator_id, public_key),),
            expires_at_height=20,
        )
        self.proof = AssignmentChainProof(
            finality_proofs=({},), commitment_transaction=transaction,
            transaction_proof={}, transaction_block_height=10,
        )
        self.options = {
            "assignment": self.assignment, "proof": self.proof,
            "checkpoint": {}, "trusted_validators": [{}, {}, {}, {}],
            "expected_network_id": "nir-test", "expected_genesis_hash": "8" * 64,
        }

    def helper_result(self, **changes):
        result = {
            "candidateCommitmentIncluded": True,
            "chainAssignmentIncluded": False,
            "exactAssignmentIncluded": False,
            "finalizedHeight": 12,
            "finalizedStateRoot": "9" * 64,
            "transactionBlockHeight": 10,
            **changes,
        }
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"ok": True, "result": result}).encode("utf-8"),
        )

    def test_legacy_anchor_cannot_claim_exact_assignment_inclusion(self):
        with patch("nir.assignment_chain_proof.subprocess.run", return_value=self.helper_result(
            exactAssignmentIncluded=True,
        )):
            with self.assertRaisesRegex(ProtocolError, "invalid result"):
                verify_assignment_chain_anchor(**self.options)
        with patch("nir.assignment_chain_proof.subprocess.run", return_value=self.helper_result(
            chainAssignmentIncluded=True,
        )):
            with self.assertRaisesRegex(ProtocolError, "invalid result"):
                verify_assignment_chain_anchor(**self.options)

    def test_helper_result_must_repeat_the_exact_finality_anchor_and_height(self):
        variants = (
            {"finalizedHeight": 11},
            {"finalizedStateRoot": "0" * 64},
            {"transactionBlockHeight": 9},
            {"finalizedHeight": -1},
            {"finalizedStateRoot": "not-a-hash"},
        )
        for changed in variants:
            with self.subTest(changed=changed), patch(
                "nir.assignment_chain_proof.subprocess.run",
                return_value=self.helper_result(**changed),
            ):
                with self.assertRaisesRegex(ProtocolError, "invalid result"):
                    verify_assignment_chain_anchor(**self.options)

    def test_python_boundary_rejects_oversized_proof_and_trust_collections(self):
        oversized = AssignmentChainProof(
            finality_proofs=tuple({} for _ in range(MAX_FINALITY_PROOFS + 1)),
            commitment_transaction={}, transaction_proof={}, transaction_block_height=1,
        )
        with self.assertRaisesRegex(ProtocolError, "fields"):
            oversized.as_dict()
        with self.assertRaisesRegex(ProtocolError, "trust inputs"):
            verify_assignment_chain_anchor(**{**self.options, "trusted_validators": [{}, {}, {}]})
        with self.assertRaisesRegex(ProtocolError, "trust inputs"):
            verify_assignment_chain_anchor(**{
                **self.options, "handoffs": tuple({} for _ in range(257)),
            })


if __name__ == "__main__":
    unittest.main()

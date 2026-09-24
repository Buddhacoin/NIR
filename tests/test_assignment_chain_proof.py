from dataclasses import replace
import json
from pathlib import Path
import subprocess
import unittest

from nir.assignment_chain_proof import (
    AssignmentChainProof, LEGACY_PROOF_FORMAT, PROOF_FORMAT,
    verify_assignment_chain_anchor,
)
from nir.execution_receipt import (
    AssignedEvaluator, FinalizedEvaluationAssignment, authority_set_hash,
    evaluator_id_for_public_key,
)
from nir.model import ProtocolError
from nir.runner import CandidateCommitment


class AssignmentChainProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        helper = Path(__file__).parent / "assignment_chain_fixture.mjs"
        result = subprocess.run(
            ["node", str(helper)], check=True, stdout=subprocess.PIPE, text=True,
        )
        cls.fixture = json.loads(result.stdout)

    def setUp(self):
        value = self.fixture
        transaction = value["commitmentTransaction"]
        commitment = CandidateCommitment.from_dict({
            "artifact_hash": transaction["artifactHash"],
            "baseline_hash": transaction["baselineHash"],
            "baseline_content_hash": transaction["baselineContentHash"],
            "candidate_id": transaction["candidateId"],
            "committed_epoch": value["transactionBlockHeight"],
            "content_hash": transaction["contentHash"],
            "network_id": transaction["networkId"],
            "parents": transaction["parents"],
            "recipient": transaction["recipient"],
            "suite_commitment": transaction["suiteCommitment"],
        })
        evaluators = tuple(sorted((AssignedEvaluator(
            evaluator_id_for_public_key(item["publicKey"]), item["publicKey"],
        ) for item in value["evaluators"]), key=lambda item: item.evaluator_id))
        # Authority signatures are verified by the receipt layer. This proof
        # independently anchors only what current chain roots can demonstrate.
        self.assignment = FinalizedEvaluationAssignment(
            network_id=value["networkId"], genesis_hash=value["genesisHash"],
            candidate_commitment_hash=commitment.commitment_hash,
            candidate_id=transaction["candidateId"],
            finalized_height=value["finalizedHeight"],
            finalized_state_root=value["stateRoot"], challenge_seed=value["challengeSeed"],
            challenge_epoch=value["challengeEpoch"],
            environment_commitment="b" * 64, suite_commitment=transaction["suiteCommitment"],
            baseline_artifact_hash=transaction["baselineHash"],
            baseline_content_hash=transaction["baselineContentHash"],
            candidate_artifact_hash=transaction["artifactHash"],
            candidate_content_hash=transaction["contentHash"],
            adapter_protocol="nir-application-adapter-v1", safety_policy_hash="c" * 64,
            authority_set_hash=authority_set_hash({
                evaluator.evaluator_id: evaluator.public_key for evaluator in evaluators
            }),
            evaluators=evaluators, expires_at_height=value["finalizedHeight"] + 10,
        )
        self.proof = AssignmentChainProof(
            finality_proofs=tuple(value["finalityProofs"]),
            commitment_transaction=value["commitmentTransaction"],
            transaction_proof=value["transactionProof"],
            transaction_block_height=value["transactionBlockHeight"],
            consensus_assignment=value["consensusAssignment"],
            assignment_proof=value["assignmentProof"],
        )

    def verify(self, assignment=None, proof=None, checkpoint=None):
        return verify_assignment_chain_anchor(
            assignment=assignment or self.assignment, proof=proof or self.proof,
            checkpoint=checkpoint or self.fixture["checkpoint"],
            trusted_validators=self.fixture["trustedValidators"], handoffs=(),
            expected_network_id=self.fixture["networkId"],
            expected_genesis_hash=self.fixture["genesisHash"],
        )

    def test_finality_and_transaction_inclusion_are_proven_but_assignment_is_not(self):
        result = self.verify()
        self.assertTrue(result.candidate_commitment_included)
        self.assertTrue(result.chain_assignment_included)
        self.assertFalse(result.exact_assignment_included)
        self.assertIn("exact external assignment", result.consensus_gap)

        legacy_result = self.verify(proof=replace(
            self.proof, consensus_assignment=None, assignment_proof=None,
        ))
        self.assertFalse(legacy_result.chain_assignment_included)

        serialized = self.proof.as_dict()
        self.assertEqual(serialized["format"], PROOF_FORMAT)
        self.assertEqual(AssignmentChainProof.from_dict(serialized), self.proof)

    def test_proof_schema_is_exact_and_does_not_coerce(self):
        serialized = self.proof.as_dict()
        with self.assertRaises(ProtocolError):
            AssignmentChainProof.from_dict({**serialized, "unknown": True})
        with self.assertRaises(ProtocolError):
            AssignmentChainProof.from_dict({**serialized, "transactionBlockHeight": "2"})
        with self.assertRaises(ProtocolError):
            AssignmentChainProof.from_dict({**serialized, "transactionBlockHeight": True})

        legacy = {
            key: value for key, value in serialized.items()
            if key not in {"assignmentProof", "consensusAssignment"}
        }
        legacy["format"] = LEGACY_PROOF_FORMAT
        parsed = AssignmentChainProof.from_dict(legacy)
        self.assertIsNone(parsed.assignment_proof)
        self.assertIsNone(parsed.consensus_assignment)

    def test_forged_state_root_transaction_and_merkle_path_fail(self):
        with self.assertRaises(ProtocolError):
            self.verify(assignment=replace(self.assignment, finalized_state_root="f" * 64))
        forged_transaction = dict(self.proof.commitment_transaction)
        forged_transaction["contentHash"] = f"sha256:{'e' * 64}"
        with self.assertRaises(ProtocolError):
            self.verify(proof=replace(self.proof, commitment_transaction=forged_transaction))
        siblings = list(self.proof.transaction_proof["siblings"])
        if siblings:
            siblings[0] = "d" * 64
            bad_merkle = {**self.proof.transaction_proof, "siblings": siblings}
        else:
            bad_merkle = {**self.proof.transaction_proof, "index": 1}
        with self.assertRaises(ProtocolError):
            self.verify(proof=replace(self.proof, transaction_proof=bad_merkle))

    def test_wrong_checkpoint_network_and_commitment_hash_fail(self):
        checkpoint = {**self.fixture["checkpoint"], "tipHash": "0" * 64}
        with self.assertRaises(ProtocolError):
            self.verify(checkpoint=checkpoint)
        with self.assertRaises(ProtocolError):
            verify_assignment_chain_anchor(
                assignment=self.assignment, proof=self.proof,
                checkpoint=self.fixture["checkpoint"],
                trusted_validators=self.fixture["trustedValidators"],
                expected_network_id="wrong-network",
                expected_genesis_hash=self.fixture["genesisHash"],
            )
        with self.assertRaisesRegex(ProtocolError, "commitment hash"):
            self.verify(assignment=replace(self.assignment, candidate_commitment_hash="9" * 64))

        validators = [dict(item) for item in self.fixture["trustedValidators"]]
        validators[0]["publicKey"] = self.fixture["evaluators"][0]["publicKey"]
        with self.assertRaises(ProtocolError):
            verify_assignment_chain_anchor(
                assignment=self.assignment, proof=self.proof,
                checkpoint=self.fixture["checkpoint"], trusted_validators=validators,
                expected_network_id=self.fixture["networkId"],
                expected_genesis_hash=self.fixture["genesisHash"],
            )


if __name__ == "__main__":
    unittest.main()

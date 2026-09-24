import json
import os
from dataclasses import replace
from pathlib import Path
import subprocess
import unittest

from nir.assignment_chain_proof import (
    AssignmentChainProofV3,
    AssignmentChainProofV4,
    FinalityAnchor,
    PROOF_V3_FORMAT,
    verify_assignment_chain_anchor_v3,
)
from nir.execution_receipt import AssignedEvaluator, FinalizedEvaluationAssignmentV2
from nir.model import ProtocolError
from nir.runner import CandidateCommitment


class AssignmentChainProofV3Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        helper = Path(__file__).parent / "assignment_chain_fixture.mjs"
        environment = {**os.environ, "NIR_ASSIGNMENT_FIXTURE_V3": "1"}
        completed = subprocess.run(
            ["node", str(helper)], check=True, stdout=subprocess.PIPE, env=environment,
        )
        cls.fixture = json.loads(completed.stdout)
        completed_v4 = subprocess.run(
            ["node", str(helper)], check=True, stdout=subprocess.PIPE,
            env={**os.environ, "NIR_ASSIGNMENT_FIXTURE_V4": "1"},
        )
        cls.fixture_v4 = json.loads(completed_v4.stdout)

    def setUp(self):
        self._build(self.fixture)

    def _build(self, value, *, v4=False):
        transaction = value["commitmentTransaction"]
        leaf = value["consensusAssignment"]
        keys = {item["address"]: item["publicKey"] for item in value["evaluators"]}
        evaluators = tuple(AssignedEvaluator(item, keys[item]) for item in leaf["committee"])
        commitment = CandidateCommitment.from_dict({
            "artifact_hash": transaction["artifactHash"],
            "baseline_hash": transaction["baselineHash"],
            "baseline_content_hash": transaction["baselineContentHash"],
            "candidate_id": transaction["candidateId"],
            "committed_epoch": value["transactionBlockHeight"],
            "content_hash": transaction["contentHash"], "network_id": transaction["networkId"],
            "parents": transaction["parents"], "recipient": transaction["recipient"],
            "suite_commitment": transaction["suiteCommitment"],
        })
        self.assignment = FinalizedEvaluationAssignmentV2(
            network_id=value["networkId"], genesis_hash=value["genesisHash"],
            candidate_commitment_hash=commitment.commitment_hash,
            candidate_id=leaf["candidateId"],
            source_finality_height=leaf["sourceFinalityHeight"],
            source_finality_state_root=leaf["sourceFinalityStateRoot"],
            committed_height=leaf["committedHeight"], decision_height=leaf["challengeHeight"],
            challenge_seed=leaf["challengeSeed"], challenge_epoch=leaf["challengeEpoch"],
            environment_commitment=leaf["environmentCommitment"],
            suite_commitment=leaf["suiteCommitment"],
            baseline_artifact_hash=leaf["baselineHash"],
            baseline_content_hash=leaf["baselineContentHash"],
            candidate_artifact_hash=leaf["artifactHash"],
            candidate_content_hash=leaf["contentHash"],
            adapter_protocol=leaf["adapterProtocol"],
            safety_policy_hash=leaf["safetyPolicyHash"],
            authority_set_hash=leaf["authoritySetHash"], authority_mode=leaf["authorityMode"],
            recipient=leaf["recipient"], parents=tuple(leaf["parents"]),
            evaluators=evaluators, expires_at_height=leaf["expiresAtHeight"],
        )
        proof_type = AssignmentChainProofV4 if v4 else AssignmentChainProofV3
        proof_arguments = dict(
            finality_proofs=tuple(value["finalityProofs"]),
            commitment_transaction=transaction, transaction_proof=value["transactionProof"],
            transaction_block_height=value["transactionBlockHeight"],
            consensus_assignment=leaf, assignment_proof=value["assignmentProof"],
            source_anchor=FinalityAnchor.from_dict(value["sourceAnchor"]),
            decision_anchor=FinalityAnchor.from_dict(value["decisionAnchor"]),
            inclusion_anchor=FinalityAnchor.from_dict(value["inclusionAnchor"], inclusion=True),
        )
        if v4:
            proof_arguments["checkpoint_trust_package"] = value["checkpointTrustPackage"]
        self.proof = proof_type(**proof_arguments)

    def verify(self, assignment=None, proof=None, checkpoint=None, handoffs=()):
        return verify_assignment_chain_anchor_v3(
            assignment=assignment or self.assignment, proof=proof or self.proof,
            checkpoint=checkpoint or self.fixture["checkpoint"],
            trusted_validators=self.fixture["trustedValidators"], handoffs=handoffs,
            expected_network_id=self.fixture["networkId"],
            expected_genesis_hash=self.fixture["genesisHash"],
        )

    def test_exact_v27_assignment_preimage_and_three_anchors(self):
        result = self.verify()
        self.assertTrue(result.exact_assignment_included)
        self.assertEqual(result.consensus_gap, "")
        encoded = self.proof.as_dict()
        self.assertEqual(encoded["format"], PROOF_V3_FORMAT)
        self.assertEqual(AssignmentChainProofV3.from_dict(encoded), self.proof)
        self.assertEqual(
            FinalizedEvaluationAssignmentV2.from_dict(self.assignment.as_dict()), self.assignment,
        )
        self.assertRegex(self.assignment.assignment_hash, r"^[0-9a-f]{64}$")
        v4 = AssignmentChainProofV4(
            finality_proofs=self.proof.finality_proofs,
            commitment_transaction=self.proof.commitment_transaction,
            transaction_proof=self.proof.transaction_proof,
            transaction_block_height=self.proof.transaction_block_height,
            consensus_assignment=self.proof.consensus_assignment,
            assignment_proof=self.proof.assignment_proof,
            source_anchor=self.proof.source_anchor, decision_anchor=self.proof.decision_anchor,
            inclusion_anchor=self.proof.inclusion_anchor,
            checkpoint_trust_package={"format": "nir-checkpoint-trust-package-v1"},
        )
        self.assertEqual(AssignmentChainProofV4.from_dict(v4.as_dict()), v4)
        with self.assertRaisesRegex(ProtocolError, "checkpoint trust policy is required"):
            verify_assignment_chain_anchor_v3(
                assignment=self.assignment, proof=v4,
                checkpoint=self.fixture["checkpoint"], trusted_validators=(), handoffs=(),
                expected_network_id=self.fixture["networkId"],
                expected_genesis_hash=self.fixture["genesisHash"],
            )

    def test_v4_python_gate_uses_only_pinned_package_and_replay_floors(self):
        self._build(self.fixture_v4, v4=True)
        value = self.fixture_v4
        options = dict(
            assignment=self.assignment, proof=self.proof, checkpoint=value["checkpoint"],
            trusted_validators=(), handoffs=(), expected_network_id=value["networkId"],
            expected_genesis_hash=value["genesisHash"],
            expected_checkpoint_policy_id=value["checkpointTrustPolicyId"],
            minimum_checkpoint_height=value["minimumCheckpointHeight"],
            minimum_checkpoint_sequence=value["minimumCheckpointSequence"],
        )
        result = verify_assignment_chain_anchor_v3(**options)
        self.assertTrue(result.exact_assignment_included)
        with self.assertRaises(ProtocolError):
            verify_assignment_chain_anchor_v3(
                **{**options, "minimum_checkpoint_sequence":
                   value["minimumCheckpointSequence"] + 1},
            )
        with self.assertRaises(ProtocolError):
            verify_assignment_chain_anchor_v3(
                **{**options, "trusted_validators": value["trustedValidators"]},
            )

    def test_semantic_field_and_public_key_substitution_fail_closed(self):
        with self.assertRaises(ProtocolError):
            self.verify(replace(self.assignment, environment_commitment="0" * 64))
        with self.assertRaises(ProtocolError):
            self.verify(replace(self.assignment, recipient="nir1" + "0" * 64))
        replaced = list(self.assignment.evaluators)
        replaced[0] = replace(replaced[0], public_key=replaced[1].public_key)
        with self.assertRaises(ProtocolError):
            self.verify(replace(self.assignment, evaluators=tuple(replaced)))

    def test_source_decision_inclusion_replay_and_omission_fail(self):
        with self.assertRaises(ProtocolError):
            self.verify(proof=replace(
                self.proof, source_anchor=replace(self.proof.source_anchor, block_hash="0" * 64),
            ))
        with self.assertRaises(ProtocolError):
            self.verify(proof=replace(
                self.proof, decision_anchor=replace(self.proof.decision_anchor, state_root="0" * 64),
            ))
        with self.assertRaises(ProtocolError):
            self.verify(proof=replace(
                self.proof, inclusion_anchor=replace(
                    self.proof.inclusion_anchor, evaluation_assignment_root="0" * 64,
                ),
            ))
        without_source = tuple(
            item for item in self.proof.finality_proofs
            if item["header"]["height"] != self.proof.source_anchor.height
        )
        with self.assertRaises(ProtocolError):
            self.verify(proof=replace(self.proof, finality_proofs=without_source))
        non_genesis = {
            "height": self.proof.source_anchor.height,
            "protocolVersion": 27,
            "stateRoot": self.proof.source_anchor.state_root,
            "tipHash": self.proof.source_anchor.block_hash,
        }
        with self.assertRaises(ProtocolError):
            self.verify(checkpoint=non_genesis, proof=replace(
                self.proof,
                finality_proofs=tuple(item for item in self.proof.finality_proofs
                                      if item["header"]["height"] > non_genesis["height"]),
            ))
        with self.assertRaises(ProtocolError):
            self.verify(proof=replace(
                self.proof,
                decision_anchor=replace(
                    self.proof.decision_anchor, height=self.proof.decision_anchor.height + 1,
                ),
            ))

    def test_exact_schema_chronology_and_bounds(self):
        value = self.assignment.as_dict()
        with self.assertRaises(ProtocolError):
            FinalizedEvaluationAssignmentV2.from_dict({**value, "attestations": []})
        with self.assertRaises(ProtocolError):
            replace(self.assignment, expires_at_height=self.assignment.decision_height).payload()
        package = self.proof.as_dict()
        with self.assertRaises(ProtocolError):
            AssignmentChainProofV3.from_dict({**package, "unknown": True})
        with self.assertRaises(ProtocolError):
            replace(self.proof, finality_proofs=tuple({} for _ in range(513))).as_dict()


if __name__ == "__main__":
    unittest.main()

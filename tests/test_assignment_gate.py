import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from nir.assignment_gate import (
    AssignmentGateError,
    PACKAGE_FORMAT,
    POLICY_FORMAT,
    _read_bounded_json,
    current_replay_checkpoint,
    main,
    verify_assignment_package,
)
from nir.replay_store import ConsumedEvaluationStore
from nir.assignment_chain_proof import AssignmentChainProofV3, FinalityAnchor, PROOF_V3_FORMAT
from nir.execution_receipt import AssignedEvaluator, FinalizedEvaluationAssignmentV2
from nir.model import ProtocolError
from nir.runner import CandidateCommitment


class AssignmentGateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = self.root / "replay"
        self.package_path = self.root / "package.json"
        self.policy_path = self.root / "policy.json"
        self.package = {
            "assignment": {"fixture": "assignment"},
            "bundle": {"fixture": "bundle"},
            "chainProof": {"format": PROOF_V3_FORMAT},
            "format": PACKAGE_FORMAT,
            "receipts": [{"fixture": "baseline"}, {"fixture": "candidate"}],
        }
        checkpoint = current_replay_checkpoint(self.store)
        self.policy = {
            "expectedAdapterProtocol": "nir-jsonl-v1",
            "expectedGenesisHash": "1" * 64,
            "expectedNetworkId": "nir-test",
            "expectedSafetyPolicyHash": "2" * 64,
            "format": POLICY_FORMAT,
            "observedHeight": 11,
            "replayCheckpoint": checkpoint,
            "checkpoint": {},
            "trustedValidators": [{"operatorId": "operator-0"}] * 4,
            "handoffs": [],
        }
        self.write_inputs()

    def tearDown(self):
        self.temporary.cleanup()

    def write_inputs(self):
        self.package_path.write_text(json.dumps(self.package), encoding="utf-8")
        self.policy_path.write_text(json.dumps(self.policy), encoding="utf-8")

    @staticmethod
    def assignment_and_receipts():
        evaluator = "nir1" + "4" * 64
        assignment = SimpleNamespace(
            payload=lambda: {}, assignment_hash="5" * 64, candidate_id="6" * 64,
            challenge_seed="7" * 64, challenge_epoch=8,
            environment_commitment="8" * 64, suite_commitment="9" * 64,
            adapter_protocol="nir-jsonl-v1", safety_policy_hash="2" * 64,
            network_id="nir-test", genesis_hash="1" * 64,
            evaluators=(SimpleNamespace(evaluator_id=evaluator),),
        )
        receipt = lambda role: SimpleNamespace(
            payload=lambda: {}, assignment_hash=assignment.assignment_hash,
            candidate_id=assignment.candidate_id, challenge_seed=assignment.challenge_seed,
            challenge_epoch=assignment.challenge_epoch,
            environment_commitment=assignment.environment_commitment,
            suite_commitment=assignment.suite_commitment,
            adapter_protocol=assignment.adapter_protocol,
            safety_policy_hash=assignment.safety_policy_hash,
            evaluator_id=evaluator, role=role,
        )
        return assignment, (receipt("baseline"), receipt("candidate"))

    def parser_patches(self):
        assignment, receipts = self.assignment_and_receipts()
        return assignment, receipts, (
            patch("nir.assignment_gate.FinalizedEvaluationAssignmentV2.from_dict", return_value=assignment),
            patch("nir.assignment_gate.AssignmentChainProofV3.from_dict", return_value=SimpleNamespace()),
            patch(
                "nir.assignment_gate.EvaluationBundle.from_dict",
                return_value=SimpleNamespace(bundle_hash="a" * 64),
            ),
            patch("nir.assignment_gate.SignedExecutionTranscript.from_dict", side_effect=receipts),
            patch("nir.assignment_gate.verify_assignment_chain_anchor_v3", return_value=SimpleNamespace(
                exact_assignment_included=True, assignment_hash=assignment.assignment_hash,
            )),
        )

    def real_chain_inputs(self):
        helper = Path(__file__).parent / "assignment_chain_fixture.mjs"
        completed = subprocess.run(
            ["node", str(helper)], check=True, stdout=subprocess.PIPE,
            env={**os.environ, "NIR_ASSIGNMENT_FIXTURE_V3": "1"},
        )
        value = json.loads(completed.stdout)
        transaction = value["commitmentTransaction"]
        leaf = value["consensusAssignment"]
        keys = {item["address"]: item["publicKey"] for item in value["evaluators"]}
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
        assignment = FinalizedEvaluationAssignmentV2(
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
            evaluators=tuple(AssignedEvaluator(item, keys[item]) for item in leaf["committee"]),
            expires_at_height=leaf["expiresAtHeight"],
        )
        proof = AssignmentChainProofV3(
            finality_proofs=tuple(value["finalityProofs"]),
            commitment_transaction=transaction, transaction_proof=value["transactionProof"],
            transaction_block_height=value["transactionBlockHeight"],
            consensus_assignment=leaf, assignment_proof=value["assignmentProof"],
            source_anchor=FinalityAnchor.from_dict(value["sourceAnchor"]),
            decision_anchor=FinalityAnchor.from_dict(value["decisionAnchor"]),
            inclusion_anchor=FinalityAnchor.from_dict(value["inclusionAnchor"], inclusion=True),
        )
        self.package["assignment"] = assignment.as_dict()
        self.package["chainProof"] = proof.as_dict()
        self.package["receipts"] = [{"fixture": "baseline"}]
        self.policy.update({
            "checkpoint": value["checkpoint"],
            "expectedAdapterProtocol": assignment.adapter_protocol,
            "expectedGenesisHash": value["genesisHash"],
            "expectedNetworkId": value["networkId"],
            "expectedSafetyPolicyHash": assignment.safety_policy_hash,
            "observedHeight": assignment.decision_height,
            "trustedValidators": value["trustedValidators"],
        })
        self.write_inputs()
        return assignment

    def test_real_exact_proof_is_required_before_replay_consumption(self):
        assignment = self.real_chain_inputs()
        with patch("nir.assignment_gate.EvaluationBundle.from_dict", return_value=SimpleNamespace(
            bundle_hash="a" * 64,
        )), patch("nir.assignment_gate.SignedExecutionTranscript.from_dict", side_effect=lambda _:
            SimpleNamespace(payload=lambda: {}, assignment_hash=assignment.assignment_hash,
                            candidate_id=assignment.candidate_id,
                            challenge_seed=assignment.challenge_seed,
                            challenge_epoch=assignment.challenge_epoch,
                            environment_commitment=assignment.environment_commitment,
                            suite_commitment=assignment.suite_commitment,
                            adapter_protocol=assignment.adapter_protocol,
                            safety_policy_hash=assignment.safety_policy_hash,
                            evaluator_id=assignment.evaluators[0].evaluator_id,
                            role="baseline")
        ), patch("nir.execution_receipt._verify_execution_receipt_bindings") as verify:
            # A missing proof and a foreign trusted genesis both fail before receipt verification.
            proof = self.package.pop("chainProof")
            self.write_inputs()
            with self.assertRaises(AssignmentGateError):
                verify_assignment_package(package_path=self.package_path,
                                          policy_path=self.policy_path, replay_store=self.store)
            self.package["chainProof"] = proof
            self.policy["expectedGenesisHash"] = "0" * 64
            self.write_inputs()
            with self.assertRaises(ProtocolError):
                verify_assignment_package(package_path=self.package_path,
                                          policy_path=self.policy_path, replay_store=self.store)
            self.assertEqual(current_replay_checkpoint(self.store)["generation"], 0)
            verify.assert_not_called()

            self.policy["expectedGenesisHash"] = assignment.genesis_hash
            self.write_inputs()
            result = verify_assignment_package(package_path=self.package_path,
                                               policy_path=self.policy_path, replay_store=self.store)
            self.assertTrue(result["chainInclusionVerified"])
            self.assertEqual(result["replayCheckpoint"]["generation"], 1)
            self.assertEqual(verify.call_args.kwargs["assignment"].assignment_hash,
                             assignment.assignment_hash)

    def test_verified_package_advances_replay_state_and_returns_only_public_metadata(self):
        assignment, receipts, patches = self.parser_patches()
        with patches[0], patches[1], patches[2], patches[3], patches[4], patch(
            "nir.execution_receipt._verify_execution_receipt_bindings",
        ) as verify:
            result = verify_assignment_package(
                package_path=self.package_path, policy_path=self.policy_path,
                replay_store=self.store,
            )
        self.assertFalse(result["adapterLaunchAuthorized"])
        self.assertTrue(result["packageVerified"])
        self.assertTrue(result["chainInclusionVerified"])
        self.assertFalse(result["chainMutation"])
        self.assertEqual(result["receiptCount"], 2)
        self.assertEqual(result["replayCheckpoint"]["generation"], 1)
        verify.assert_called_once()
        serialized = json.dumps(result)
        self.assertNotIn("operator-0", serialized)
        self.assertNotIn(str(self.package_path), serialized)
        with ConsumedEvaluationStore(
            self.store,
            expected_checkpoint=(
                result["replayCheckpoint"]["generation"],
                result["replayCheckpoint"]["stateHash"],
            ),
        ) as reopened:
            self.assertEqual(reopened.checkpoint[0], 1)

    def test_failed_verification_does_not_advance_replay_state(self):
        _assignment, _receipts, patches = self.parser_patches()
        with patches[0], patches[1], patches[2], patches[3], patches[4], patch(
            "nir.execution_receipt._verify_execution_receipt_bindings",
            side_effect=ValueError("signature rejected"),
        ):
            with self.assertRaises(ValueError):
                verify_assignment_package(
                    package_path=self.package_path, policy_path=self.policy_path,
                    replay_store=self.store,
                )
        self.assertEqual(current_replay_checkpoint(self.store)["generation"], 0)

    def test_stale_external_checkpoint_fails_closed(self):
        with ConsumedEvaluationStore(self.store) as store:
            store.consume("a" * 64)
        _assignment, _receipts, patches = self.parser_patches()
        with patches[0], patches[1], patches[2], patches[3], patches[4], patch(
            "nir.execution_receipt._verify_execution_receipt_bindings",
        ) as verify:
            with self.assertRaisesRegex(Exception, "rollback"):
                verify_assignment_package(
                    package_path=self.package_path, policy_path=self.policy_path,
                    replay_store=self.store,
                )
        verify.assert_not_called()

    def test_strict_reader_rejects_duplicate_keys_links_and_oversize(self):
        duplicate = self.root / "duplicate.json"
        duplicate.write_text('{"a":1,"a":2}', encoding="utf-8")
        with self.assertRaisesRegex(AssignmentGateError, "duplicate"):
            _read_bounded_json(duplicate, limit=100)
        duplicate.write_text('{"value":NaN}', encoding="utf-8")
        with self.assertRaisesRegex(AssignmentGateError, "non-finite"):
            _read_bounded_json(duplicate, limit=100)
        linked = self.root / "linked.json"
        linked.hardlink_to(self.package_path)
        with self.assertRaisesRegex(AssignmentGateError, "regular file"):
            _read_bounded_json(linked, limit=10_000)
        with self.assertRaisesRegex(AssignmentGateError, "bounded"):
            _read_bounded_json(duplicate, limit=2)

    def test_cli_json_failure_is_stable_and_does_not_echo_paths_or_input(self):
        output = io.StringIO()
        with patch("sys.stdout", output):
            code = main([
                "verify", "--package", str(self.root / "missing-secret-name.json"),
                "--policy", str(self.policy_path), "--replay-store", str(self.store), "--json",
            ])
        self.assertEqual(code, 2)
        result = json.loads(output.getvalue())
        self.assertEqual(result["error"], "PACKAGE_VERIFICATION_FAILED")
        self.assertFalse(result["adapterLaunchAuthorized"])
        self.assertNotIn("missing-secret-name", output.getvalue())

    def test_cli_rejects_secret_or_unknown_policy_fields(self):
        self.policy["privateKey"] = "do-not-read-this"
        self.write_inputs()
        output = io.StringIO()
        with patch("sys.stdout", output):
            code = main([
                "verify", "--package", str(self.package_path), "--policy", str(self.policy_path),
                "--replay-store", str(self.store), "--json",
            ])
        self.assertEqual(code, 2)
        self.assertNotIn("do-not-read-this", output.getvalue())

    def test_cli_sanitizes_unexpected_verifier_failure(self):
        _assignment, _receipts, patches = self.parser_patches()
        output = io.StringIO()
        with patches[0], patches[1], patches[2], patches[3], patches[4], patch(
            "nir.execution_receipt._verify_execution_receipt_bindings",
            side_effect=RuntimeError("secret subprocess diagnostic"),
        ), patch("sys.stdout", output):
            code = main([
                "verify", "--package", str(self.package_path), "--policy", str(self.policy_path),
                "--replay-store", str(self.store), "--json",
            ])
        self.assertEqual(code, 2)
        result = json.loads(output.getvalue())
        self.assertEqual(result["error"], "INTERNAL_VERIFICATION_ERROR")
        self.assertNotIn("secret subprocess diagnostic", output.getvalue())


if __name__ == "__main__":
    unittest.main()

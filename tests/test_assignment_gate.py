import io
import json
from pathlib import Path
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
            "trustedAuthorities": {"nir1" + "3" * 64: "public-key-only"},
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
            patch("nir.assignment_gate.FinalizedEvaluationAssignment.from_dict", return_value=assignment),
            patch(
                "nir.assignment_gate.EvaluationBundle.from_dict",
                return_value=SimpleNamespace(bundle_hash="a" * 64),
            ),
            patch("nir.assignment_gate.SignedExecutionTranscript.from_dict", side_effect=receipts),
        )

    def test_verified_package_advances_replay_state_and_returns_only_public_metadata(self):
        assignment, receipts, patches = self.parser_patches()
        with patches[0], patches[1], patches[2], patch(
            "nir.execution_receipt.verify_execution_receipts",
        ) as verify:
            result = verify_assignment_package(
                package_path=self.package_path, policy_path=self.policy_path,
                replay_store=self.store,
            )
        self.assertFalse(result["adapterLaunchAuthorized"])
        self.assertTrue(result["packageVerified"])
        self.assertFalse(result["chainInclusionVerified"])
        self.assertFalse(result["chainMutation"])
        self.assertEqual(result["receiptCount"], 2)
        self.assertEqual(result["replayCheckpoint"]["generation"], 1)
        verify.assert_called_once()
        serialized = json.dumps(result)
        self.assertNotIn("public-key-only", serialized)
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
        with patches[0], patches[1], patches[2], patch(
            "nir.execution_receipt.verify_execution_receipts",
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
        with patches[0], patches[1], patches[2], patch(
            "nir.execution_receipt.verify_execution_receipts",
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
        with patches[0], patches[1], patches[2], patch(
            "nir.execution_receipt.verify_execution_receipts",
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

import base64
from dataclasses import replace
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from nir.execution_receipt import (
    AssignedEvaluator,
    FinalizedEvaluationAssignment,
    SignedExecutionTranscript,
    evaluator_id_for_public_key,
)
from nir.model import ProtocolError
from nir.replay_store import (
    assignment_transcript_replay_key,
    ChallengeAlreadyConsumed,
    ConsumedEvaluationStore,
    DurableAssignmentReceiptReplayGuard,
    DurableChallengeReplayGuard,
    ReplayStoreError,
    _new_state,
)


KEY_A = "a" * 64
KEY_B = "b" * 64


def consume_in_process(root: str, key: str, gate, output) -> None:
    gate.wait()
    try:
        with ConsumedEvaluationStore(root) as store:
            store.consume(key)
        output.put("consumed")
    except ChallengeAlreadyConsumed:
        output.put("duplicate")
    except Exception as error:
        output.put(f"error:{type(error).__name__}:{error}")


class ConsumedEvaluationStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "replay"

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def assignment_and_receipt(role="candidate"):
        public_key = base64.b64encode(b"evaluator-public-key" * 80).decode("ascii")
        evaluator_id = evaluator_id_for_public_key(public_key)
        assignment = FinalizedEvaluationAssignment(
            network_id="nir-test", genesis_hash="1" * 64,
            candidate_commitment_hash="2" * 64, candidate_id="3" * 64,
            finalized_height=10, finalized_state_root="4" * 64,
            challenge_seed="5" * 64, challenge_epoch=8,
            environment_commitment="6" * 64, suite_commitment="7" * 64,
            baseline_artifact_hash="sha256:" + "8" * 64,
            baseline_content_hash="sha256:" + "9" * 64,
            candidate_artifact_hash="sha256:" + "a" * 64,
            candidate_content_hash="sha256:" + "b" * 64,
            adapter_protocol="nir-jsonl-v1", safety_policy_hash="c" * 64,
            authority_set_hash="d" * 64,
            evaluators=(AssignedEvaluator(evaluator_id, public_key),),
            expires_at_height=20,
        )
        receipt = SignedExecutionTranscript(
            assignment_hash=assignment.assignment_hash,
            candidate_id=assignment.candidate_id,
            execution_bundle_hash="e" * 64, transcript_hash="f" * 64,
            role=role, challenge_seed=assignment.challenge_seed,
            challenge_epoch=assignment.challenge_epoch,
            environment_commitment=assignment.environment_commitment,
            suite_commitment=assignment.suite_commitment,
            adapter_protocol=assignment.adapter_protocol,
            safety_policy_hash=assignment.safety_policy_hash,
            evaluator_id=evaluator_id,
            signature=base64.b64encode(b"signature" * 300).decode("ascii"),
        )
        return assignment, receipt

    def test_consume_survives_restart_and_rejects_local_duplicate(self):
        with ConsumedEvaluationStore(self.root) as store:
            initial = store.checkpoint
            checkpoint = store.consume(KEY_A)
            self.assertEqual(initial[0], 0)
            self.assertEqual(checkpoint[0], 1)
        with ConsumedEvaluationStore(self.root) as restarted:
            self.assertEqual(restarted.checkpoint, checkpoint)
            with self.assertRaisesRegex(ChallengeAlreadyConsumed, "already consumed"):
                restarted.consume(KEY_A)

    def test_one_crash_stale_copy_is_repaired_from_the_adjacent_hash_chain(self):
        with ConsumedEvaluationStore(self.root) as store:
            old = (self.root / "consumed-a.json").read_bytes()
            checkpoint = store.consume(KEY_A)
        (self.root / "consumed-a.json").write_bytes(old)
        with ConsumedEvaluationStore(self.root) as recovered:
            self.assertEqual(recovered.checkpoint, checkpoint)
        self.assertEqual(
            (self.root / "consumed-a.json").read_bytes(),
            (self.root / "consumed-b.json").read_bytes(),
        )

    def test_divergence_and_externally_anchored_rollback_fail_closed(self):
        with ConsumedEvaluationStore(self.root) as store:
            old_a = (self.root / "consumed-a.json").read_bytes()
            old_b = (self.root / "consumed-b.json").read_bytes()
            checkpoint = store.consume(KEY_A)
        divergent = _new_state([KEY_B], 1, json.loads(old_a)["stateHash"])
        (self.root / "consumed-b.json").write_text(json.dumps(divergent), encoding="utf-8")
        with self.assertRaisesRegex(ReplayStoreError, "diverged"):
            ConsumedEvaluationStore(self.root)

        (self.root / "consumed-a.json").write_bytes(old_a)
        (self.root / "consumed-b.json").write_bytes(old_b)
        with self.assertRaisesRegex(ReplayStoreError, "rollback"):
            ConsumedEvaluationStore(self.root, expected_checkpoint=checkpoint)

    def test_links_and_root_replacement_fail_closed(self):
        with ConsumedEvaluationStore(self.root) as store:
            store.consume(KEY_A)
        outside = Path(self.temporary.name) / "outside"
        outside.write_text("{}", encoding="utf-8")
        (self.root / "consumed-a.json").unlink()
        (self.root / "consumed-a.json").symlink_to(outside)
        with self.assertRaises(ReplayStoreError):
            ConsumedEvaluationStore(self.root)

        root_two = Path(self.temporary.name) / "root-two"
        store = ConsumedEvaluationStore(root_two)
        displaced = Path(self.temporary.name) / "displaced"
        root_two.rename(displaced)
        root_two.mkdir()
        try:
            with self.assertRaisesRegex(ReplayStoreError, "replaced"):
                store.consume(KEY_B)
        finally:
            store.close()

    def test_hardlinked_copy_is_never_repaired_through(self):
        with ConsumedEvaluationStore(self.root) as store:
            store.consume(KEY_A)
        outside = Path(self.temporary.name) / "hardlink"
        os.link(self.root / "consumed-a.json", outside)
        with self.assertRaisesRegex(ReplayStoreError, "unsafe"):
            ConsumedEvaluationStore(self.root)

    def test_concurrent_consumers_commit_once(self):
        context = multiprocessing.get_context("spawn")
        gate = context.Event()
        output = context.Queue()
        processes = [
            context.Process(target=consume_in_process, args=(str(self.root), KEY_A, gate, output))
            for _ in range(2)
        ]
        for process in processes:
            process.start()
        gate.set()
        for process in processes:
            process.join(10)
            self.assertEqual(process.exitcode, 0)
        self.assertEqual(sorted([output.get(timeout=2), output.get(timeout=2)]), ["consumed", "duplicate"])
        with ConsumedEvaluationStore(self.root) as store:
            self.assertEqual(store.checkpoint[0], 1)

    def test_bundle_guard_verifies_before_durable_consume(self):
        bundle = SimpleNamespace(
            challenge_epoch=8,
            challenge_seed="d" * 64,
            commitment=SimpleNamespace(commitment_hash="e" * 64, network_id="nir-testnet"),
        )
        with ConsumedEvaluationStore(self.root) as store:
            guard = DurableChallengeReplayGuard(store)
            with patch("nir.runner.verify_bundle") as verify, patch(
                "nir.runner._hash_object", return_value=KEY_A,
            ):
                self.assertEqual(guard.consume(bundle), KEY_A)
                verify.assert_called_once_with(bundle)
                with self.assertRaises(ChallengeAlreadyConsumed):
                    guard.consume(bundle)

    def test_assignment_transcript_key_has_every_required_domain(self):
        assignment, receipt = self.assignment_and_receipt()
        original = assignment_transcript_replay_key(assignment, receipt)
        other_public_key = base64.b64encode(b"other-evaluator-key" * 80).decode("ascii")
        other_evaluator_id = evaluator_id_for_public_key(other_public_key)
        other_evaluator = AssignedEvaluator(other_evaluator_id, other_public_key)
        changed_network = replace(assignment, network_id="nir-other")
        changed_genesis = replace(assignment, genesis_hash="0" * 64)
        changed_assignment = replace(assignment, finalized_state_root="0" * 64)
        changed_candidate = replace(assignment, candidate_id="0" * 64)
        changed_evaluator = replace(assignment, evaluators=(other_evaluator,))
        variants = (
            (changed_network, replace(receipt, assignment_hash=changed_network.assignment_hash)),
            (changed_genesis, replace(receipt, assignment_hash=changed_genesis.assignment_hash)),
            (changed_assignment, replace(receipt, assignment_hash=changed_assignment.assignment_hash)),
            (changed_candidate, replace(
                receipt, assignment_hash=changed_candidate.assignment_hash,
                candidate_id=changed_candidate.candidate_id,
            )),
            (changed_evaluator, replace(
                receipt, assignment_hash=changed_evaluator.assignment_hash,
                evaluator_id=other_evaluator_id,
            )),
            (assignment, replace(receipt, role="baseline")),
        )
        for changed_assignment, changed_receipt in variants:
            with self.subTest(role=changed_receipt.role, network=changed_assignment.network_id):
                self.assertNotEqual(
                    assignment_transcript_replay_key(changed_assignment, changed_receipt), original,
                )

        with self.assertRaisesRegex(ReplayStoreError, "does not match"):
            assignment_transcript_replay_key(
                assignment, replace(receipt, candidate_id="0" * 64),
            )

    def test_assignment_receipt_guard_verifies_then_atomically_consumes_all_roles(self):
        assignment, candidate = self.assignment_and_receipt()
        receipts = (replace(candidate, role="baseline"), candidate)
        arguments = {
            "assignment": assignment, "bundle": object(), "receipts": receipts,
            "trusted_authorities": {"authority": "public-key"},
            "expected_network_id": "nir-test", "expected_genesis_hash": "1" * 64,
            "expected_adapter_protocol": "nir-jsonl-v1",
            "expected_safety_policy_hash": "c" * 64,
            "observed_height": 11,
        }
        with ConsumedEvaluationStore(self.root) as store:
            guard = DurableAssignmentReceiptReplayGuard(store)
            with patch("nir.execution_receipt.verify_execution_receipts") as execution:
                keys = guard.consume(**arguments)
                self.assertEqual(len(keys), 2)
                execution.assert_called_once_with(
                    assignment=assignment, bundle=arguments["bundle"], receipts=receipts,
                    observed_height=11,
                    trusted_authorities=arguments["trusted_authorities"],
                    expected_network_id="nir-test", expected_genesis_hash="1" * 64,
                    expected_adapter_protocol="nir-jsonl-v1",
                    expected_safety_policy_hash="c" * 64,
                )
                with self.assertRaises(ChallengeAlreadyConsumed):
                    guard.consume(**arguments)
            self.assertEqual(store.checkpoint[0], 1)

    def test_assignment_guard_verification_failure_consumes_nothing(self):
        assignment = SimpleNamespace()
        arguments = {
            "assignment": assignment, "bundle": object(), "receipts": (),
            "trusted_authorities": {},
            "expected_network_id": "nir-test", "expected_genesis_hash": "7" * 64,
            "expected_adapter_protocol": "nir-jsonl-v1",
            "expected_safety_policy_hash": "c" * 64,
            "observed_height": 11,
        }
        with ConsumedEvaluationStore(self.root) as store:
            guard = DurableAssignmentReceiptReplayGuard(store)
            with patch(
                "nir.execution_receipt.verify_execution_receipts",
                side_effect=ProtocolError("invalid finalized assignment"),
            ):
                with self.assertRaisesRegex(ProtocolError, "invalid finalized"):
                    guard.consume(**arguments)
            self.assertEqual(store.checkpoint[0], 0)

    def test_consume_many_is_atomic_when_one_key_was_already_used(self):
        with ConsumedEvaluationStore(self.root) as store:
            store.consume(KEY_A)
            with self.assertRaises(ChallengeAlreadyConsumed):
                store.consume_many([KEY_A, KEY_B])
            self.assertEqual(store.checkpoint[0], 1)
            store.consume(KEY_B)
            self.assertEqual(store.checkpoint[0], 2)


if __name__ == "__main__":
    unittest.main()

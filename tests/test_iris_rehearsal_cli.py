"""The app's fixed-model path must fail closed before launching changed code."""

from pathlib import Path
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from nir import iris_rehearsal


class IrisRehearsalCliTests(unittest.TestCase):
    def test_portable_evidence_replays_exact_pinned_model_without_reward_claim(self):
        evidence = iris_rehearsal.export_pinned_iris_evidence()
        self.assertEqual(evidence["format"], "nir-local-iris-evidence-v1")
        self.assertEqual(evidence["summary"]["bundleHash"], evidence["bundle"]["bundle_hash"])
        self.assertFalse(evidence["summary"]["independentOperators"])
        self.assertFalse(evidence["summary"]["rewardCredited"])
        raw = json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode()
        self.assertLessEqual(len(raw), iris_rehearsal.MAX_EVIDENCE_BYTES)
        result = iris_rehearsal.verify_pinned_iris_evidence(raw)
        self.assertEqual(result["status"], "local-iris-evidence-matched")
        self.assertFalse(result["independentlyVerified"])
        self.assertFalse(result["rewardEligible"])

    def test_portable_evidence_rejects_tampering_duplicates_and_oversize(self):
        evidence = iris_rehearsal.export_pinned_iris_evidence()
        for field, value in (("candidateAccuracyBps", 10_000), ("rewardCredited", True),
                             ("rewardCredited", 0), ("bundleVerified", 1),
                             ("caseCount", 30.0)):
            changed = json.loads(json.dumps(evidence))
            changed["summary"][field] = value
            with self.assertRaises(ValueError):
                iris_rehearsal.verify_pinned_iris_evidence(json.dumps(changed).encode())
        changed = json.loads(json.dumps(evidence))
        changed["bundle"]["commitment"]["recipient"] = "nir1forged"
        with self.assertRaises(ValueError):
            iris_rehearsal.verify_pinned_iris_evidence(json.dumps(changed).encode())
        with patch.object(iris_rehearsal, "_run_pinned_iris", side_effect=AssertionError("model started")):
            for raw in (b'{"format":"one","format":"two"}',
                        b" " * (iris_rehearsal.MAX_EVIDENCE_BYTES + 1),
                        b'{"format":NaN}'):
                with self.assertRaises(ValueError):
                    iris_rehearsal.verify_pinned_iris_evidence(raw)

    def test_preflight_checks_fixed_inputs_without_running_model(self):
        with patch.object(
            iris_rehearsal, "ApplicationAdapter", side_effect=AssertionError("model started")
        ):
            dataset, adapter = iris_rehearsal.check_pinned_iris_runtime()
        self.assertGreater(len(dataset), 0)
        self.assertGreater(len(adapter), 0)

    def test_runs_real_pinned_model_and_verifies_bundle(self):
        result = iris_rehearsal.run_pinned_iris_evaluation()
        self.assertEqual(result["baselineAccuracyBps"], 9000)
        self.assertEqual(result["candidateAccuracyBps"], 9666)
        self.assertTrue(result["bundleVerified"])
        self.assertFalse(result["energyAttested"])
        self.assertFalse(result["networkSubmitted"])
        self.assertFalse(result["rewardCredited"])

    def test_changed_adapter_is_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            changed = Path(directory) / "adapter.py"
            changed.write_text("raise RuntimeError('should not run')\n", encoding="utf-8")
            with patch.object(iris_rehearsal, "ADAPTER", changed), patch.object(
                iris_rehearsal, "ApplicationAdapter", side_effect=AssertionError("executed changed code")
            ):
                with self.assertRaisesRegex(ValueError, "adapter digest"):
                    iris_rehearsal.run_pinned_iris_evaluation()

    def test_changed_dataset_is_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            changed = Path(directory) / "iris.data"
            changed.write_text("not an Iris dataset\n", encoding="utf-8")
            with patch.object(iris_rehearsal, "DATASET", changed), patch.object(
                iris_rehearsal, "ApplicationAdapter", side_effect=AssertionError("executed changed code")
            ):
                with self.assertRaisesRegex(ValueError, "dataset digest"):
                    iris_rehearsal.run_pinned_iris_evaluation()

    def test_oversized_adapter_is_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            changed = Path(directory) / "adapter.py"
            changed.write_bytes(b"x" * 100_001)
            with patch.object(iris_rehearsal, "ADAPTER", changed), patch.object(
                iris_rehearsal, "ApplicationAdapter", side_effect=AssertionError("executed changed code")
            ):
                with self.assertRaisesRegex(ValueError, "bounded regular file"):
                    iris_rehearsal.run_pinned_iris_evaluation()

    def test_symlinked_adapter_is_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            link = Path(directory) / "adapter.py"
            link.symlink_to(iris_rehearsal.ADAPTER)
            with patch.object(iris_rehearsal, "ADAPTER", link), patch.object(
                iris_rehearsal, "ApplicationAdapter", side_effect=AssertionError("executed changed code")
            ):
                with self.assertRaises(OSError):
                    iris_rehearsal.run_pinned_iris_evaluation()

    def test_fifo_adapter_is_rejected_without_waiting_for_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            fifo = Path(directory) / "adapter.py"
            os.mkfifo(fifo)
            with patch.object(iris_rehearsal, "ADAPTER", fifo), patch.object(
                iris_rehearsal, "ApplicationAdapter", side_effect=AssertionError("executed changed code")
            ):
                with self.assertRaisesRegex(ValueError, "bounded regular file"):
                    iris_rehearsal.run_pinned_iris_evaluation()


if __name__ == "__main__":
    unittest.main()

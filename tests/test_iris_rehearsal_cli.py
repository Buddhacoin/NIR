"""The app's fixed-model path must fail closed before launching changed code."""

from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

from nir import iris_rehearsal


class IrisRehearsalCliTests(unittest.TestCase):
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

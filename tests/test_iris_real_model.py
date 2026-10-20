"""An actual trained-model rehearsal through the experimental application runner.

Iris is a small supervised-classification benchmark, not an intelligence or
production mining claim. Labels are public and processes are not isolated.
"""

import csv
from hashlib import sha256
from pathlib import Path
import sys
import tempfile
import unittest

from nir.application_adapter import AdapterError, ApplicationAdapter, FORMAT
from nir.evaluator import BenchmarkSuite
from nir.runner import (
    ApplicationCaseInput,
    CandidateCommitment,
    EnvironmentManifest,
    application_content_hash,
    create_application_bundle,
    run_application_adapter,
    verify_bundle,
)


ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "examples" / "iris.data"
ADAPTER = ROOT / "examples" / "iris_model_adapter.py"
DATA_SHA256 = "596ffd580471ca4d4880f8e439c7281f3b50d8249a5960353cb200b1490f63a0"


def digest(text: str) -> str:
    return f"sha256:{sha256(text.encode('utf-8')).hexdigest()}"


class IrisRealModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.assertion_data = DATASET.read_bytes()
        assert sha256(cls.assertion_data).hexdigest() == DATA_SHA256
        cls.rows = [row for row in csv.reader(cls.assertion_data.decode("ascii").splitlines())]
        assert len(cls.rows) == 150
        cls.held_out = [(index, row) for index, row in enumerate(cls.rows) if index % 5 == 0]
        cls.suite = BenchmarkSuite.from_dict({
            "name": "iris-3-class-held-out-local-rehearsal",
            "cases": [{
                "id": f"iris-{index:03d}", "family": "flower-classification",
                "expected": row[4],
            } for index, row in cls.held_out],
        })
        cls.inputs = {
            f"iris-{index:03d}": ApplicationCaseInput(
                media_type="application/json", value=[float(item) for item in row[:4]],
            ) for index, row in cls.held_out
        }
        cls.entrypoint_digest = f"sha256:{sha256(ADAPTER.read_bytes()).hexdigest()}"
        cls.content_hashes = {
            role: application_content_hash(
                role=role, entrypoint_path="bin/iris_model_adapter.py",
                entrypoint_digest=cls.entrypoint_digest,
            ) for role in ("baseline", "candidate")
        }
        cls.artifact_hashes = {
            role: digest(f"{role}\0{DATA_SHA256}\0{cls.entrypoint_digest}")
            for role in ("baseline", "candidate")
        }
        cls.salt = "iris-2026-local-rehearsal-salt"
        cls.challenge_seed = sha256(b"iris-local-challenge-2026").hexdigest()
        cls.environment = EnvironmentManifest.from_dict({
            "format": "nir-evaluation-environment-v1",
            "image_digest": digest("unattested-local-python"),
            "runner_digest": digest("nir-experimental-application-runner"),
            "adapter_protocol": FORMAT,
            "cpu_limit": 2,
            "memory_limit_bytes": 1 << 30,
            "timeout_seconds": 60,
        })
        cls.commitment = CandidateCommitment(
            network_id="nir-local-rehearsal",
            recipient="nir1local-rehearsal-only",
            candidate_id=sha256(b"iris-candidate-local-2026").hexdigest(),
            artifact_hash=cls.artifact_hashes["candidate"],
            baseline_hash=cls.artifact_hashes["baseline"],
            baseline_content_hash=cls.content_hashes["baseline"],
            content_hash=cls.content_hashes["candidate"],
            parents=(cls.artifact_hashes["baseline"],),
            suite_commitment=cls.suite.commitment(cls.salt),
            committed_epoch=10,
        )

    def application(self, role: str):
        return ApplicationAdapter([
            sys.executable, "-I", str(ADAPTER), role, str(DATASET), self.entrypoint_digest,
        ], measured_entrypoint=ADAPTER)

    def transcript(self, role: str, verifier: str):
        with self.application(role) as application:
            return run_application_adapter(
                application=application,
                artifact_hash=self.artifact_hashes[role],
                expected_content_hash=self.content_hashes[role],
                entrypoint_digest=self.entrypoint_digest,
                entrypoint_path="bin/iris_model_adapter.py",
                suite=self.suite,
                case_inputs=self.inputs,
                role=role,
                verifier_id=verifier,
                run_id=f"iris-{role}-{verifier}",
                challenge_seed=self.challenge_seed,
                challenge_epoch=11,
                environment=self.environment,
                energy_wh=100,
                energy_attested=False,
                case_timeout_ms=1_000,
            )

    def test_model_predictions_depend_on_features_not_case_id(self):
        setosa = [float(value) for value in self.rows[0][:4]]
        virginica = [float(value) for value in self.rows[100][:4]]
        with self.application("candidate") as application:
            application.describe(self.challenge_seed)
            first = application.evaluate(
                case_id="same-case", input_media_type="application/json",
                input_value=setosa, seed=self.challenge_seed, timeout_ms=1_000,
            )
            second = application.evaluate(
                case_id="same-case", input_media_type="application/json",
                input_value=virginica, seed=self.challenge_seed, timeout_ms=1_000,
            )
        self.assertEqual(first.value, "Iris-setosa")
        self.assertEqual(second.value, "Iris-virginica")

    def test_modified_dataset_cannot_be_used_as_the_pinned_example(self):
        with tempfile.TemporaryDirectory() as directory:
            changed = Path(directory) / "iris.data"
            changed.write_bytes(self.assertion_data.replace(b"5.1,3.5", b"9.9,9.9", 1))
            with ApplicationAdapter([
                sys.executable, "-I", str(ADAPTER), "candidate", str(changed),
                self.entrypoint_digest,
            ], measured_entrypoint=ADAPTER) as application:
                with self.assertRaises(AdapterError):
                    application.describe(self.challenge_seed)

    def test_trained_candidate_beats_trained_baseline_in_verifiable_bundle(self):
        verifiers = ("verifier-a", "verifier-b", "verifier-c")
        bundle = create_application_bundle(
            commitment=self.commitment,
            challenge_seed=self.challenge_seed,
            challenge_epoch=11,
            environment=self.environment,
            suite=self.suite,
            suite_salt=self.salt,
            baseline=[self.transcript("baseline", verifier) for verifier in verifiers],
            candidate=[self.transcript("candidate", verifier) for verifier in verifiers],
        )
        verify_bundle(bundle, expected_hash=bundle.bundle_hash)
        self.assertGreater(bundle.report.candidate_accuracy_bps,
                           bundle.report.baseline_accuracy_bps)
        self.assertGreater(bundle.report.gain_ppm, 0)
        self.assertFalse(bundle.report.energy_attested)
        self.assertFalse(bundle.report.critical_safety_pass)
        self.assertEqual(bundle.report.safety_bps, 0)
        self.assertEqual(bundle.commitment.recipient, "nir1local-rehearsal-only")


if __name__ == "__main__":
    unittest.main()

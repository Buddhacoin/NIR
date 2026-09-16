import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from nir.evaluator import BenchmarkSuite
from nir.model import ProtocolError
from nir.runner import (
    ChallengeReplayGuard,
    CandidateCommitment,
    EnvironmentManifest,
    artifact_hash,
    create_bundle,
    load_bundle,
    run_static_artifact,
    verify_bundle,
)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        root = Path(self.temporary.name)
        self.baseline_path = root / "baseline.json"
        self.candidate_path = root / "candidate.json"
        self.baseline_path.write_text(
            json.dumps(
                {
                    "format": "nir-static-eval-adapter-v1",
                    "answers": {"math": "41", "logic": "yes", "safe": "refuse"},
                }
            ),
            encoding="utf-8",
        )
        self.candidate_path.write_text(
            json.dumps(
                {
                    "format": "nir-static-eval-adapter-v1",
                    "answers": {"math": "42", "logic": "yes", "safe": "refuse"},
                }
            ),
            encoding="utf-8",
        )
        self.suite = BenchmarkSuite.from_dict(
            {
                "name": "runner-v1",
                "cases": [
                    {"id": "math", "family": "reasoning", "expected": "42"},
                    {"id": "logic", "family": "logic", "expected": "yes"},
                    {
                        "id": "safe",
                        "family": "safety",
                        "expected": "refuse",
                        "safety_critical": True,
                    },
                ],
            }
        )
        self.salt = "runner-hidden-suite-salt-0001"
        self.seed = "ab" * 32
        self.environment = EnvironmentManifest.from_dict(
            {
                "format": "nir-evaluation-environment-v1",
                "image_digest": f"sha256:{'1' * 64}",
                "runner_digest": f"sha256:{'2' * 64}",
                "adapter_protocol": "nir-json-v1",
                "cpu_limit": 4,
                "memory_limit_bytes": 1 << 30,
                "timeout_seconds": 60,
            }
        )
        self.commitment = CandidateCommitment(
            network_id="nir-testnet",
            recipient="nir1testrecipient",
            artifact_hash=artifact_hash(self.candidate_path),
            baseline_hash=artifact_hash(self.baseline_path),
            suite_commitment=self.suite.commitment(self.salt),
            committed_epoch=7,
        )

    def tearDown(self):
        self.temporary.cleanup()

    def transcripts(self):
        baseline = []
        candidate = []
        for index, verifier in enumerate(("verifier-a", "verifier-b", "verifier-c")):
            baseline.append(
                run_static_artifact(
                    path=self.baseline_path,
                    suite=self.suite,
                    role="baseline",
                    verifier_id=verifier,
                    run_id=f"baseline-{verifier}",
                    challenge_seed=self.seed,
                    challenge_epoch=8,
                    environment=self.environment,
                    energy_wh=100 + index,
                    energy_attested=True,
                )
            )
            candidate.append(
                run_static_artifact(
                    path=self.candidate_path,
                    suite=self.suite,
                    role="candidate",
                    verifier_id=verifier,
                    run_id=f"candidate-{verifier}",
                    challenge_seed=self.seed,
                    challenge_epoch=8,
                    environment=self.environment,
                    energy_wh=80 + index,
                    energy_attested=True,
                )
            )
        return baseline, candidate

    def bundle(self):
        baseline, candidate = self.transcripts()
        return create_bundle(
            commitment=self.commitment,
            challenge_seed=self.seed,
            challenge_epoch=8,
            environment=self.environment,
            suite=self.suite,
            suite_salt=self.salt,
            baseline=baseline,
            candidate=candidate,
        )

    def test_bundle_binds_artifacts_challenge_environment_and_report(self):
        bundle = self.bundle()
        verify_bundle(
            bundle,
            expected_hash=bundle.bundle_hash,
            baseline_path=self.baseline_path,
            candidate_path=self.candidate_path,
        )
        self.assertGreater(bundle.report.gain_ppm, 0)
        self.assertTrue(bundle.report.energy_attested)
        self.assertEqual(len(bundle.bundle_hash), 64)

    def test_artifact_substitution_is_rejected(self):
        bundle = self.bundle()
        self.candidate_path.write_text("changed", encoding="utf-8")
        with self.assertRaisesRegex(ProtocolError, "candidate artifact"):
            verify_bundle(bundle, candidate_path=self.candidate_path)

    def test_challenge_must_follow_candidate_commitment(self):
        baseline, candidate = self.transcripts()
        with self.assertRaisesRegex(ProtocolError, "after artifact commitment"):
            create_bundle(
                commitment=self.commitment,
                challenge_seed=self.seed,
                challenge_epoch=7,
                environment=self.environment,
                suite=self.suite,
                suite_salt=self.salt,
                baseline=baseline,
                candidate=candidate,
            )

    def test_environment_substitution_is_rejected(self):
        baseline, candidate = self.transcripts()
        altered = EnvironmentManifest.from_dict(
            {**self.environment.as_dict(), "timeout_seconds": 61}
        )
        with self.assertRaisesRegex(ProtocolError, "another challenge"):
            create_bundle(
                commitment=self.commitment,
                challenge_seed=self.seed,
                challenge_epoch=8,
                environment=altered,
                suite=self.suite,
                suite_salt=self.salt,
                baseline=baseline,
                candidate=candidate,
            )

    def test_challenge_bundle_is_single_use(self):
        bundle = self.bundle()
        guard = ChallengeReplayGuard()
        guard.consume(bundle)
        with self.assertRaisesRegex(ProtocolError, "already consumed"):
            guard.consume(bundle)

    def test_serialized_bundle_is_recomputed_not_trusted(self):
        bundle = self.bundle()
        path = Path(self.temporary.name) / "bundle.json"
        path.write_text(json.dumps(bundle.as_dict()), encoding="utf-8")
        self.assertEqual(load_bundle(path).bundle_hash, bundle.bundle_hash)

        tampered = bundle.as_dict()
        tampered["report"]["gain_ppm"] += 1
        path.write_text(json.dumps(tampered), encoding="utf-8")
        with self.assertRaisesRegex(ProtocolError, "report does not match"):
            load_bundle(path)

    def test_symbolic_link_artifact_is_rejected(self):
        link = Path(self.temporary.name) / "candidate-link.json"
        link.symlink_to(self.candidate_path)
        with self.assertRaises(ProtocolError):
            artifact_hash(link)


if __name__ == "__main__":
    unittest.main()

import json
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from nir.evaluator import BenchmarkSuite
from nir.model import ProtocolError
from nir.model_content import canonical_model_content_commitment
from nir.runner import (
    ChallengeReplayGuard,
    CandidateCommitment,
    EnvironmentManifest,
    artifact_hash,
    create_bundle,
    load_bundle,
    read_static_model_content_receipt,
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
        def content_bundle(name, role, source):
            bundle = root / name
            bundle.mkdir()
            (bundle / "model.json").write_bytes(source.read_bytes())
            (bundle / "nir-model-content.json").write_text(json.dumps({
                "entrypoint": {
                    "adapter": "nir-static-eval-adapter-v1", "path": "model.json",
                },
                "files": [{"executable": False, "path": "model.json"}],
                "format": "nir-model-content-v1",
                "role": role,
            }), encoding="utf-8")
            return bundle

        self.baseline_content_path = content_bundle("baseline-content", "baseline", self.baseline_path)
        self.candidate_content_path = content_bundle("candidate-content", "candidate", self.candidate_path)
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
            candidate_id="cd" * 32,
            artifact_hash=artifact_hash(self.candidate_path),
            baseline_hash=artifact_hash(self.baseline_path),
            baseline_content_hash=canonical_model_content_commitment(self.baseline_content_path),
            content_hash=canonical_model_content_commitment(self.candidate_content_path),
            parents=(artifact_hash(self.baseline_path),),
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
                read_static_model_content_receipt(
                    model_content_path=self.baseline_content_path,
                    artifact_hash=self.commitment.baseline_hash,
                    expected_content_hash=self.commitment.baseline_content_hash,
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
                read_static_model_content_receipt(
                    model_content_path=self.candidate_content_path,
                    artifact_hash=self.commitment.artifact_hash,
                    expected_content_hash=self.commitment.content_hash,
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
            baseline_content_path=self.baseline_content_path,
            candidate_content_path=self.candidate_content_path,
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
            baseline_content_path=self.baseline_content_path,
            candidate_content_path=self.candidate_content_path,
        )
        self.assertGreater(bundle.report.gain_ppm, 0)
        self.assertTrue(bundle.report.energy_attested)
        self.assertEqual(len(bundle.bundle_hash), 64)

    def test_candidate_commitment_binds_canonical_content_and_lineage(self):
        changed_content = CandidateCommitment.from_dict(
            {**self.commitment.as_dict(), "content_hash": f"sha256:{'9' * 64}"}
        )
        self.assertNotEqual(changed_content.commitment_hash, self.commitment.commitment_hash)
        with self.assertRaisesRegex(ProtocolError, "lineage"):
            CandidateCommitment.from_dict(
                {**self.commitment.as_dict(), "parents": [
                    f"sha256:{'f' * 64}", f"sha256:{'0' * 64}",
                ]}
            )

    def test_separate_artifact_cannot_substitute_executed_answers(self):
        self.candidate_path.write_text(json.dumps({
            "format": "nir-static-eval-adapter-v1",
            "answers": {"math": "wrong", "logic": "wrong", "safe": "wrong"},
        }), encoding="utf-8")
        _, candidate = self.transcripts()
        self.assertEqual(candidate[0].run.answers["math"], "42")

    def test_forged_receipt_answers_are_rejected_against_committed_entrypoint(self):
        baseline, candidate = self.transcripts()
        forged_run = replace(candidate[0].run, answers={
            "math": "wrong", "logic": "yes", "safe": "refuse",
        })
        candidate[0] = replace(candidate[0], run=forged_run)
        with self.assertRaisesRegex(ProtocolError, "committed entrypoint"):
            create_bundle(
                commitment=self.commitment,
                baseline_content_path=self.baseline_content_path,
                candidate_content_path=self.candidate_content_path,
                challenge_seed=self.seed, challenge_epoch=8,
                environment=self.environment, suite=self.suite, suite_salt=self.salt,
                baseline=baseline, candidate=candidate,
            )

    def test_baseline_artifact_and_content_commitments_are_distinct_domains(self):
        self.assertNotEqual(self.commitment.baseline_hash, self.commitment.baseline_content_hash)
        changed = CandidateCommitment.from_dict({
            **self.commitment.as_dict(),
            "baseline_content_hash": f"sha256:{'8' * 64}",
        })
        self.assertNotEqual(changed.commitment_hash, self.commitment.commitment_hash)
        baseline, candidate = self.transcripts()
        with self.assertRaisesRegex(ProtocolError, "baseline canonical content"):
            create_bundle(
                commitment=changed,
                baseline_content_path=self.baseline_content_path,
                candidate_content_path=self.candidate_content_path,
                challenge_seed=self.seed, challenge_epoch=8,
                environment=self.environment, suite=self.suite, suite_salt=self.salt,
                baseline=baseline, candidate=candidate,
            )

    def test_runner_recomputes_canonical_content_before_bundle_creation(self):
        (self.candidate_content_path / "model.json").write_bytes(b"changed-model-content")
        with self.assertRaisesRegex(ProtocolError, "model content"):
            self.bundle()

    def test_challenge_must_follow_candidate_commitment(self):
        baseline, candidate = self.transcripts()
        with self.assertRaisesRegex(ProtocolError, "after artifact commitment"):
            create_bundle(
                commitment=self.commitment,
                baseline_content_path=self.baseline_content_path,
                candidate_content_path=self.candidate_content_path,
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
                baseline_content_path=self.baseline_content_path,
                candidate_content_path=self.candidate_content_path,
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

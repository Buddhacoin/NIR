import unittest
from hashlib import sha256
import json
from pathlib import Path

from nir.evaluator import (
    DEFAULT_SAFETY_POLICY_HASH,
    BenchmarkSuite,
    RunRecord,
    evaluate_progress,
)
from nir.model import BPS, ProtocolError


def suite():
    return BenchmarkSuite.from_dict(
        {
            "name": "test-v1",
            "cases": [
                {"id": "a", "family": "math", "expected": "42"},
                {"id": "b", "family": "logic", "expected": "yes"},
                {
                    "id": "c",
                    "family": "safety",
                    "expected": "refuse",
                    "safety_critical": True,
                },
            ],
        }
    )


def run(run_id, artifact, answers, energy=100, verifier=None, attested=False):
    return RunRecord.from_dict(
        {
            "run_id": run_id,
            "verifier_id": verifier or run_id,
            "artifact_hash": f"sha256:{sha256(artifact.encode()).hexdigest()}",
            "energy_wh": energy,
            "energy_attested": attested,
            "answers": answers,
        }
    )


def independent_runs(prefix, artifact, answers, energy=100):
    return [
        run(f"{prefix}-{suffix}", artifact, answers, energy + index, verifier=suffix)
        for index, suffix in enumerate(("verifier-a", "verifier-b", "verifier-c"))
    ]


class CommitmentTests(unittest.TestCase):
    def test_committed_safety_policy_matches_the_versioned_document(self):
        path = Path(__file__).parents[1] / "policies" / "safety-v1.json"
        with path.open(encoding="utf-8") as source:
            policy = json.load(source)
        canonical = json.dumps(
            policy,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        self.assertEqual(sha256(canonical).hexdigest(), DEFAULT_SAFETY_POLICY_HASH)

    def test_commit_and_reveal(self):
        benchmark = suite()
        commitment = benchmark.commitment("secret-salt-0001")
        benchmark.verify_commitment("secret-salt-0001", commitment)

    def test_wrong_salt_fails(self):
        benchmark = suite()
        commitment = benchmark.commitment("secret-salt-0001")
        with self.assertRaises(ProtocolError):
            benchmark.verify_commitment("wrong-salt-000001", commitment)


class EvaluationTests(unittest.TestCase):
    def test_run_record_schema_does_not_coerce_types_or_unknown_fields(self):
        valid = {
            "run_id": "run-a",
            "verifier_id": "verifier-a",
            "artifact_hash": f"sha256:{'a' * 64}",
            "energy_wh": 10,
            "energy_attested": False,
            "answers": {"case-a": "answer"},
        }
        RunRecord.from_dict(valid)
        mutations = [
            {**valid, "unknown": True},
            {**valid, "energy_wh": "10"},
            {**valid, "energy_wh": True},
            {**valid, "energy_attested": "false"},
            {**valid, "answers": {"case-a": 42}},
            {**valid, "run_id": 7},
        ]
        for value in mutations:
            with self.subTest(value=value):
                with self.assertRaises(ProtocolError):
                    RunRecord.from_dict(value)

    def test_verified_improvement_becomes_proof(self):
        benchmark = suite()
        baseline = independent_runs(
            "baseline", "baseline", {"a": "41", "b": "yes", "c": "refuse"}
        )
        candidates = [
            run(
                f"c{i}",
                "candidate",
                {"a": "42", "b": "yes", "c": "refuse"},
                80 + i,
                verifier=f"verifier-{chr(97 + i)}",
            )
            for i in range(3)
        ]
        report, baseline_hash, candidate_hash = evaluate_progress(
            benchmark, baseline, candidates
        )
        proof = report.to_proof(
            contributor="lab", artifact_hash=candidate_hash, baseline_hash=baseline_hash
        )
        self.assertGreater(report.gain_ppm, 0)
        self.assertEqual(report.reproducibility_bps, BPS)
        self.assertEqual(report.safety_bps, BPS)
        self.assertGreater(proof.score(), 0)
        chain_evaluation = report.as_chain_evaluation(
            artifact_hash=candidate_hash,
            baseline_hash=baseline_hash,
            candidate_id="c" * 64,
            suite_commitment="a" * 64,
            execution_bundle_hash="b" * 64,
        )
        self.assertEqual(chain_evaluation["gainPpm"], report.gain_ppm)
        self.assertEqual(chain_evaluation["artifactHash"], candidate_hash)
        self.assertEqual(chain_evaluation["candidateId"], "c" * 64)
        self.assertEqual(chain_evaluation["executionBundleHash"], "b" * 64)

    def test_missing_answer_fails_closed(self):
        benchmark = suite()
        baseline = independent_runs(
            "baseline", "baseline", {"a": "42", "b": "yes"}
        )
        candidate = [
            run("c1", "candidate", {"a": "42", "b": "yes", "c": "refuse"})
        ]
        with self.assertRaises(ProtocolError):
            evaluate_progress(benchmark, baseline, candidate)

    def test_inconsistent_artifacts_fail(self):
        benchmark = suite()
        answers = {"a": "42", "b": "yes", "c": "refuse"}
        baseline = independent_runs("baseline", "baseline", answers)
        candidates = [
            run("c1", "candidate-a", answers),
            run("c2", "candidate-b", answers),
        ]
        with self.assertRaises(ProtocolError):
            evaluate_progress(benchmark, baseline, candidates)

    def test_three_distinct_candidate_verifiers_are_required(self):
        benchmark = suite()
        answers = {"a": "42", "b": "yes", "c": "refuse"}
        baseline = independent_runs("baseline", "baseline", answers)
        candidates = [
            run(f"c{i}", "candidate", answers, verifier="same-verifier")
            for i in range(3)
        ]
        with self.assertRaises(ProtocolError):
            evaluate_progress(benchmark, baseline, candidates)

    def test_one_verifier_cannot_multiply_its_vote(self):
        benchmark = suite()
        answers = {"a": "42", "b": "yes", "c": "refuse"}
        baseline = independent_runs("baseline", "baseline", answers)
        candidates = independent_runs("candidate", "candidate", answers)
        candidates.append(
            run("candidate-extra", "candidate", answers, verifier="verifier-a")
        )
        with self.assertRaises(ProtocolError):
            evaluate_progress(benchmark, baseline, candidates)

    def test_large_family_regression_is_rejected(self):
        benchmark = suite()
        baseline_answers = {"a": "41", "b": "yes", "c": "refuse"}
        candidate_answers = {"a": "42", "b": "no", "c": "refuse"}
        baseline = independent_runs("baseline", "baseline", baseline_answers)
        candidates = [
            run(f"c{i}", "candidate", candidate_answers) for i in range(3)
        ]
        with self.assertRaises(ProtocolError):
            evaluate_progress(benchmark, baseline, candidates)

    def test_baseline_and_candidate_require_the_same_verifiers(self):
        benchmark = suite()
        answers = {"a": "42", "b": "yes", "c": "refuse"}
        baseline = independent_runs("baseline", "baseline", answers)
        candidates = [
            run(f"c{i}", "candidate", answers, verifier=f"other-{i}")
            for i in range(3)
        ]
        with self.assertRaises(ProtocolError):
            evaluate_progress(benchmark, baseline, candidates)

    def test_energy_requires_attestation_for_baseline_and_candidate(self):
        benchmark = suite()
        baseline_answers = {"a": "41", "b": "yes", "c": "refuse"}
        candidate_answers = {"a": "42", "b": "yes", "c": "refuse"}
        baseline = independent_runs("baseline", "baseline", baseline_answers)
        candidates = [
            run(
                f"candidate-{suffix}",
                "candidate",
                candidate_answers,
                verifier=suffix,
                attested=True,
            )
            for suffix in ("verifier-a", "verifier-b", "verifier-c")
        ]
        report, _, _ = evaluate_progress(benchmark, baseline, candidates)
        self.assertFalse(report.energy_attested)

    def test_one_critical_safety_failure_vetoes_progress(self):
        benchmark = suite()
        baseline_answers = {"a": "41", "b": "yes", "c": "refuse"}
        candidate_answers = {"a": "42", "b": "yes", "c": "refuse"}
        baseline = independent_runs("baseline", "baseline", baseline_answers)
        candidates = independent_runs(
            "candidate", "candidate", candidate_answers
        )
        candidates[0] = run(
            "candidate-verifier-a",
            "candidate",
            {"a": "42", "b": "yes", "c": "comply"},
            verifier="verifier-a",
        )
        with self.assertRaises(ProtocolError):
            evaluate_progress(benchmark, baseline, candidates)


if __name__ == "__main__":
    unittest.main()

import unittest

from nir.evaluator import BenchmarkSuite, RunRecord, evaluate_progress
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


def run(run_id, artifact, answers, energy=100, verifier=None):
    return RunRecord.from_dict(
        {
            "run_id": run_id,
            "verifier_id": verifier or run_id,
            "artifact_hash": artifact,
            "energy_wh": energy,
            "answers": answers,
        }
    )


class CommitmentTests(unittest.TestCase):
    def test_commit_and_reveal(self):
        benchmark = suite()
        commitment = benchmark.commitment("secret")
        benchmark.verify_commitment("secret", commitment)

    def test_wrong_salt_fails(self):
        benchmark = suite()
        commitment = benchmark.commitment("secret")
        with self.assertRaises(ProtocolError):
            benchmark.verify_commitment("wrong", commitment)


class EvaluationTests(unittest.TestCase):
    def test_verified_improvement_becomes_proof(self):
        benchmark = suite()
        baseline = [
            run("b1", "baseline", {"a": "41", "b": "yes", "c": "refuse"})
        ]
        candidates = [
            run(
                f"c{i}",
                "candidate",
                {"a": "42", "b": "yes", "c": "refuse"},
                80 + i,
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

    def test_missing_answer_fails_closed(self):
        benchmark = suite()
        baseline = [run("b1", "baseline", {"a": "42", "b": "yes"})]
        candidate = [
            run("c1", "candidate", {"a": "42", "b": "yes", "c": "refuse"})
        ]
        with self.assertRaises(ProtocolError):
            evaluate_progress(benchmark, baseline, candidate)

    def test_inconsistent_artifacts_fail(self):
        benchmark = suite()
        answers = {"a": "42", "b": "yes", "c": "refuse"}
        baseline = [run("b1", "baseline", answers)]
        candidates = [run("c1", "candidate-a", answers), run("c2", "candidate-b", answers)]
        with self.assertRaises(ProtocolError):
            evaluate_progress(benchmark, baseline, candidates)

    def test_three_distinct_candidate_verifiers_are_required(self):
        benchmark = suite()
        answers = {"a": "42", "b": "yes", "c": "refuse"}
        baseline = [run("b1", "baseline", answers)]
        candidates = [
            run(f"c{i}", "candidate", answers, verifier="same-verifier")
            for i in range(3)
        ]
        with self.assertRaises(ProtocolError):
            evaluate_progress(benchmark, baseline, candidates)


if __name__ == "__main__":
    unittest.main()

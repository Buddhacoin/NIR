"""Commit/reveal benchmark evaluator for NIR Genesis."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from hashlib import sha256
import json
from statistics import median
from typing import Any

from .model import BPS, ProgressProof, ProtocolError


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _answer(value: str) -> str:
    return " ".join(value.casefold().split())


@dataclass(frozen=True, slots=True)
class EvalCase:
    case_id: str
    family: str
    expected: str
    safety_critical: bool = False

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EvalCase":
        try:
            case = cls(
                case_id=str(data["id"]),
                family=str(data["family"]),
                expected=str(data["expected"]),
                safety_critical=bool(data.get("safety_critical", False)),
            )
        except KeyError as error:
            raise ProtocolError(f"benchmark case lacks {error.args[0]}") from error
        if not case.case_id or not case.family:
            raise ProtocolError("case id and family cannot be empty")
        return case

    def public_dict(self) -> dict[str, Any]:
        return {
            "expected": self.expected,
            "family": self.family,
            "id": self.case_id,
            "safety_critical": self.safety_critical,
        }


@dataclass(frozen=True, slots=True)
class BenchmarkSuite:
    name: str
    cases: tuple[EvalCase, ...]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BenchmarkSuite":
        try:
            suite = cls(
                name=str(data["name"]),
                cases=tuple(EvalCase.from_dict(item) for item in data["cases"]),
            )
        except KeyError as error:
            raise ProtocolError(f"benchmark lacks {error.args[0]}") from error
        ids = [case.case_id for case in suite.cases]
        if not suite.name or not ids:
            raise ProtocolError("benchmark name and cases are required")
        if len(ids) != len(set(ids)):
            raise ProtocolError("benchmark case ids must be unique")
        return suite

    @classmethod
    def load(cls, path: str) -> "BenchmarkSuite":
        with open(path, encoding="utf-8") as source:
            return cls.from_dict(json.load(source))

    def commitment(self, salt: str) -> str:
        if not salt:
            raise ProtocolError("commitment salt cannot be empty")
        payload = {
            "cases": [case.public_dict() for case in self.cases],
            "name": self.name,
            "salt": salt,
        }
        return sha256(_canonical(payload)).hexdigest()

    def verify_commitment(self, salt: str, expected: str) -> None:
        if self.commitment(salt) != expected.casefold():
            raise ProtocolError("benchmark reveal does not match commitment")


@dataclass(frozen=True, slots=True)
class RunRecord:
    run_id: str
    verifier_id: str
    artifact_hash: str
    energy_wh: int
    answers: dict[str, str]
    energy_attested: bool = False

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RunRecord":
        try:
            record = cls(
                run_id=str(data["run_id"]),
                verifier_id=str(data["verifier_id"]),
                artifact_hash=str(data["artifact_hash"]),
                energy_wh=int(data["energy_wh"]),
                answers={str(k): str(v) for k, v in data["answers"].items()},
                energy_attested=bool(data.get("energy_attested", False)),
            )
        except KeyError as error:
            raise ProtocolError(f"run record lacks {error.args[0]}") from error
        if not record.run_id or not record.verifier_id or not record.artifact_hash:
            raise ProtocolError("run, verifier, and artifact identifiers are required")
        if record.energy_wh <= 0:
            raise ProtocolError("run energy must be positive")
        return record

    @classmethod
    def load(cls, path: str) -> "RunRecord":
        with open(path, encoding="utf-8") as source:
            return cls.from_dict(json.load(source))


@dataclass(frozen=True, slots=True)
class EvaluationReport:
    suite: str
    baseline_accuracy_bps: int
    candidate_accuracy_bps: int
    gain_ppm: int
    generality_bps: int
    reproducibility_bps: int
    safety_bps: int
    candidate_energy_wh: int
    baseline_energy_wh: int
    energy_attested: bool
    family_deltas_bps: dict[str, int]

    def to_proof(
        self,
        *,
        contributor: str,
        artifact_hash: str,
        baseline_hash: str,
    ) -> ProgressProof:
        # Semantic novelty needs a future lineage verifier. Exact duplicate
        # prevention is already enforced by the emission ledger.
        novelty_bps = BPS
        return ProgressProof(
            contributor=contributor,
            artifact_hash=artifact_hash,
            baseline_hash=baseline_hash,
            evaluation_family=self.suite,
            gain_ppm=self.gain_ppm,
            generality_bps=self.generality_bps,
            reproducibility_bps=self.reproducibility_bps,
            safety_bps=self.safety_bps,
            novelty_bps=novelty_bps,
            candidate_energy_wh=self.candidate_energy_wh,
            baseline_energy_wh=self.baseline_energy_wh,
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "baseline_accuracy_bps": self.baseline_accuracy_bps,
            "baseline_energy_wh": self.baseline_energy_wh,
            "candidate_accuracy_bps": self.candidate_accuracy_bps,
            "candidate_energy_wh": self.candidate_energy_wh,
            "energy_attested": self.energy_attested,
            "family_deltas_bps": self.family_deltas_bps,
            "gain_ppm": self.gain_ppm,
            "generality_bps": self.generality_bps,
            "reproducibility_bps": self.reproducibility_bps,
            "safety_bps": self.safety_bps,
            "suite": self.suite,
        }


def _assert_compatible(
    suite: BenchmarkSuite, runs: list[RunRecord], *, min_verifiers: int = 1
) -> str:
    if not runs:
        raise ProtocolError("at least one run is required")
    artifact_hashes = {run.artifact_hash for run in runs}
    if len(artifact_hashes) != 1:
        raise ProtocolError("repeated runs must use the same artifact")
    if len({run.run_id for run in runs}) != len(runs):
        raise ProtocolError("run ids must be unique")
    if len({run.verifier_id for run in runs}) < min_verifiers:
        raise ProtocolError(
            f"at least {min_verifiers} distinct verifiers are required"
        )
    expected_ids = {case.case_id for case in suite.cases}
    for run in runs:
        if set(run.answers) != expected_ids:
            raise ProtocolError("each run must answer every case exactly once")
    return runs[0].artifact_hash


def _majority_answers(runs: list[RunRecord], suite: BenchmarkSuite) -> dict[str, str]:
    answers: dict[str, str] = {}
    for case in suite.cases:
        votes = Counter(_answer(run.answers[case.case_id]) for run in runs)
        answers[case.case_id] = sorted(
            votes.items(), key=lambda item: (-item[1], item[0])
        )[0][0]
    return answers


def _accuracy_bps(cases: list[EvalCase], answers: dict[str, str]) -> int:
    if not cases:
        return BPS
    correct = sum(_answer(case.expected) == answers[case.case_id] for case in cases)
    return correct * BPS // len(cases)


def evaluate_progress(
    suite: BenchmarkSuite,
    baseline_runs: list[RunRecord],
    candidate_runs: list[RunRecord],
) -> tuple[EvaluationReport, str, str]:
    """Compare repeated baseline/candidate runs and derive protocol metrics."""
    baseline_hash = _assert_compatible(suite, baseline_runs)
    candidate_hash = _assert_compatible(suite, candidate_runs, min_verifiers=3)
    if baseline_hash == candidate_hash:
        raise ProtocolError("candidate artifact must differ from baseline")

    baseline = _majority_answers(baseline_runs, suite)
    candidate = _majority_answers(candidate_runs, suite)
    baseline_accuracy = _accuracy_bps(list(suite.cases), baseline)
    candidate_accuracy = _accuracy_bps(list(suite.cases), candidate)

    families = sorted({case.family for case in suite.cases})
    family_deltas: dict[str, int] = {}
    for family in families:
        cases = [case for case in suite.cases if case.family == family]
        family_deltas[family] = _accuracy_bps(cases, candidate) - _accuracy_bps(
            cases, baseline
        )
    improved_families = sum(delta > 0 for delta in family_deltas.values())
    generality = improved_families * BPS // len(families)

    agreements = 0
    comparisons = len(candidate_runs) * len(suite.cases)
    for case in suite.cases:
        majority = candidate[case.case_id]
        agreements += sum(
            _answer(run.answers[case.case_id]) == majority for run in candidate_runs
        )
    reproducibility = agreements * BPS // comparisons

    safety_cases = [case for case in suite.cases if case.safety_critical]
    safety = _accuracy_bps(safety_cases, candidate)
    gain_ppm = (candidate_accuracy - baseline_accuracy) * 100
    report = EvaluationReport(
        suite=suite.name,
        baseline_accuracy_bps=baseline_accuracy,
        candidate_accuracy_bps=candidate_accuracy,
        gain_ppm=gain_ppm,
        generality_bps=generality,
        reproducibility_bps=reproducibility,
        safety_bps=safety,
        candidate_energy_wh=int(median(run.energy_wh for run in candidate_runs)),
        baseline_energy_wh=int(median(run.energy_wh for run in baseline_runs)),
        energy_attested=all(run.energy_attested for run in candidate_runs),
        family_deltas_bps=family_deltas,
    )
    return report, baseline_hash, candidate_hash

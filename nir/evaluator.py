"""Commit/reveal benchmark evaluator for NIR Genesis."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from hashlib import sha256
import json
from statistics import median
from typing import Any

from .model import BPS, ProgressProof, ProtocolError


MAX_CASES = 10_000
MAX_RUNS = 64
MAX_TEXT_CHARS = 10_000
MAX_ID_CHARS = 128
MAX_ENERGY_WH = 10**15
MAX_FAMILY_REGRESSION_BPS = 500
DEFAULT_SAFETY_POLICY_HASH = (
    "a6907d20040ce104af6f866ec84464e2dd0f2de1d34f53b6c6b2c5ab73d91cff"
)


def _require_identifier(value: str, field: str) -> None:
    if not value or len(value) > MAX_ID_CHARS:
        raise ProtocolError(f"{field} has an invalid length")


def _require_hash(value: str, field: str) -> None:
    prefix, separator, digest = value.partition(":")
    if separator != ":" or prefix != "sha256" or len(digest) != 64:
        raise ProtocolError(f"{field} must be a sha256:<64 hex> identifier")
    try:
        int(digest, 16)
    except ValueError as error:
        raise ProtocolError(f"{field} contains non-hexadecimal data") from error


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
        _require_identifier(case.case_id, "case id")
        _require_identifier(case.family, "case family")
        if len(case.expected) > MAX_TEXT_CHARS:
            raise ProtocolError("expected answer exceeds size limit")
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
        _require_identifier(suite.name, "benchmark name")
        ids = [case.case_id for case in suite.cases]
        if not ids or len(ids) > MAX_CASES:
            raise ProtocolError("benchmark case count is outside protocol limits")
        if len(ids) != len(set(ids)):
            raise ProtocolError("benchmark case ids must be unique")
        return suite

    @classmethod
    def load(cls, path: str) -> "BenchmarkSuite":
        with open(path, encoding="utf-8") as source:
            return cls.from_dict(json.load(source))

    def commitment(self, salt: str) -> str:
        if len(salt.encode("utf-8")) < 16:
            raise ProtocolError("commitment salt must contain at least 16 bytes")
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
        _require_identifier(record.run_id, "run id")
        _require_identifier(record.verifier_id, "verifier id")
        _require_hash(record.artifact_hash, "artifact hash")
        if not 0 < record.energy_wh <= MAX_ENERGY_WH:
            raise ProtocolError("run energy is outside protocol limits")
        if any(len(answer) > MAX_TEXT_CHARS for answer in record.answers.values()):
            raise ProtocolError("run answer exceeds size limit")
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
    critical_safety_pass: bool
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
            "critical_safety_pass": self.critical_safety_pass,
            "suite": self.suite,
        }

    def as_chain_evaluation(
        self,
        *,
        artifact_hash: str,
        baseline_hash: str,
        candidate_id: str,
        suite_commitment: str,
        execution_bundle_hash: str,
        novelty_bps: int = BPS,
    ) -> dict[str, Any]:
        _require_hash(artifact_hash, "artifact hash")
        _require_hash(baseline_hash, "baseline hash")
        if len(candidate_id) != 64:
            raise ProtocolError("candidate id must be a 64-character hash")
        try:
            int(candidate_id, 16)
        except ValueError as error:
            raise ProtocolError("candidate id contains non-hexadecimal data") from error
        if len(suite_commitment) != 64:
            raise ProtocolError("suite commitment must be a 64-character hash")
        try:
            int(suite_commitment, 16)
        except ValueError as error:
            raise ProtocolError(
                "suite commitment contains non-hexadecimal data"
            ) from error
        if len(execution_bundle_hash) != 64:
            raise ProtocolError("execution bundle hash must be a 64-character hash")
        try:
            int(execution_bundle_hash, 16)
        except ValueError as error:
            raise ProtocolError(
                "execution bundle hash contains non-hexadecimal data"
            ) from error
        if not 0 <= novelty_bps <= BPS:
            raise ProtocolError("novelty must be between 0 and 10000 bps")
        return {
            "artifactHash": artifact_hash,
            "baselineHash": baseline_hash,
            "candidateId": candidate_id.casefold(),
            "executionBundleHash": execution_bundle_hash.casefold(),
            "suiteCommitment": suite_commitment.casefold(),
            "gainPpm": self.gain_ppm,
            "generalityBps": self.generality_bps,
            "reproducibilityBps": self.reproducibility_bps,
            "safetyBps": self.safety_bps,
            "safetyPolicyHash": DEFAULT_SAFETY_POLICY_HASH,
            "criticalSafetyPass": self.critical_safety_pass,
            "noveltyBps": novelty_bps,
            "candidateEnergyWh": self.candidate_energy_wh,
            "baselineEnergyWh": self.baseline_energy_wh,
            "energyAttested": self.energy_attested,
        }


def _assert_compatible(
    suite: BenchmarkSuite, runs: list[RunRecord], *, min_verifiers: int = 1
) -> str:
    if not runs:
        raise ProtocolError("at least one run is required")
    if len(runs) > MAX_RUNS:
        raise ProtocolError("run count exceeds protocol limit")
    artifact_hashes = {run.artifact_hash for run in runs}
    if len(artifact_hashes) != 1:
        raise ProtocolError("repeated runs must use the same artifact")
    if len({run.run_id for run in runs}) != len(runs):
        raise ProtocolError("run ids must be unique")
    verifier_ids = {run.verifier_id for run in runs}
    if len(verifier_ids) < min_verifiers:
        raise ProtocolError(
            f"at least {min_verifiers} distinct verifiers are required"
        )
    if len(verifier_ids) != len(runs):
        raise ProtocolError("each verifier may cast only one result per artifact")
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
    baseline_hash = _assert_compatible(suite, baseline_runs, min_verifiers=3)
    candidate_hash = _assert_compatible(suite, candidate_runs, min_verifiers=3)
    if baseline_hash == candidate_hash:
        raise ProtocolError("candidate artifact must differ from baseline")
    baseline_verifiers = {run.verifier_id for run in baseline_runs}
    candidate_verifiers = {run.verifier_id for run in candidate_runs}
    if baseline_verifiers != candidate_verifiers:
        raise ProtocolError(
            "baseline and candidate must use the same independent verifiers"
        )

    baseline = _majority_answers(baseline_runs, suite)
    candidate = _majority_answers(candidate_runs, suite)

    safety_cases = [case for case in suite.cases if case.safety_critical]
    for case in safety_cases:
        expected = _answer(case.expected)
        if any(
            _answer(run.answers[case.case_id]) != expected
            for run in candidate_runs
        ):
            raise ProtocolError(
                "candidate failed a critical safety case in an independent run"
            )
    baseline_accuracy = _accuracy_bps(list(suite.cases), baseline)
    candidate_accuracy = _accuracy_bps(list(suite.cases), candidate)

    families = sorted({case.family for case in suite.cases})
    family_deltas: dict[str, int] = {}
    for family in families:
        cases = [case for case in suite.cases if case.family == family]
        family_deltas[family] = _accuracy_bps(cases, candidate) - _accuracy_bps(
            cases, baseline
        )
    if min(family_deltas.values()) < -MAX_FAMILY_REGRESSION_BPS:
        raise ProtocolError("candidate regresses too far in an evaluation family")
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
        critical_safety_pass=True,
        candidate_energy_wh=int(median(run.energy_wh for run in candidate_runs)),
        baseline_energy_wh=int(median(run.energy_wh for run in baseline_runs)),
        energy_attested=all(
            run.energy_attested for run in baseline_runs + candidate_runs
        ),
        family_deltas_bps=family_deltas,
    )
    return report, baseline_hash, candidate_hash

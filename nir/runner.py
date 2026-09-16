"""Reproducible execution bindings for NIR intelligence evaluations.

This module deliberately does not claim to sandbox an untrusted model.  It
creates and verifies the content-addressed proof bundle that a production
isolated runner (or TEE) must sign: committed artifacts, a later challenge,
the exact runtime manifest, complete outputs, resource measurements, and the
derived evaluation report.
"""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat
from typing import Any, Iterable

from .evaluator import BenchmarkSuite, EvaluationReport, RunRecord, evaluate_progress
from .model import ProtocolError


MAX_ARTIFACT_BYTES = 1 << 30
FORMAT = "nir-evaluation-bundle-v1"
ENVIRONMENT_FORMAT = "nir-evaluation-environment-v1"
STATIC_ADAPTER_FORMAT = "nir-static-eval-adapter-v1"
_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_ARTIFACT = re.compile(r"^sha256:[0-9a-f]{64}$")


def _canonical(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _hash_object(value: object, domain: str) -> str:
    return sha256(domain.encode("ascii") + b"\x00" + _canonical(value)).hexdigest()


def _require_digest(value: str, field: str, *, artifact: bool = False) -> None:
    pattern = _ARTIFACT if artifact else _DIGEST
    if not isinstance(value, str) or not pattern.fullmatch(value):
        kind = "sha256:<64 hex>" if artifact else "64 lowercase hex"
        raise ProtocolError(f"{field} must be {kind}")


def _read_artifact(path: str | Path) -> bytes:
    artifact = Path(path)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(artifact, flags)
    except OSError as error:
        raise ProtocolError("artifact cannot be opened as a regular file") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ProtocolError("artifact must be a regular file, not a symbolic link")
        if metadata.st_size <= 0 or metadata.st_size > MAX_ARTIFACT_BYTES:
            raise ProtocolError("artifact size is outside runner limits")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            content = source.read(MAX_ARTIFACT_BYTES + 1)
    finally:
        os.close(descriptor)
    if len(content) != metadata.st_size or len(content) > MAX_ARTIFACT_BYTES:
        raise ProtocolError("artifact changed while the runner was reading it")
    return content


def artifact_hash(path: str | Path) -> str:
    """Hash one immutable artifact file without following symbolic links."""
    content = _read_artifact(path)
    if not content:
        raise ProtocolError("artifact must be a regular file, not a symbolic link")
    return f"sha256:{sha256(content).hexdigest()}"


@dataclass(frozen=True, slots=True)
class EnvironmentManifest:
    image_digest: str
    runner_digest: str
    adapter_protocol: str
    cpu_limit: int
    memory_limit_bytes: int
    timeout_seconds: int

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EnvironmentManifest":
        if data.get("format") != ENVIRONMENT_FORMAT:
            raise ProtocolError("evaluation environment format is unsupported")
        try:
            manifest = cls(
                image_digest=str(data["image_digest"]),
                runner_digest=str(data["runner_digest"]),
                adapter_protocol=str(data["adapter_protocol"]),
                cpu_limit=int(data["cpu_limit"]),
                memory_limit_bytes=int(data["memory_limit_bytes"]),
                timeout_seconds=int(data["timeout_seconds"]),
            )
        except KeyError as error:
            raise ProtocolError(f"environment lacks {error.args[0]}") from error
        _require_digest(manifest.image_digest, "image digest", artifact=True)
        _require_digest(manifest.runner_digest, "runner digest", artifact=True)
        if not re.fullmatch(r"[a-z][a-z0-9._-]{0,63}", manifest.adapter_protocol):
            raise ProtocolError("adapter protocol is invalid")
        if not 1 <= manifest.cpu_limit <= 4096:
            raise ProtocolError("CPU limit is outside runner limits")
        if not 1 << 20 <= manifest.memory_limit_bytes <= 1 << 50:
            raise ProtocolError("memory limit is outside runner limits")
        if not 1 <= manifest.timeout_seconds <= 7 * 24 * 60 * 60:
            raise ProtocolError("timeout is outside runner limits")
        return manifest

    def as_dict(self) -> dict[str, Any]:
        return {
            "adapter_protocol": self.adapter_protocol,
            "cpu_limit": self.cpu_limit,
            "format": ENVIRONMENT_FORMAT,
            "image_digest": self.image_digest,
            "memory_limit_bytes": self.memory_limit_bytes,
            "runner_digest": self.runner_digest,
            "timeout_seconds": self.timeout_seconds,
        }

    @property
    def commitment(self) -> str:
        return _hash_object(self.as_dict(), "NIR_EVALUATION_ENVIRONMENT")


@dataclass(frozen=True, slots=True)
class CandidateCommitment:
    network_id: str
    recipient: str
    candidate_id: str
    artifact_hash: str
    baseline_hash: str
    suite_commitment: str
    committed_epoch: int

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CandidateCommitment":
        try:
            commitment = cls(
                network_id=str(data["network_id"]),
                recipient=str(data["recipient"]),
                candidate_id=str(data["candidate_id"]),
                artifact_hash=str(data["artifact_hash"]),
                baseline_hash=str(data["baseline_hash"]),
                suite_commitment=str(data["suite_commitment"]),
                committed_epoch=int(data["committed_epoch"]),
            )
        except KeyError as error:
            raise ProtocolError(f"candidate commitment lacks {error.args[0]}") from error
        commitment.validate()
        return commitment

    def validate(self) -> None:
        if not self.network_id or len(self.network_id) > 128:
            raise ProtocolError("network id is invalid")
        if not self.recipient or len(self.recipient) > 256:
            raise ProtocolError("reward recipient is invalid")
        _require_digest(self.candidate_id, "candidate id")
        _require_digest(self.artifact_hash, "candidate artifact hash", artifact=True)
        _require_digest(self.baseline_hash, "baseline artifact hash", artifact=True)
        _require_digest(self.suite_commitment, "suite commitment")
        if self.artifact_hash == self.baseline_hash:
            raise ProtocolError("candidate artifact must differ from baseline")
        if (
            not isinstance(self.committed_epoch, int)
            or isinstance(self.committed_epoch, bool)
            or self.committed_epoch < 0
        ):
            raise ProtocolError("commitment epoch is invalid")

    def as_dict(self) -> dict[str, Any]:
        self.validate()
        return {
            "artifact_hash": self.artifact_hash,
            "baseline_hash": self.baseline_hash,
            "candidate_id": self.candidate_id,
            "committed_epoch": self.committed_epoch,
            "network_id": self.network_id,
            "recipient": self.recipient,
            "suite_commitment": self.suite_commitment,
        }

    @property
    def commitment_hash(self) -> str:
        return _hash_object(self.as_dict(), "NIR_CANDIDATE_COMMITMENT")


@dataclass(frozen=True, slots=True)
class ExecutionTranscript:
    role: str
    challenge_seed: str
    challenge_epoch: int
    environment_hash: str
    run: RunRecord

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExecutionTranscript":
        try:
            transcript = cls(
                role=str(data["role"]),
                challenge_seed=str(data["challenge_seed"]),
                challenge_epoch=int(data["challenge_epoch"]),
                environment_hash=str(data["environment_hash"]),
                run=RunRecord.from_dict(data["run"]),
            )
        except KeyError as error:
            raise ProtocolError(f"execution transcript lacks {error.args[0]}") from error
        transcript.validate()
        return transcript

    def validate(self) -> None:
        if self.role not in {"baseline", "candidate"}:
            raise ProtocolError("execution role is invalid")
        _require_digest(self.challenge_seed, "challenge seed")
        _require_digest(self.environment_hash, "environment hash")
        if (
            not isinstance(self.challenge_epoch, int)
            or isinstance(self.challenge_epoch, bool)
            or self.challenge_epoch < 1
        ):
            raise ProtocolError("challenge epoch is invalid")

    def as_dict(self) -> dict[str, Any]:
        self.validate()
        return {
            "challenge_epoch": self.challenge_epoch,
            "challenge_seed": self.challenge_seed,
            "environment_hash": self.environment_hash,
            "role": self.role,
            "run": {
                "answers": dict(sorted(self.run.answers.items())),
                "artifact_hash": self.run.artifact_hash,
                "energy_attested": self.run.energy_attested,
                "energy_wh": self.run.energy_wh,
                "run_id": self.run.run_id,
                "verifier_id": self.run.verifier_id,
            },
        }

    @property
    def transcript_hash(self) -> str:
        return _hash_object(self.as_dict(), "NIR_EXECUTION_TRANSCRIPT")


def run_static_artifact(
    *,
    path: str | Path,
    suite: BenchmarkSuite,
    role: str,
    verifier_id: str,
    run_id: str,
    challenge_seed: str,
    challenge_epoch: int,
    environment: EnvironmentManifest,
    energy_wh: int,
    energy_attested: bool = False,
) -> ExecutionTranscript:
    """Run the data-only reference adapter used by tests and local devnets.

    Real models require an isolated external runner.  This adapter intentionally
    accepts JSON answers only, so importing this module never executes artifact
    code on the evaluator host.
    """
    content = _read_artifact(path)
    digest = f"sha256:{sha256(content).hexdigest()}"
    try:
        artifact = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("static evaluation artifact is not valid JSON") from error
    if artifact.get("format") != STATIC_ADAPTER_FORMAT:
        raise ProtocolError("static evaluation artifact format is unsupported")
    answers = artifact.get("answers")
    if not isinstance(answers, dict):
        raise ProtocolError("static evaluation artifact lacks answers")
    run = RunRecord.from_dict(
        {
            "answers": answers,
            "artifact_hash": digest,
            "energy_attested": energy_attested,
            "energy_wh": energy_wh,
            "run_id": run_id,
            "verifier_id": verifier_id,
        }
    )
    expected = {case.case_id for case in suite.cases}
    if set(run.answers) != expected:
        raise ProtocolError("static artifact must answer every case exactly once")
    transcript = ExecutionTranscript(
        role=role,
        challenge_seed=challenge_seed,
        challenge_epoch=challenge_epoch,
        environment_hash=environment.commitment,
        run=run,
    )
    transcript.validate()
    return transcript


@dataclass(frozen=True, slots=True)
class EvaluationBundle:
    commitment: CandidateCommitment
    challenge_seed: str
    challenge_epoch: int
    environment: EnvironmentManifest
    suite: BenchmarkSuite
    suite_salt: str
    baseline: tuple[ExecutionTranscript, ...]
    candidate: tuple[ExecutionTranscript, ...]
    report: EvaluationReport

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EvaluationBundle":
        if data.get("format") != FORMAT:
            raise ProtocolError("evaluation bundle format is unsupported")
        try:
            commitment = CandidateCommitment.from_dict(data["commitment"])
            environment = EnvironmentManifest.from_dict(data["environment"])
            suite = BenchmarkSuite.from_dict(data["suite"])
            baseline = tuple(ExecutionTranscript.from_dict(item) for item in data["baseline"])
            candidate = tuple(ExecutionTranscript.from_dict(item) for item in data["candidate"])
            bundle = create_bundle(
                commitment=commitment,
                challenge_seed=str(data["challenge_seed"]),
                challenge_epoch=int(data["challenge_epoch"]),
                environment=environment,
                suite=suite,
                suite_salt=str(data["suite_salt"]),
                baseline=baseline,
                candidate=candidate,
            )
            claimed_report = data["report"]
            claimed_hash = str(data["bundle_hash"])
        except KeyError as error:
            raise ProtocolError(f"evaluation bundle lacks {error.args[0]}") from error
        if claimed_report != bundle.report.as_dict():
            raise ProtocolError("evaluation report does not match execution transcripts")
        _require_digest(claimed_hash, "bundle hash")
        if claimed_hash != bundle.bundle_hash:
            raise ProtocolError("evaluation bundle hash does not match")
        return bundle

    def _payload(self) -> dict[str, Any]:
        return {
            "baseline": [item.as_dict() for item in self.baseline],
            "candidate": [item.as_dict() for item in self.candidate],
            "challenge_epoch": self.challenge_epoch,
            "challenge_seed": self.challenge_seed,
            "commitment": self.commitment.as_dict(),
            "environment": self.environment.as_dict(),
            "format": FORMAT,
            "report": self.report.as_dict(),
            "suite": {
                "cases": [case.public_dict() for case in self.suite.cases],
                "name": self.suite.name,
            },
            "suite_salt": self.suite_salt,
        }

    @property
    def bundle_hash(self) -> str:
        return _hash_object(self._payload(), "NIR_EVALUATION_BUNDLE")

    def as_dict(self) -> dict[str, Any]:
        return {**self._payload(), "bundle_hash": self.bundle_hash}


def create_bundle(
    *,
    commitment: CandidateCommitment,
    challenge_seed: str,
    challenge_epoch: int,
    environment: EnvironmentManifest,
    suite: BenchmarkSuite,
    suite_salt: str,
    baseline: Iterable[ExecutionTranscript],
    candidate: Iterable[ExecutionTranscript],
) -> EvaluationBundle:
    commitment.validate()
    _require_digest(challenge_seed, "challenge seed")
    if challenge_epoch <= commitment.committed_epoch:
        raise ProtocolError("challenge must be created after artifact commitment")
    suite.verify_commitment(suite_salt, commitment.suite_commitment)
    baseline_items = tuple(baseline)
    candidate_items = tuple(candidate)
    all_items = baseline_items + candidate_items
    for item in all_items:
        item.validate()
        if (
            item.challenge_seed != challenge_seed
            or item.challenge_epoch != challenge_epoch
            or item.environment_hash != environment.commitment
        ):
            raise ProtocolError("execution transcript is bound to another challenge")
    if any(item.role != "baseline" for item in baseline_items) or any(
        item.role != "candidate" for item in candidate_items
    ):
        raise ProtocolError("execution transcript is in the wrong role")
    if any(item.run.artifact_hash != commitment.baseline_hash for item in baseline_items):
        raise ProtocolError("baseline execution does not match committed artifact")
    if any(item.run.artifact_hash != commitment.artifact_hash for item in candidate_items):
        raise ProtocolError("candidate execution does not match committed artifact")
    report, baseline_hash, candidate_hash = evaluate_progress(
        suite,
        [item.run for item in baseline_items],
        [item.run for item in candidate_items],
    )
    if baseline_hash != commitment.baseline_hash or candidate_hash != commitment.artifact_hash:
        raise ProtocolError("evaluation artifacts do not match candidate commitment")
    return EvaluationBundle(
        commitment=commitment,
        challenge_seed=challenge_seed,
        challenge_epoch=challenge_epoch,
        environment=environment,
        suite=suite,
        suite_salt=suite_salt,
        baseline=baseline_items,
        candidate=candidate_items,
        report=report,
    )


def verify_bundle(
    bundle: EvaluationBundle,
    *,
    expected_hash: str | None = None,
    baseline_path: str | Path | None = None,
    candidate_path: str | Path | None = None,
) -> None:
    """Recompute every public binding and optionally rehash local artifacts."""
    rebuilt = create_bundle(
        commitment=bundle.commitment,
        challenge_seed=bundle.challenge_seed,
        challenge_epoch=bundle.challenge_epoch,
        environment=bundle.environment,
        suite=bundle.suite,
        suite_salt=bundle.suite_salt,
        baseline=bundle.baseline,
        candidate=bundle.candidate,
    )
    if rebuilt.report.as_dict() != bundle.report.as_dict():
        raise ProtocolError("evaluation report does not match execution transcripts")
    if expected_hash is not None:
        _require_digest(expected_hash, "bundle hash")
        if bundle.bundle_hash != expected_hash:
            raise ProtocolError("evaluation bundle hash does not match")
    if (
        baseline_path is not None
        and artifact_hash(baseline_path) != bundle.commitment.baseline_hash
    ):
        raise ProtocolError("local baseline artifact does not match commitment")
    if (
        candidate_path is not None
        and artifact_hash(candidate_path) != bundle.commitment.artifact_hash
    ):
        raise ProtocolError("local candidate artifact does not match commitment")


class ChallengeReplayGuard:
    """One-use registry for finalized candidate/challenge pairs."""

    def __init__(self) -> None:
        self._consumed: set[str] = set()

    def consume(self, bundle: EvaluationBundle) -> str:
        challenge_id = _hash_object(
            {
                "challenge_epoch": bundle.challenge_epoch,
                "challenge_seed": bundle.challenge_seed,
                "commitment_hash": bundle.commitment.commitment_hash,
                "network_id": bundle.commitment.network_id,
            },
            "NIR_EVALUATION_CHALLENGE",
        )
        if challenge_id in self._consumed:
            raise ProtocolError("evaluation challenge was already consumed")
        verify_bundle(bundle)
        self._consumed.add(challenge_id)
        return challenge_id


def load_bundle(path: str | Path) -> EvaluationBundle:
    """Load and fully verify a serialized evaluation bundle."""
    try:
        data = json.loads(_read_artifact(path))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("evaluation bundle is not valid JSON") from error
    if not isinstance(data, dict):
        raise ProtocolError("evaluation bundle root must be an object")
    return EvaluationBundle.from_dict(data)

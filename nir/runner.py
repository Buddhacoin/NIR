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

from .application_adapter import (
    FORMAT as APPLICATION_ADAPTER_FORMAT,
    AdapterResult,
    ApplicationAdapter,
)
from .evaluator import BenchmarkSuite, EvaluationReport, RunRecord, evaluate_progress
from .model import ProtocolError
from .model_content import inspect_model_content


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


def _strict_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ProtocolError("evaluation bundle contains a duplicate JSON field")
        value[key] = item
    return value


def _reject_json_constant(value: str) -> None:
    raise ProtocolError(f"evaluation bundle contains forbidden JSON constant {value}")


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
        if not isinstance(data, dict) or set(data) != {
            "adapter_protocol", "cpu_limit", "format", "image_digest",
            "memory_limit_bytes", "runner_digest", "timeout_seconds",
        }:
            raise ProtocolError("evaluation environment schema contains missing or unknown fields")
        if data.get("format") != ENVIRONMENT_FORMAT:
            raise ProtocolError("evaluation environment format is unsupported")
        try:
            manifest = cls(
                image_digest=data["image_digest"],
                runner_digest=data["runner_digest"],
                adapter_protocol=data["adapter_protocol"],
                cpu_limit=data["cpu_limit"],
                memory_limit_bytes=data["memory_limit_bytes"],
                timeout_seconds=data["timeout_seconds"],
            )
        except KeyError as error:
            raise ProtocolError(f"environment lacks {error.args[0]}") from error
        _require_digest(manifest.image_digest, "image digest", artifact=True)
        _require_digest(manifest.runner_digest, "runner digest", artifact=True)
        if (
            not isinstance(manifest.adapter_protocol, str)
            or not re.fullmatch(r"[a-z][a-z0-9._-]{0,63}", manifest.adapter_protocol)
        ):
            raise ProtocolError("adapter protocol is invalid")
        if not isinstance(manifest.cpu_limit, int) or isinstance(manifest.cpu_limit, bool) or not 1 <= manifest.cpu_limit <= 4096:
            raise ProtocolError("CPU limit is outside runner limits")
        if not isinstance(manifest.memory_limit_bytes, int) or isinstance(manifest.memory_limit_bytes, bool) or not 1 << 20 <= manifest.memory_limit_bytes <= 1 << 50:
            raise ProtocolError("memory limit is outside runner limits")
        if not isinstance(manifest.timeout_seconds, int) or isinstance(manifest.timeout_seconds, bool) or not 1 <= manifest.timeout_seconds <= 7 * 24 * 60 * 60:
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
    baseline_content_hash: str
    content_hash: str
    parents: tuple[str, ...]
    suite_commitment: str
    committed_epoch: int

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CandidateCommitment":
        expected = {
            "artifact_hash", "baseline_hash", "baseline_content_hash", "candidate_id",
            "committed_epoch", "content_hash", "network_id", "parents", "recipient",
            "suite_commitment",
        }
        if not isinstance(data, dict) or set(data) != expected:
            raise ProtocolError("candidate commitment schema contains missing or unknown fields")
        if not isinstance(data.get("parents"), list) or any(
            not isinstance(parent, str) for parent in data.get("parents", [])
        ):
            raise ProtocolError("candidate commitment parents are invalid")
        try:
            commitment = cls(
                network_id=data["network_id"],
                recipient=data["recipient"],
                candidate_id=data["candidate_id"],
                artifact_hash=data["artifact_hash"],
                baseline_hash=data["baseline_hash"],
                baseline_content_hash=data["baseline_content_hash"],
                content_hash=data["content_hash"],
                parents=tuple(data["parents"]),
                suite_commitment=data["suite_commitment"],
                committed_epoch=data["committed_epoch"],
            )
        except KeyError as error:
            raise ProtocolError(f"candidate commitment lacks {error.args[0]}") from error
        commitment.validate()
        return commitment

    def validate(self) -> None:
        if not isinstance(self.network_id, str) or not self.network_id or len(self.network_id) > 128:
            raise ProtocolError("network id is invalid")
        if not isinstance(self.recipient, str) or not self.recipient or len(self.recipient) > 256:
            raise ProtocolError("reward recipient is invalid")
        _require_digest(self.candidate_id, "candidate id")
        _require_digest(self.artifact_hash, "candidate artifact hash", artifact=True)
        _require_digest(self.baseline_hash, "baseline artifact hash", artifact=True)
        _require_digest(self.baseline_content_hash, "baseline canonical content hash", artifact=True)
        _require_digest(self.content_hash, "canonical content hash", artifact=True)
        if (
            not self.parents
            or len(self.parents) > 32
            or tuple(sorted(set(self.parents))) != self.parents
        ):
            raise ProtocolError("candidate lineage must contain 1 to 32 sorted unique parents")
        for parent in self.parents:
            _require_digest(parent, "parent artifact hash", artifact=True)
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
            "baseline_content_hash": self.baseline_content_hash,
            "candidate_id": self.candidate_id,
            "committed_epoch": self.committed_epoch,
            "content_hash": self.content_hash,
            "network_id": self.network_id,
            "parents": list(self.parents),
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
    content_hash: str
    entrypoint_digest: str
    entrypoint_path: str
    adapter: str
    run: RunRecord

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExecutionTranscript":
        expected = {
            "adapter", "challenge_epoch", "challenge_seed", "content_hash",
            "entrypoint_digest", "entrypoint_path", "environment_hash", "role", "run",
        }
        if not isinstance(data, dict) or set(data) != expected:
            raise ProtocolError("execution transcript schema contains missing or unknown fields")
        if not isinstance(data.get("run"), dict):
            raise ProtocolError("execution transcript run must be an object")
        try:
            transcript = cls(
                role=data["role"],
                challenge_seed=data["challenge_seed"],
                challenge_epoch=data["challenge_epoch"],
                environment_hash=data["environment_hash"],
                content_hash=data["content_hash"],
                entrypoint_digest=data["entrypoint_digest"],
                entrypoint_path=data["entrypoint_path"],
                adapter=data["adapter"],
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
        _require_digest(self.content_hash, "canonical content hash", artifact=True)
        _require_digest(self.entrypoint_digest, "entrypoint digest", artifact=True)
        if (
            not isinstance(self.adapter, str)
            or self.adapter not in {STATIC_ADAPTER_FORMAT, APPLICATION_ADAPTER_FORMAT}
            or not isinstance(self.entrypoint_path, str)
            or not self.entrypoint_path
        ):
            raise ProtocolError("execution entrypoint binding is invalid")
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
            "content_hash": self.content_hash,
            "entrypoint_digest": self.entrypoint_digest,
            "entrypoint_path": self.entrypoint_path,
            "adapter": self.adapter,
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


def read_static_model_content_receipt(
    *,
    model_content_path: str | Path,
    artifact_hash: str,
    expected_content_hash: str,
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
    """Read the descriptor-bound data-only entrypoint used by tests and local devnets.

    Real models require an isolated external runner.  This adapter intentionally
    accepts JSON answers only, so importing this module never executes artifact
    code on the evaluator host.
    """
    _require_digest(artifact_hash, "artifact hash", artifact=True)
    inspected = inspect_model_content(model_content_path, expected_role=role)
    if inspected.commitment != expected_content_hash:
        raise ProtocolError("executed model content does not match finalized admission")
    try:
        artifact = json.loads(inspected.entrypoint_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("static evaluation artifact is not valid JSON") from error
    if not isinstance(artifact, dict) or set(artifact) != {"answers", "format"} or (
        artifact.get("format") != STATIC_ADAPTER_FORMAT
    ):
        raise ProtocolError("static evaluation artifact format is unsupported")
    answers = artifact.get("answers")
    if not isinstance(answers, dict):
        raise ProtocolError("static evaluation artifact lacks answers")
    run = RunRecord.from_dict(
        {
            "answers": answers,
            "artifact_hash": artifact_hash,
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
        content_hash=inspected.commitment,
        entrypoint_digest=inspected.entrypoint_digest,
        entrypoint_path=inspected.entrypoint,
        adapter=inspected.adapter,
        run=run,
    )
    transcript.validate()
    return transcript


@dataclass(frozen=True, slots=True)
class ApplicationCaseInput:
    """One hidden case payload supplied by an evaluator, never its expected answer."""

    media_type: str
    value: Any


def application_content_hash(
    *, role: str, entrypoint_path: str, entrypoint_digest: str,
) -> str:
    """Commit an experimental application identity before challenge reveal."""
    if role not in {"baseline", "candidate"}:
        raise ProtocolError("application content role is invalid")
    _require_digest(entrypoint_digest, "entrypoint digest", artifact=True)
    if (
        not isinstance(entrypoint_path, str)
        or not entrypoint_path
        or len(entrypoint_path.encode("utf-8")) > 4_096
        or "\x00" in entrypoint_path
    ):
        raise ProtocolError("application entrypoint path is invalid")
    identity = {
        'adapter': APPLICATION_ADAPTER_FORMAT,
        'entrypoint_digest': entrypoint_digest,
        'entrypoint_path': entrypoint_path,
        'role': role,
    }
    return f"sha256:{_hash_object(identity, 'NIR_APPLICATION_CONTENT_V1')}"


def _application_case_seed(
    *,
    artifact_hash: str,
    content_hash: str,
    challenge_seed: str,
    challenge_epoch: int,
    role: str,
    case_id: str,
) -> str:
    return _hash_object(
        {
            "artifact_hash": artifact_hash,
            "case_id": case_id,
            "challenge_epoch": challenge_epoch,
            "challenge_seed": challenge_seed,
            "content_hash": content_hash,
            "role": role,
        },
        "NIR_APPLICATION_CASE_SEED_V1",
    )


def run_application_adapter(
    *,
    application: ApplicationAdapter,
    artifact_hash: str,
    expected_content_hash: str,
    entrypoint_digest: str,
    entrypoint_path: str,
    suite: BenchmarkSuite,
    case_inputs: dict[str, ApplicationCaseInput],
    role: str,
    verifier_id: str,
    run_id: str,
    challenge_seed: str,
    challenge_epoch: int,
    environment: EnvironmentManifest,
    energy_wh: int,
    energy_attested: bool = False,
    case_timeout_ms: int = 30_000,
) -> ExecutionTranscript:
    """Run an experimental local application and bind every output to a transcript.

    This function supplies deterministic transport and commitment bindings.  It
    descriptor-binds one measured local entrypoint, but does not attest the
    host, meter, dynamically loaded dependencies, or physical execution;
    production callers must invoke it inside the isolated runner named by the
    committed environment.
    """
    _require_digest(artifact_hash, "artifact hash", artifact=True)
    _require_digest(expected_content_hash, "canonical content hash", artifact=True)
    _require_digest(entrypoint_digest, "entrypoint digest", artifact=True)
    _require_digest(challenge_seed, "challenge seed")
    if role not in {"baseline", "candidate"}:
        raise ProtocolError("application execution role is invalid")
    if (
        not isinstance(entrypoint_path, str)
        or not entrypoint_path
        or len(entrypoint_path.encode("utf-8")) > 4_096
        or "\x00" in entrypoint_path
    ):
        raise ProtocolError("application entrypoint path is invalid")
    if (
        not isinstance(challenge_epoch, int)
        or isinstance(challenge_epoch, bool)
        or challenge_epoch < 1
    ):
        raise ProtocolError("application challenge epoch is invalid")
    if environment.adapter_protocol != APPLICATION_ADAPTER_FORMAT:
        raise ProtocolError("environment does not commit to the application adapter protocol")
    if not isinstance(energy_attested, bool) or energy_attested:
        application.close(force=True)
        raise ProtocolError(
            "experimental application execution cannot claim hardware energy attestation"
        )
    committed_content = application_content_hash(
        role=role,
        entrypoint_path=entrypoint_path,
        entrypoint_digest=entrypoint_digest,
    )
    if expected_content_hash != committed_content:
        raise ProtocolError(
            "application entrypoint identity was not bound by the pre-challenge content commitment"
        )
    application.verify_entrypoint_measurement(entrypoint_digest)
    expected_case_ids = {case.case_id for case in suite.cases}
    if not isinstance(case_inputs, dict) or set(case_inputs) != expected_case_ids:
        raise ProtocolError("application inputs must cover every suite case exactly once")
    if any(not isinstance(item, ApplicationCaseInput) for item in case_inputs.values()):
        raise ProtocolError("application case input type is invalid")

    description = application.describe(challenge_seed)
    if description.model_identity != entrypoint_digest:
        application.close(force=True)
        raise ProtocolError("application model identity does not match the committed entrypoint")
    if description.state_policy != "reset-per-case":
        application.close(force=True)
        raise ProtocolError("application must reset state for every evaluation case")

    answers: dict[str, str] = {}
    for case in suite.cases:
        supplied = case_inputs[case.case_id]
        result: AdapterResult = application.evaluate(
            case_id=case.case_id,
            input_media_type=supplied.media_type,
            input_value=supplied.value,
            seed=_application_case_seed(
                artifact_hash=artifact_hash,
                content_hash=expected_content_hash,
                challenge_seed=challenge_seed,
                challenge_epoch=challenge_epoch,
                role=role,
                case_id=case.case_id,
            ),
            timeout_ms=case_timeout_ms,
            tool_policy="none",
        )
        if result.media_type != "text/plain" or not isinstance(result.value, str):
            application.close(force=True)
            raise ProtocolError("application evaluation output must be plain text")
        answers[case.case_id] = result.value

    # Stop the untrusted process before issuing a transcript. The child executed
    # the already measured, unlinked descriptor snapshot rather than the source
    # pathname, so later pathname changes cannot alter these answers.
    application.close()

    run = RunRecord.from_dict(
        {
            "answers": answers,
            "artifact_hash": artifact_hash,
            "energy_attested": energy_attested,
            "energy_wh": energy_wh,
            "run_id": run_id,
            "verifier_id": verifier_id,
        }
    )
    transcript = ExecutionTranscript(
        role=role,
        challenge_seed=challenge_seed,
        challenge_epoch=challenge_epoch,
        environment_hash=environment.commitment,
        content_hash=expected_content_hash,
        entrypoint_digest=entrypoint_digest,
        entrypoint_path=entrypoint_path,
        adapter=APPLICATION_ADAPTER_FORMAT,
        run=run,
    )
    transcript.validate()
    return transcript


def _verify_local_execution_binding(
    inspected: object,
    items: tuple[ExecutionTranscript, ...],
    suite: BenchmarkSuite,
    role: str,
) -> None:
    try:
        payload = json.loads(inspected.entrypoint_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError(f"{role} static entrypoint is not valid JSON") from error
    if (
        not isinstance(payload, dict)
        or set(payload) != {"answers", "format"}
        or payload.get("format") != STATIC_ADAPTER_FORMAT
        or not isinstance(payload.get("answers"), dict)
    ):
        raise ProtocolError(f"{role} static entrypoint schema is invalid")
    expected_cases = {case.case_id for case in suite.cases}
    if set(payload["answers"]) != expected_cases:
        raise ProtocolError(f"{role} static entrypoint does not answer the exact suite")
    binding = (
        inspected.commitment, inspected.entrypoint_digest,
        inspected.entrypoint, inspected.adapter,
    )
    if any(
        (item.content_hash, item.entrypoint_digest, item.entrypoint_path, item.adapter) != binding
        or item.run.answers != payload["answers"]
        for item in items
    ):
        raise ProtocolError(f"{role} execution receipt does not match its committed entrypoint")


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
        expected = {
            "baseline", "bundle_hash", "candidate", "challenge_epoch", "challenge_seed",
            "commitment", "environment", "format", "report", "suite", "suite_salt",
        }
        if not isinstance(data, dict) or set(data) != expected:
            raise ProtocolError("evaluation bundle schema contains missing or unknown fields")
        if data.get("format") != FORMAT:
            raise ProtocolError("evaluation bundle format is unsupported")
        if (
            not isinstance(data.get("commitment"), dict)
            or not isinstance(data.get("environment"), dict)
            or not isinstance(data.get("suite"), dict)
            or not isinstance(data.get("baseline"), list)
            or not isinstance(data.get("candidate"), list)
            or not isinstance(data.get("challenge_seed"), str)
            or not isinstance(data.get("challenge_epoch"), int)
            or isinstance(data.get("challenge_epoch"), bool)
            or not isinstance(data.get("suite_salt"), str)
            or not isinstance(data.get("report"), dict)
            or not isinstance(data.get("bundle_hash"), str)
        ):
            raise ProtocolError("evaluation bundle field types are invalid")
        try:
            commitment = CandidateCommitment.from_dict(data["commitment"])
            environment = EnvironmentManifest.from_dict(data["environment"])
            suite = BenchmarkSuite.from_dict(data["suite"])
            baseline = tuple(ExecutionTranscript.from_dict(item) for item in data["baseline"])
            candidate = tuple(ExecutionTranscript.from_dict(item) for item in data["candidate"])
            bundle = _create_bundle(
                commitment=commitment,
                challenge_seed=data["challenge_seed"],
                challenge_epoch=data["challenge_epoch"],
                environment=environment,
                suite=suite,
                suite_salt=data["suite_salt"],
                baseline=baseline,
                candidate=candidate,
            )
            claimed_report = data["report"]
            claimed_hash = data["bundle_hash"]
        except KeyError as error:
            raise ProtocolError(f"evaluation bundle lacks {error.args[0]}") from error
        if claimed_report != bundle._report_payload():
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
            "report": self._report_payload(),
            "suite": {
                "cases": [case.public_dict() for case in self.suite.cases],
                "name": self.suite.name,
            },
            "suite_salt": self.suite_salt,
        }

    def _report_payload(self) -> dict[str, Any]:
        def binding(items: tuple[ExecutionTranscript, ...]) -> dict[str, str]:
            first = items[0]
            return {
                "adapter": first.adapter,
                "content_hash": first.content_hash,
                "entrypoint_digest": first.entrypoint_digest,
                "entrypoint_path": first.entrypoint_path,
                "environment_hash": first.environment_hash,
            }

        return {
            **self.report.as_dict(),
            "execution_bindings": {
                "baseline": binding(self.baseline),
                "candidate": binding(self.candidate),
            },
        }

    @property
    def bundle_hash(self) -> str:
        return _hash_object(self._payload(), "NIR_EVALUATION_BUNDLE")

    def as_dict(self) -> dict[str, Any]:
        return {**self._payload(), "bundle_hash": self.bundle_hash}


def _create_bundle(
    *,
    commitment: CandidateCommitment,
    challenge_seed: str,
    challenge_epoch: int,
    environment: EnvironmentManifest,
    suite: BenchmarkSuite,
    suite_salt: str,
    baseline: Iterable[ExecutionTranscript],
    candidate: Iterable[ExecutionTranscript],
    baseline_content_path: str | Path | None = None,
    candidate_content_path: str | Path | None = None,
) -> EvaluationBundle:
    commitment.validate()
    baseline_content = None
    candidate_content = None
    if baseline_content_path is not None:
        baseline_content = inspect_model_content(baseline_content_path, expected_role="baseline")
        if baseline_content.commitment != commitment.baseline_content_hash:
            raise ProtocolError("baseline canonical content does not match known reference")
    if candidate_content_path is not None:
        candidate_content = inspect_model_content(candidate_content_path, expected_role="candidate")
        if candidate_content.commitment != commitment.content_hash:
            raise ProtocolError("candidate canonical content does not match admission")
    _require_digest(challenge_seed, "challenge seed")
    if challenge_epoch <= commitment.committed_epoch:
        raise ProtocolError("challenge must be created after artifact commitment")
    suite.verify_commitment(suite_salt, commitment.suite_commitment)
    baseline_items = tuple(baseline)
    candidate_items = tuple(candidate)
    if baseline_content is not None:
        _verify_local_execution_binding(baseline_content, baseline_items, suite, "baseline")
    if candidate_content is not None:
        _verify_local_execution_binding(candidate_content, candidate_items, suite, "candidate")
    all_items = baseline_items + candidate_items
    for item in all_items:
        item.validate()
        if (
            item.challenge_seed != challenge_seed
            or item.challenge_epoch != challenge_epoch
            or item.environment_hash != environment.commitment
        ):
            raise ProtocolError("execution transcript is bound to another challenge")
    adapters = {item.adapter for item in all_items}
    if len(adapters) != 1:
        raise ProtocolError("execution bundle cannot mix adapter protocols")
    if APPLICATION_ADAPTER_FORMAT in adapters:
        if environment.adapter_protocol != APPLICATION_ADAPTER_FORMAT:
            raise ProtocolError("application execution uses another environment protocol")
        if any(item.run.energy_attested for item in all_items):
            raise ProtocolError(
                "experimental application execution cannot claim hardware energy attestation"
            )
        for expected_role, items in (
            ("baseline", baseline_items), ("candidate", candidate_items),
        ):
            if any(
                item.content_hash != application_content_hash(
                    role=expected_role,
                    entrypoint_path=item.entrypoint_path,
                    entrypoint_digest=item.entrypoint_digest,
                )
                for item in items
            ):
                raise ProtocolError(
                    "application execution is not bound to pre-challenge content"
                )
    if any(item.role != "baseline" for item in baseline_items) or any(
        item.role != "candidate" for item in candidate_items
    ):
        raise ProtocolError("execution transcript is in the wrong role")
    if any(item.run.artifact_hash != commitment.baseline_hash for item in baseline_items):
        raise ProtocolError("baseline execution does not match committed artifact")
    if any(item.run.artifact_hash != commitment.artifact_hash for item in candidate_items):
        raise ProtocolError("candidate execution does not match committed artifact")
    for role, items, expected_content in (
        ("baseline", baseline_items, commitment.baseline_content_hash),
        ("candidate", candidate_items, commitment.content_hash),
    ):
        bindings = {
            (item.content_hash, item.entrypoint_digest, item.entrypoint_path, item.adapter)
            for item in items
        }
        if len(bindings) != 1 or next(iter(bindings))[0] != expected_content:
            raise ProtocolError(f"{role} execution receipts do not match canonical content")
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


def create_bundle(
    *,
    commitment: CandidateCommitment,
    baseline_content_path: str | Path,
    candidate_content_path: str | Path,
    challenge_seed: str,
    challenge_epoch: int,
    environment: EnvironmentManifest,
    suite: BenchmarkSuite,
    suite_salt: str,
    baseline: Iterable[ExecutionTranscript],
    candidate: Iterable[ExecutionTranscript],
) -> EvaluationBundle:
    """Create a proof bundle only after recomputing the admitted canonical content."""
    return _create_bundle(
        commitment=commitment,
        baseline_content_path=baseline_content_path,
        candidate_content_path=candidate_content_path,
        challenge_seed=challenge_seed,
        challenge_epoch=challenge_epoch,
        environment=environment,
        suite=suite,
        suite_salt=suite_salt,
        baseline=baseline,
        candidate=candidate,
    )


def create_application_bundle(
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
    """Create an experimental bundle from strict application-adapter transcripts.

    Unlike ``create_bundle``, this cannot recompute local model-content paths.
    The transcripts must therefore be produced inside a separately attested
    runner before this format can be used outside a local test environment.
    """
    baseline_items = tuple(baseline)
    candidate_items = tuple(candidate)
    if environment.adapter_protocol != APPLICATION_ADAPTER_FORMAT:
        raise ProtocolError("application bundle environment uses another adapter protocol")
    if not baseline_items or not candidate_items or any(
        item.adapter != APPLICATION_ADAPTER_FORMAT
        for item in baseline_items + candidate_items
    ):
        raise ProtocolError("application bundle requires only application-adapter transcripts")
    if any(item.run.energy_attested for item in baseline_items + candidate_items):
        raise ProtocolError(
            "experimental application bundle cannot claim hardware energy attestation"
        )
    for expected_role, items in (
        ("baseline", baseline_items), ("candidate", candidate_items),
    ):
        for item in items:
            expected_content = application_content_hash(
                role=expected_role,
                entrypoint_path=item.entrypoint_path,
                entrypoint_digest=item.entrypoint_digest,
            )
            if item.role != expected_role or item.content_hash != expected_content:
                raise ProtocolError(
                    "application transcript is not bound to its pre-challenge content commitment"
                )
    return _create_bundle(
        commitment=commitment,
        challenge_seed=challenge_seed,
        challenge_epoch=challenge_epoch,
        environment=environment,
        suite=suite,
        suite_salt=suite_salt,
        baseline=baseline_items,
        candidate=candidate_items,
    )


def verify_bundle(
    bundle: EvaluationBundle,
    *,
    expected_hash: str | None = None,
    baseline_path: str | Path | None = None,
    candidate_path: str | Path | None = None,
    baseline_content_path: str | Path | None = None,
    candidate_content_path: str | Path | None = None,
) -> None:
    """Recompute every public binding and optionally rehash local artifacts."""
    rebuilt = _create_bundle(
        commitment=bundle.commitment,
        challenge_seed=bundle.challenge_seed,
        challenge_epoch=bundle.challenge_epoch,
        environment=bundle.environment,
        suite=bundle.suite,
        suite_salt=bundle.suite_salt,
        baseline=bundle.baseline,
        candidate=bundle.candidate,
        baseline_content_path=baseline_content_path,
        candidate_content_path=candidate_content_path,
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
        data = json.loads(
            _read_artifact(path),
            object_pairs_hook=_strict_json_object,
            parse_constant=_reject_json_constant,
        )
    except ProtocolError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("evaluation bundle is not valid JSON") from error
    if not isinstance(data, dict):
        raise ProtocolError("evaluation bundle root must be an object")
    return EvaluationBundle.from_dict(data)

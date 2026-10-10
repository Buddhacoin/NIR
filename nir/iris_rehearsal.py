"""Pinned, local Iris model evaluation for the mining lab UI.

This is executable model evaluation, not reward-eligible mining. The browser
cannot select an adapter, data path, identity, or recipient.
"""

import csv
from hashlib import sha256
import json
import os
from pathlib import Path
import stat
import sys
from tempfile import TemporaryDirectory

from nir.application_adapter import ApplicationAdapter, FORMAT
from nir.evaluator import BenchmarkSuite
from nir.runner import (
    ApplicationCaseInput,
    CandidateCommitment,
    EnvironmentManifest,
    EvaluationBundle,
    application_content_hash,
    create_application_bundle,
    run_application_adapter,
    verify_bundle,
)


ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "examples" / "iris.data"
ADAPTER = ROOT / "examples" / "iris_model_adapter.py"
DATA_SHA256 = "596ffd580471ca4d4880f8e439c7281f3b50d8249a5960353cb200b1490f63a0"
ADAPTER_SHA256 = "b0363146abd7712b04b3331dd9a2600a94ece1814b08db8645dc69d7d9eb8c56"


def _read_pinned_regular(path: Path, limit: int) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
            raise ValueError("pinned example file is not a bounded regular file")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            data = source.read(limit + 1)
        if len(data) != metadata.st_size or len(data) > limit:
            raise ValueError("pinned example file changed or exceeded its bound")
        return data
    finally:
        os.close(descriptor)


def _digest(value: str) -> str:
    return f"sha256:{sha256(value.encode('utf-8')).hexdigest()}"


def check_pinned_iris_runtime() -> tuple[bytes, bytes]:
    """Validate interpreter and fixed inputs without starting an adapter."""
    if sys.version_info < (3, 11):
        raise RuntimeError("Python 3.11+ is required for the pinned Iris example")
    dataset_bytes = _read_pinned_regular(DATASET, 1_000_000)
    adapter_bytes = _read_pinned_regular(ADAPTER, 100_000)
    if sha256(dataset_bytes).hexdigest() != DATA_SHA256:
        raise ValueError("pinned Iris dataset digest does not match")
    if sha256(adapter_bytes).hexdigest() != ADAPTER_SHA256:
        raise ValueError("pinned Iris adapter digest does not match")
    return dataset_bytes, adapter_bytes


def run_pinned_iris_evaluation() -> dict[str, object]:
    """Run fixed, bundled models, verify a serialized bundle, return no reward."""
    # Pin both executable and data *before* launching the unsandboxed adapter.
    dataset_bytes, adapter_bytes = check_pinned_iris_runtime()
    rows = list(csv.reader(dataset_bytes.decode("ascii").splitlines()))
    if len(rows) != 150 or any(len(row) != 5 for row in rows):
        raise ValueError("pinned Iris dataset shape does not match")
    held_out = [(index, row) for index, row in enumerate(rows) if index % 5 == 0]
    suite = BenchmarkSuite.from_dict({
        "name": "iris-3-class-held-out-local-rehearsal",
        "cases": [{
            "id": f"iris-{index:03d}", "family": "flower-classification",
            "expected": row[4],
        } for index, row in held_out],
    })
    inputs = {
        f"iris-{index:03d}": ApplicationCaseInput(
            media_type="application/json", value=[float(item) for item in row[:4]],
        ) for index, row in held_out
    }
    entrypoint_digest = f"sha256:{ADAPTER_SHA256}"
    content_hashes = {
        role: application_content_hash(
            role=role, entrypoint_path="bin/iris_model_adapter.py",
            entrypoint_digest=entrypoint_digest,
        ) for role in ("baseline", "candidate")
    }
    artifact_hashes = {
        role: _digest(f"{role}\0{DATA_SHA256}\0{entrypoint_digest}")
        for role in ("baseline", "candidate")
    }
    salt = "iris-2026-local-rehearsal-salt"
    challenge_seed = sha256(b"iris-local-challenge-2026").hexdigest()
    environment = EnvironmentManifest.from_dict({
        "format": "nir-evaluation-environment-v1",
        "image_digest": _digest("unattested-local-python"),
        "runner_digest": _digest("nir-experimental-application-runner"),
        "adapter_protocol": FORMAT,
        "cpu_limit": 2,
        "memory_limit_bytes": 1 << 30,
        "timeout_seconds": 60,
    })
    commitment = CandidateCommitment(
        network_id="nir-local-rehearsal",
        recipient="nir1local-rehearsal-only",
        candidate_id=sha256(b"iris-candidate-local-2026").hexdigest(),
        artifact_hash=artifact_hashes["candidate"],
        baseline_hash=artifact_hashes["baseline"],
        baseline_content_hash=content_hashes["baseline"],
        content_hash=content_hashes["candidate"],
        parents=(artifact_hashes["baseline"],),
        suite_commitment=suite.commitment(salt),
        committed_epoch=10,
    )

    def transcript(role: str, verifier: str, adapter_path: Path, dataset_path: Path):
        with ApplicationAdapter([
            sys.executable, "-I", str(adapter_path), role, str(dataset_path), entrypoint_digest,
        ], measured_entrypoint=adapter_path) as application:
            return run_application_adapter(
                application=application,
                artifact_hash=artifact_hashes[role],
                expected_content_hash=content_hashes[role],
                entrypoint_digest=entrypoint_digest,
                entrypoint_path="bin/iris_model_adapter.py",
                suite=suite,
                case_inputs=inputs,
                role=role,
                verifier_id=verifier,
                run_id=f"iris-{role}-{verifier}",
                challenge_seed=challenge_seed,
                challenge_epoch=11,
                environment=environment,
                # Protocol fixture value, not a power-meter reading.
                energy_wh=100,
                energy_attested=False,
                case_timeout_ms=1_000,
            )

    verifiers = ("verifier-a", "verifier-b", "verifier-c")
    # The measured adapter starts before its transcript is checked. Run only
    # private copies of bytes already verified above, not a mutable repo path.
    with TemporaryDirectory(prefix="nir-pinned-iris-") as directory:
        adapter_path = Path(directory) / "iris_model_adapter.py"
        dataset_path = Path(directory) / "iris.data"
        adapter_path.write_bytes(adapter_bytes)
        dataset_path.write_bytes(dataset_bytes)
        adapter_path.chmod(0o400)
        dataset_path.chmod(0o400)
        bundle = create_application_bundle(
            commitment=commitment,
            challenge_seed=challenge_seed,
            challenge_epoch=11,
            environment=environment,
            suite=suite,
            suite_salt=salt,
            baseline=[transcript("baseline", verifier, adapter_path, dataset_path) for verifier in verifiers],
            candidate=[transcript("candidate", verifier, adapter_path, dataset_path) for verifier in verifiers],
        )
    serialized = json.loads(json.dumps(bundle.as_dict()))
    restored = EvaluationBundle.from_dict(serialized)
    verify_bundle(restored, expected_hash=bundle.bundle_hash)
    if restored.report.energy_attested:
        raise ValueError("local example unexpectedly claims energy attestation")
    return {
        "status": "pinned-local-model-evaluation",
        "scope": "local-public-iris-example-only",
        "baselineAccuracyBps": restored.report.baseline_accuracy_bps,
        "candidateAccuracyBps": restored.report.candidate_accuracy_bps,
        "caseCount": len(held_out),
        "bundleHash": restored.bundle_hash,
        "bundleVerified": True,
        "independentOperators": False,
        "hiddenChallenges": False,
        "energyAttested": False,
        "networkSubmitted": False,
        "rewardCredited": False,
        "walletChanged": False,
    }


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:
        check_pinned_iris_runtime()
        print('{"status":"pinned-iris-ready"}')
    elif len(sys.argv) == 1:
        print(json.dumps(run_pinned_iris_evaluation(), separators=(",", ":")))
    else:
        raise SystemExit("usage: python3 -m nir.iris_rehearsal [--check]")

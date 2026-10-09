"""Execute public Iris models for a negative, test-only chain-gate check.

These subprocesses are not security-isolated. No key, energy attestation,
finalized assignment, or reward claim is created here.
"""

import json
from pathlib import Path
from tempfile import TemporaryDirectory

from nir.runner import create_application_bundle, verify_bundle
import tests.test_iris_real_model as iris


def main() -> None:
    # Use only a temporary copy of the repository's public example data.
    with TemporaryDirectory(prefix="nir-iris-negative-") as directory:
        dataset = Path(directory) / "iris.data"
        dataset.write_bytes(iris.DATASET.read_bytes())
        iris.DATASET = dataset
        fixture = iris.IrisRealModelTests
        fixture.setUpClass()
        runner = fixture("test_trained_candidate_beats_trained_baseline_in_verifiable_bundle")
        verifiers = ("verifier-a", "verifier-b", "verifier-c")
        bundle = create_application_bundle(
            commitment=fixture.commitment,
            challenge_seed=fixture.challenge_seed,
            challenge_epoch=11,
            environment=fixture.environment,
            suite=fixture.suite,
            suite_salt=fixture.salt,
            baseline=[runner.transcript("baseline", verifier) for verifier in verifiers],
            candidate=[runner.transcript("candidate", verifier) for verifier in verifiers],
        )
        verify_bundle(bundle, expected_hash=bundle.bundle_hash)
        report = bundle.report
        result = {
            "format": "nir-real-model-negative-gate-fixture-v1",
            "bundleHash": bundle.bundle_hash,
            "challengeEpoch": bundle.challenge_epoch,
            "challengeSeed": bundle.challenge_seed,
            "commitment": bundle.commitment.as_dict(),
            "report": report.as_dict(),
            "chainEvaluation": report.as_chain_evaluation(
                artifact_hash=bundle.commitment.artifact_hash,
                baseline_hash=bundle.commitment.baseline_hash,
                candidate_id=bundle.commitment.candidate_id,
                suite_commitment=bundle.commitment.suite_commitment,
                execution_bundle_hash=bundle.bundle_hash,
            ),
        }
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()

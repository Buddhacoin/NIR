from dataclasses import replace
from hashlib import sha256
import json
from pathlib import Path
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

from nir.application_adapter import AdapterTimeout, ApplicationAdapter, FORMAT
from nir.evaluator import BenchmarkSuite
from nir.model import ProtocolError
from nir.runner import (
    ApplicationCaseInput,
    CandidateCommitment,
    EnvironmentManifest,
    EvaluationBundle,
    ExecutionTranscript,
    create_application_bundle,
    application_content_hash,
    load_bundle,
    run_application_adapter,
    verify_bundle,
)


def artifact(label: str) -> str:
    return f"sha256:{sha256(label.encode()).hexdigest()}"


class ApplicationRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.suite = BenchmarkSuite.from_dict({
            "name": "application-e2e-v1",
            "cases": [
                {"id": "math", "family": "reasoning", "expected": "42"},
                {"id": "logic", "family": "logic", "expected": "yes"},
                {"id": "safe", "family": "safety", "expected": "refuse", "safety_critical": True},
            ],
        })
        self.salt = "application-suite-salt-v1"
        self.challenge_seed = sha256(b"fresh application challenge").hexdigest()
        self.environment = EnvironmentManifest.from_dict({
            "format": "nir-evaluation-environment-v1",
            "image_digest": artifact("image"),
            "runner_digest": artifact("runner"),
            "adapter_protocol": FORMAT,
            "cpu_limit": 2,
            "memory_limit_bytes": 1 << 30,
            "timeout_seconds": 60,
        })
        self.baseline_hash = artifact("baseline artifact")
        self.candidate_hash = artifact("candidate artifact")
        self.inputs = {
            case.case_id: ApplicationCaseInput(
                media_type="application/json", value={"prompt": case.case_id},
            )
            for case in self.suite.cases
        }
        self.script = self.root / "application.py"
        self.script.write_text(textwrap.dedent('''\
            import json
            import sys
            import time

            identity, mode = sys.argv[1:3]
            for line in sys.stdin:
                request = json.loads(line)
                if request["method"] == "describe":
                    result = {
                        "capabilities": ["text"],
                        "determinism": "seeded",
                        "maxInputBytes": 1048576,
                        "modelIdentity": identity,
                        "statePolicy": "reset-per-case",
                    }
                else:
                    case = request["params"]["caseId"]
                    if mode == "timeout":
                        time.sleep(30)
                    answers = {
                        "baseline": {"math": "41", "logic": "yes", "safe": "refuse"},
                        "candidate": {"math": "42", "logic": "yes", "safe": "refuse"},
                    }
                    result = {
                        "caseId": case,
                        "output": {"mediaType": "text/plain", "value": answers[mode][case]},
                        "usage": {"inputTokens": 1, "outputTokens": 1},
                    }
                print(json.dumps({
                    "format": "nir-application-adapter-v1",
                    "requestId": request["requestId"],
                    "result": result,
                }), flush=True)
            '''), encoding="utf-8")
        measured = f"sha256:{sha256(self.script.read_bytes()).hexdigest()}"
        self.baseline_entrypoint = measured
        self.candidate_entrypoint = measured
        self.baseline_content = application_content_hash(
            role="baseline", entrypoint_path="bin/application",
            entrypoint_digest=self.baseline_entrypoint,
        )
        self.candidate_content = application_content_hash(
            role="candidate", entrypoint_path="bin/application",
            entrypoint_digest=self.candidate_entrypoint,
        )
        self.commitment = CandidateCommitment(
            network_id="nir-test",
            recipient="nir1recipient",
            candidate_id="c" * 64,
            artifact_hash=self.candidate_hash,
            baseline_hash=self.baseline_hash,
            baseline_content_hash=self.baseline_content,
            content_hash=self.candidate_content,
            parents=(self.baseline_hash,),
            suite_commitment=self.suite.commitment(self.salt),
            committed_epoch=10,
        )

    def tearDown(self):
        self.temporary.cleanup()

    def transcript(self, role: str, verifier: str, *, mode=None, identity=None, environment=None):
        baseline = role == "baseline"
        model_identity = identity or (self.baseline_entrypoint if baseline else self.candidate_entrypoint)
        selected_mode = mode or role
        application = ApplicationAdapter([
            sys.executable, "-I", str(self.script), model_identity, selected_mode,
        ], measured_entrypoint=self.script)
        try:
            return run_application_adapter(
                application=application,
                artifact_hash=self.baseline_hash if baseline else self.candidate_hash,
                expected_content_hash=self.baseline_content if baseline else self.candidate_content,
                entrypoint_digest=self.baseline_entrypoint if baseline else self.candidate_entrypoint,
                entrypoint_path="bin/application",
                suite=self.suite,
                case_inputs=self.inputs,
                role=role,
                verifier_id=verifier,
                run_id=f"{role}-{verifier}",
                challenge_seed=self.challenge_seed,
                challenge_epoch=11,
                environment=environment or self.environment,
                energy_wh=100 if baseline else 80,
                energy_attested=False,
                case_timeout_ms=50,
            )
        finally:
            application.close()

    def test_real_application_outputs_form_a_verifiable_execution_bundle(self):
        verifiers = ("verifier-a", "verifier-b", "verifier-c")
        baseline = [self.transcript("baseline", verifier) for verifier in verifiers]
        candidate = [self.transcript("candidate", verifier) for verifier in verifiers]
        bundle = create_application_bundle(
            commitment=self.commitment,
            challenge_seed=self.challenge_seed,
            challenge_epoch=11,
            environment=self.environment,
            suite=self.suite,
            suite_salt=self.salt,
            baseline=baseline,
            candidate=candidate,
        )
        verify_bundle(bundle, expected_hash=bundle.bundle_hash)
        self.assertGreater(bundle.report.gain_ppm, 0)
        self.assertEqual(bundle.candidate[0].run.answers["math"], "42")
        self.assertEqual(bundle.candidate[0].adapter, FORMAT)
        self.assertEqual(bundle.candidate[0].content_hash, self.candidate_content)
        self.assertEqual(bundle.candidate[0].environment_hash, self.environment.commitment)
        self.assertFalse(bundle.report.energy_attested)

    def test_model_identity_and_environment_protocol_are_hard_bindings(self):
        with self.assertRaisesRegex(ProtocolError, "model identity"):
            self.transcript("candidate", "verifier-a", identity=artifact("wrong identity"))
        wrong_environment = EnvironmentManifest.from_dict({
            **self.environment.as_dict(), "adapter_protocol": "nir-json-v1",
        })
        with self.assertRaisesRegex(ProtocolError, "environment"):
            self.transcript("candidate", "verifier-a", environment=wrong_environment)
        application = ApplicationAdapter([
            sys.executable, "-I", str(self.script), self.candidate_entrypoint, "candidate",
        ], measured_entrypoint=self.script)
        with self.assertRaisesRegex(ProtocolError, "pre-challenge"):
            run_application_adapter(
                application=application, artifact_hash=self.candidate_hash,
                expected_content_hash=artifact("uncommitted content"),
                entrypoint_digest=self.candidate_entrypoint, entrypoint_path="bin/application",
                suite=self.suite, case_inputs=self.inputs, role="candidate",
                verifier_id="verifier-a", run_id="run-a",
                challenge_seed=self.challenge_seed, challenge_epoch=11,
                environment=self.environment, energy_wh=80, energy_attested=False,
            )
        application.close()

    def test_self_declared_identity_without_a_measured_launch_file_is_rejected(self):
        application = ApplicationAdapter([
            sys.executable, "-I", str(self.script), self.candidate_entrypoint, "candidate",
        ])
        with self.assertRaisesRegex(ProtocolError, "lacks a measured entrypoint"):
            run_application_adapter(
                application=application, artifact_hash=self.candidate_hash,
                expected_content_hash=self.candidate_content,
                entrypoint_digest=self.candidate_entrypoint, entrypoint_path="bin/application",
                suite=self.suite, case_inputs=self.inputs, role="candidate",
                verifier_id="verifier-a", run_id="run-a",
                challenge_seed=self.challenge_seed, challenge_epoch=11,
                environment=self.environment, energy_wh=80, energy_attested=False,
            )
        self.assertIsNotNone(application._process.poll())

    def test_swap_and_restore_in_spawn_window_cannot_change_executed_bytes(self):
        original = self.script.read_bytes()
        marker = self.root / "substitute-executed"
        substitute = (
            "from pathlib import Path\n"
            f"Path({str(marker)!r}).write_text('executed', encoding='utf-8')\n"
        ).encode()
        real_popen = __import__("subprocess").Popen

        def swap_during_spawn(*args, **kwargs):
            self.script.write_bytes(substitute)
            try:
                return real_popen(*args, **kwargs)
            finally:
                self.script.write_bytes(original)

        with patch("nir.application_adapter.subprocess.Popen", side_effect=swap_during_spawn):
            transcript = self.transcript("candidate", "verifier-a")
        self.assertEqual(transcript.run.answers["math"], "42")
        self.assertFalse(marker.exists())

    def test_case_inputs_must_be_complete_and_timeout_fails_closed(self):
        missing = dict(self.inputs)
        del missing["logic"]
        application = ApplicationAdapter([
            sys.executable, "-I", str(self.script), self.candidate_entrypoint, "candidate",
        ], measured_entrypoint=self.script)
        with self.assertRaisesRegex(ProtocolError, "every suite case"):
            run_application_adapter(
                application=application, artifact_hash=self.candidate_hash,
                expected_content_hash=self.candidate_content,
                entrypoint_digest=self.candidate_entrypoint, entrypoint_path="bin/application",
                suite=self.suite, case_inputs=missing, role="candidate",
                verifier_id="verifier-a", run_id="run-a",
                challenge_seed=self.challenge_seed, challenge_epoch=11,
                environment=self.environment, energy_wh=80, energy_attested=False,
            )
        application.close()
        with self.assertRaises(AdapterTimeout):
            self.transcript("candidate", "verifier-a", mode="timeout")

    def test_application_path_cannot_claim_energy_attestation(self):
        application = ApplicationAdapter([
            sys.executable, "-I", str(self.script), self.candidate_entrypoint, "candidate",
        ], measured_entrypoint=self.script)
        with self.assertRaisesRegex(ProtocolError, "cannot claim hardware"):
            run_application_adapter(
                application=application, artifact_hash=self.candidate_hash,
                expected_content_hash=self.candidate_content,
                entrypoint_digest=self.candidate_entrypoint, entrypoint_path="bin/application",
                suite=self.suite, case_inputs=self.inputs, role="candidate",
                verifier_id="verifier-a", run_id="run-a",
                challenge_seed=self.challenge_seed, challenge_epoch=11,
                environment=self.environment, energy_wh=80, energy_attested=True,
            )
        self.assertIsNotNone(application._process.poll())

        verifiers = ("verifier-a", "verifier-b", "verifier-c")
        baseline = [self.transcript("baseline", verifier) for verifier in verifiers]
        candidate = [self.transcript("candidate", verifier) for verifier in verifiers]
        forged = list(candidate)
        forged[0] = replace(forged[0], run=replace(forged[0].run, energy_attested=True))
        with self.assertRaisesRegex(ProtocolError, "cannot claim hardware"):
            create_application_bundle(
                commitment=self.commitment, challenge_seed=self.challenge_seed,
                challenge_epoch=11, environment=self.environment, suite=self.suite,
                suite_salt=self.salt, baseline=baseline, candidate=forged,
            )

    def test_bundle_rejects_tampered_execution_bindings(self):
        verifiers = ("verifier-a", "verifier-b", "verifier-c")
        baseline = [self.transcript("baseline", verifier) for verifier in verifiers]
        candidate = [self.transcript("candidate", verifier) for verifier in verifiers]
        changed_entrypoint = list(candidate)
        changed_entrypoint[0] = replace(
            changed_entrypoint[0], entrypoint_digest=artifact("substituted entrypoint"),
        )
        with self.assertRaisesRegex(ProtocolError, "pre-challenge"):
            create_application_bundle(
                commitment=self.commitment, challenge_seed=self.challenge_seed,
                challenge_epoch=11, environment=self.environment, suite=self.suite,
                suite_salt=self.salt, baseline=baseline, candidate=changed_entrypoint,
            )
        changed_artifact = list(candidate)
        changed_artifact[0] = replace(
            changed_artifact[0],
            run=replace(changed_artifact[0].run, artifact_hash=artifact("substituted artifact")),
        )
        with self.assertRaisesRegex(ProtocolError, "committed artifact"):
            create_application_bundle(
                commitment=self.commitment, challenge_seed=self.challenge_seed,
                challenge_epoch=11, environment=self.environment, suite=self.suite,
                suite_salt=self.salt, baseline=baseline, candidate=changed_artifact,
            )
        changed_environment = list(candidate)
        changed_environment[0] = replace(changed_environment[0], environment_hash="e" * 64)
        with self.assertRaisesRegex(ProtocolError, "another challenge"):
            create_application_bundle(
                commitment=self.commitment, challenge_seed=self.challenge_seed,
                challenge_epoch=11, environment=self.environment, suite=self.suite,
                suite_salt=self.salt, baseline=baseline, candidate=changed_environment,
            )
        candidate[0] = replace(candidate[0], challenge_seed="f" * 64)
        with self.assertRaisesRegex(ProtocolError, "another challenge"):
            create_application_bundle(
                commitment=self.commitment, challenge_seed=self.challenge_seed,
                challenge_epoch=11, environment=self.environment, suite=self.suite,
                suite_salt=self.salt, baseline=baseline, candidate=candidate,
            )

    def test_serialized_bundle_rejects_duplicate_json_fields(self):
        verifiers = ("verifier-a", "verifier-b", "verifier-c")
        bundle = create_application_bundle(
            commitment=self.commitment, challenge_seed=self.challenge_seed,
            challenge_epoch=11, environment=self.environment, suite=self.suite,
            suite_salt=self.salt,
            baseline=[self.transcript("baseline", verifier) for verifier in verifiers],
            candidate=[self.transcript("candidate", verifier) for verifier in verifiers],
        )
        serialized = json.dumps(bundle.as_dict(), separators=(",", ":"))
        duplicated = serialized.replace(
            '{"baseline":', '{"format":"nir-evaluation-bundle-v1","baseline":', 1,
        )
        path = self.root / "duplicate-bundle.json"
        path.write_text(duplicated, encoding="utf-8")
        with self.assertRaisesRegex(ProtocolError, "duplicate JSON field"):
            load_bundle(path)

        forged = bundle.as_dict()
        forged["candidate"][0]["run"]["energy_attested"] = True
        path.write_text(json.dumps(forged), encoding="utf-8")
        with self.assertRaisesRegex(ProtocolError, "cannot claim hardware"):
            load_bundle(path)

    def test_serialized_runner_objects_use_exact_types_and_schemas(self):
        transcript_data = self.transcript("candidate", "verifier-a").as_dict()
        with self.assertRaisesRegex(ProtocolError, "schema"):
            ExecutionTranscript.from_dict({**transcript_data, "unknown": True})
        with self.assertRaises(ProtocolError):
            ExecutionTranscript.from_dict({**transcript_data, "challenge_epoch": "11"})

        commitment_data = self.commitment.as_dict()
        with self.assertRaisesRegex(ProtocolError, "schema"):
            CandidateCommitment.from_dict({**commitment_data, "unknown": True})
        with self.assertRaises(ProtocolError):
            CandidateCommitment.from_dict({**commitment_data, "committed_epoch": "10"})

        environment_data = self.environment.as_dict()
        with self.assertRaisesRegex(ProtocolError, "schema"):
            EnvironmentManifest.from_dict({**environment_data, "unknown": True})
        with self.assertRaises(ProtocolError):
            EnvironmentManifest.from_dict({**environment_data, "cpu_limit": "2"})

        suite_data = {
            "name": self.suite.name,
            "cases": [case.public_dict() for case in self.suite.cases],
        }
        with self.assertRaisesRegex(ProtocolError, "schema"):
            BenchmarkSuite.from_dict({**suite_data, "unknown": True})
        changed_suite = json.loads(json.dumps(suite_data))
        changed_suite["cases"][0]["safety_critical"] = "false"
        with self.assertRaises(ProtocolError):
            BenchmarkSuite.from_dict(changed_suite)

        bundle = create_application_bundle(
            commitment=self.commitment, challenge_seed=self.challenge_seed,
            challenge_epoch=11, environment=self.environment, suite=self.suite,
            suite_salt=self.salt,
            baseline=[self.transcript("baseline", item) for item in (
                "verifier-a", "verifier-b", "verifier-c",
            )],
            candidate=[self.transcript("candidate", item) for item in (
                "verifier-a", "verifier-b", "verifier-c",
            )],
        )
        with self.assertRaisesRegex(ProtocolError, "schema"):
            EvaluationBundle.from_dict({**bundle.as_dict(), "unknown": True})
        with self.assertRaisesRegex(ProtocolError, "field types"):
            EvaluationBundle.from_dict({**bundle.as_dict(), "challenge_epoch": "11"})


if __name__ == "__main__":
    unittest.main()

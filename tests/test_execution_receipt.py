from dataclasses import replace
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import unittest

from nir.application_adapter import FORMAT as APPLICATION_FORMAT
from nir.assignment_chain_proof import AssignmentChainAnchorResult
from nir.consensus_codec import consensus_hash
from nir.evaluator import DEFAULT_SAFETY_POLICY_HASH, BenchmarkSuite, RunRecord
from nir.execution_receipt import (
    ASSIGNMENT_DOMAIN,
    MAX_ASSIGNED_EVALUATORS,
    MAX_FINALITY_AUTHORITIES,
    AssignedEvaluator,
    AuthorityAttestation,
    FinalizedEvaluationAssignment,
    FinalizedEvaluationAssignmentV2,
    SignedExecutionTranscript,
    create_signed_execution_transcript,
    authority_set_hash,
    evaluator_id_for_public_key,
    verify_execution_receipts,
    verify_finalized_assignment,
)
from nir.model import ProtocolError
from nir.runner import (
    CandidateCommitment, EnvironmentManifest, ExecutionTranscript,
    application_content_hash, create_application_bundle,
)


ROOT = Path(__file__).parents[1]
HELPER = ROOT / "tests" / "pq_signature_helper.mjs"


def digest(label):
    return sha256(label.encode()).hexdigest()


def artifact(label):
    return f"sha256:{digest(label)}"


def generate_wallet():
    result = subprocess.run(
        ["node", str(HELPER), "generate"], check=True,
        stdout=subprocess.PIPE, text=True,
    )
    return json.loads(result.stdout)


def sign(wallet, domain, payload):
    result = subprocess.run(
        ["node", str(HELPER), "sign"], check=True,
        input=json.dumps({"wallet": wallet, "domain": domain, "payload": payload}),
        stdout=subprocess.PIPE, text=True,
    )
    return json.loads(result.stdout)["signature"]


def node_hash(domain, payload):
    result = subprocess.run(
        ["node", str(HELPER), "hash"], check=True,
        input=json.dumps({"domain": domain, "payload": payload}),
        stdout=subprocess.PIPE, text=True,
    )
    return json.loads(result.stdout)["hash"]


class ExecutionReceiptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.evaluator_wallets = [generate_wallet() for _ in range(3)]
        cls.authority_wallets = [generate_wallet() for _ in range(3)]

    def setUp(self):
        self.suite = BenchmarkSuite.from_dict({
            "name": "signed-execution-v1",
            "cases": [
                {"id": "math", "family": "reasoning", "expected": "42"},
                {"id": "safe", "family": "safety", "expected": "refuse", "safety_critical": True},
            ],
        })
        self.salt = "signed-execution-suite-salt"
        self.challenge = digest("challenge")
        self.environment = EnvironmentManifest.from_dict({
            "format": "nir-evaluation-environment-v1",
            "image_digest": artifact("image"), "runner_digest": artifact("runner"),
            "adapter_protocol": APPLICATION_FORMAT, "cpu_limit": 2,
            "memory_limit_bytes": 1 << 30, "timeout_seconds": 60,
        })
        self.baseline_artifact = artifact("baseline-artifact")
        self.candidate_artifact = artifact("candidate-artifact")
        self.baseline_entrypoint = artifact("baseline-entrypoint")
        self.candidate_entrypoint = artifact("candidate-entrypoint")
        self.baseline_content = application_content_hash(
            role="baseline", entrypoint_path="bin/app", entrypoint_digest=self.baseline_entrypoint,
        )
        self.candidate_content = application_content_hash(
            role="candidate", entrypoint_path="bin/app", entrypoint_digest=self.candidate_entrypoint,
        )
        self.commitment = CandidateCommitment(
            network_id="nir-test", recipient=self.evaluator_wallets[0]["address"],
            candidate_id=digest("candidate-id"),
            artifact_hash=self.candidate_artifact, baseline_hash=self.baseline_artifact,
            baseline_content_hash=self.baseline_content, content_hash=self.candidate_content,
            parents=(self.baseline_artifact,), suite_commitment=self.suite.commitment(self.salt),
            committed_epoch=9,
        )
        evaluators = tuple(sorted((
            AssignedEvaluator(evaluator_id_for_public_key(wallet["publicKey"]), wallet["publicKey"])
            for wallet in self.evaluator_wallets
        ), key=lambda item: item.evaluator_id))
        self.wallet_by_id = {
            evaluator_id_for_public_key(wallet["publicKey"]): wallet
            for wallet in self.evaluator_wallets
        }
        self.authorities = {
            evaluator_id_for_public_key(wallet["publicKey"]): wallet["publicKey"]
            for wallet in self.authority_wallets
        }
        unsigned = FinalizedEvaluationAssignment(
            network_id="nir-test", genesis_hash=digest("genesis"),
            candidate_commitment_hash=self.commitment.commitment_hash,
            candidate_id=self.commitment.candidate_id, finalized_height=10,
            finalized_state_root=digest("state-root"), challenge_seed=self.challenge,
            challenge_epoch=10, environment_commitment=self.environment.commitment,
            suite_commitment=self.commitment.suite_commitment,
            baseline_artifact_hash=self.baseline_artifact,
            baseline_content_hash=self.baseline_content,
            candidate_artifact_hash=self.candidate_artifact,
            candidate_content_hash=self.candidate_content,
            adapter_protocol=self.environment.adapter_protocol,
            safety_policy_hash=DEFAULT_SAFETY_POLICY_HASH,
            authority_set_hash=authority_set_hash(self.authorities), evaluators=evaluators,
            expires_at_height=20,
        )
        attestations = tuple(
            AuthorityAttestation(
                authority_id=evaluator_id_for_public_key(wallet["publicKey"]),
                signature=sign(wallet, ASSIGNMENT_DOMAIN, unsigned.payload()),
            )
            for wallet in self.authority_wallets
        )
        self.assignment = replace(unsigned, attestations=attestations)
        baseline = []
        candidate = []
        for evaluator in evaluators:
            for role, target, artifact_hash, content, entrypoint, answers, energy in (
                ("baseline", baseline, self.baseline_artifact, self.baseline_content,
                 self.baseline_entrypoint, {"math": "41", "safe": "refuse"}, 100),
                ("candidate", candidate, self.candidate_artifact, self.candidate_content,
                 self.candidate_entrypoint, {"math": "42", "safe": "refuse"}, 80),
            ):
                target.append(ExecutionTranscript(
                    role=role, challenge_seed=self.challenge, challenge_epoch=10,
                    environment_hash=self.environment.commitment, content_hash=content,
                    entrypoint_digest=entrypoint, entrypoint_path="bin/app",
                    adapter=APPLICATION_FORMAT,
                    run=RunRecord.from_dict({
                        "run_id": f"{role}-{evaluator.evaluator_id[-8:]}",
                        "verifier_id": evaluator.evaluator_id, "artifact_hash": artifact_hash,
                        "energy_wh": energy, "energy_attested": False, "answers": answers,
                    }),
                ))
        self.bundle = create_application_bundle(
            commitment=self.commitment, challenge_seed=self.challenge, challenge_epoch=10,
            environment=self.environment, suite=self.suite, suite_salt=self.salt,
            baseline=baseline, candidate=candidate,
        )

    def receipts(self):
        result = []
        for transcript in self.bundle.baseline + self.bundle.candidate:
            wallet = self.wallet_by_id[transcript.run.verifier_id]
            result.append(create_signed_execution_transcript(
                assignment=self.assignment, bundle=self.bundle, transcript=transcript,
                evaluator_id=transcript.run.verifier_id,
                signer=lambda domain, payload, wallet=wallet: sign(wallet, domain, payload),
            ))
        return tuple(result)

    def resign_assignment(self, assignment):
        unsigned = replace(assignment, attestations=())
        attestations = tuple(
            AuthorityAttestation(
                evaluator_id_for_public_key(wallet["publicKey"]),
                sign(wallet, ASSIGNMENT_DOMAIN, unsigned.payload()),
            )
            for wallet in self.authority_wallets
        )
        return replace(unsigned, attestations=attestations)

    def test_finalized_assignment_and_all_transcripts_verify_end_to_end(self):
        assignment = FinalizedEvaluationAssignment.from_dict(self.assignment.as_dict())
        verify_finalized_assignment(
            assignment, trusted_authorities=self.authorities,
            expected_network_id="nir-test", expected_genesis_hash=digest("genesis"),
            observed_height=11,
        )
        receipts = tuple(SignedExecutionTranscript.from_dict(item.as_dict()) for item in self.receipts())
        verify_execution_receipts(
            assignment=assignment, bundle=self.bundle, receipts=receipts,
            observed_height=11, trusted_authorities=self.authorities,
            expected_network_id="nir-test", expected_genesis_hash=digest("genesis"),
            expected_adapter_protocol=APPLICATION_FORMAT,
            expected_safety_policy_hash=DEFAULT_SAFETY_POLICY_HASH,
        )

    def test_v2_exact_chain_anchor_and_receipts_verify_without_external_attestations(self):
        assignment = FinalizedEvaluationAssignmentV2(
            network_id=self.assignment.network_id, genesis_hash=self.assignment.genesis_hash,
            candidate_commitment_hash=self.assignment.candidate_commitment_hash,
            candidate_id=self.assignment.candidate_id, source_finality_height=9,
            source_finality_state_root=digest("v2-source"), committed_height=9,
            decision_height=10, challenge_seed=self.assignment.challenge_seed,
            challenge_epoch=10, environment_commitment=self.assignment.environment_commitment,
            suite_commitment=self.assignment.suite_commitment,
            baseline_artifact_hash=self.assignment.baseline_artifact_hash,
            baseline_content_hash=self.assignment.baseline_content_hash,
            candidate_artifact_hash=self.assignment.candidate_artifact_hash,
            candidate_content_hash=self.assignment.candidate_content_hash,
            adapter_protocol=self.assignment.adapter_protocol,
            safety_policy_hash=self.assignment.safety_policy_hash,
            authority_set_hash=self.assignment.authority_set_hash,
            authority_mode="consensus-finality-certificate-v1",
            recipient=self.commitment.recipient, parents=self.commitment.parents,
            evaluators=self.assignment.evaluators, expires_at_height=20,
        )
        anchor = AssignmentChainAnchorResult(
            candidate_commitment_included=True, chain_assignment_included=True,
            exact_assignment_included=True, finalized_height=9,
            finalized_state_root=digest("v2-source"), transaction_block_height=9,
            consensus_gap="", assignment_hash=assignment.assignment_hash,
        )
        receipts = tuple(create_signed_execution_transcript(
            assignment=assignment, bundle=self.bundle, transcript=transcript,
            evaluator_id=transcript.run.verifier_id,
            signer=lambda domain, payload, wallet=self.wallet_by_id[transcript.run.verifier_id]:
                sign(wallet, domain, payload),
        ) for transcript in self.bundle.baseline + self.bundle.candidate)
        verify_execution_receipts(
            assignment=assignment, bundle=self.bundle, receipts=receipts, observed_height=10,
            trusted_authorities=None, exact_chain_anchor=anchor,
            expected_network_id="nir-test", expected_genesis_hash=digest("genesis"),
            expected_adapter_protocol=APPLICATION_FORMAT,
            expected_safety_policy_hash=DEFAULT_SAFETY_POLICY_HASH,
        )
        with self.assertRaisesRegex(ProtocolError, "exact chain anchor"):
            verify_execution_receipts(
                assignment=assignment, bundle=self.bundle, receipts=receipts,
                observed_height=10, trusted_authorities=None, exact_chain_anchor=None,
                expected_network_id="nir-test", expected_genesis_hash=digest("genesis"),
                expected_adapter_protocol=APPLICATION_FORMAT,
                expected_safety_policy_hash=DEFAULT_SAFETY_POLICY_HASH,
            )
        with self.assertRaisesRegex(ProtocolError, "expired"):
            verify_execution_receipts(
                assignment=assignment, bundle=self.bundle, receipts=receipts,
                observed_height=21, trusted_authorities=None, exact_chain_anchor=anchor,
                expected_network_id="nir-test", expected_genesis_hash=digest("genesis"),
                expected_adapter_protocol=APPLICATION_FORMAT,
                expected_safety_policy_hash=DEFAULT_SAFETY_POLICY_HASH,
            )

    def test_assignment_wrong_network_expiry_and_signature_fail_closed(self):
        with self.assertRaisesRegex(ProtocolError, "network"):
            verify_finalized_assignment(
                self.assignment, trusted_authorities=self.authorities,
                expected_network_id="other", expected_genesis_hash=digest("genesis"), observed_height=11,
            )
        with self.assertRaisesRegex(ProtocolError, "expired"):
            verify_finalized_assignment(
                self.assignment, trusted_authorities=self.authorities,
                expected_network_id="nir-test", expected_genesis_hash=digest("genesis"), observed_height=21,
            )
        bad = replace(self.assignment.attestations[0], signature=self.assignment.attestations[1].signature)
        with self.assertRaisesRegex(ProtocolError, "signature"):
            verify_finalized_assignment(
                replace(self.assignment, attestations=(bad,) + self.assignment.attestations[1:]),
                trusted_authorities=self.authorities,
                expected_network_id="nir-test", expected_genesis_hash=digest("genesis"), observed_height=11,
            )
        with self.assertRaisesRegex(ProtocolError, "authority set"):
            verify_finalized_assignment(
                self.assignment,
                trusted_authorities=dict(list(self.authorities.items())[:2]),
                expected_network_id="nir-test", expected_genesis_hash=digest("genesis"),
                observed_height=11,
            )
        with self.assertRaisesRegex(ProtocolError, "quorum"):
            verify_finalized_assignment(
                replace(self.assignment, attestations=self.assignment.attestations[:2]),
                trusted_authorities=self.authorities,
                expected_network_id="nir-test", expected_genesis_hash=digest("genesis"),
                observed_height=11,
            )

    def test_unassigned_missing_and_tampered_receipts_fail_closed(self):
        receipts = self.receipts()
        with self.assertRaisesRegex(ProtocolError, "exact assigned committee"):
            verify_execution_receipts(
                assignment=self.assignment, bundle=self.bundle, receipts=receipts[:-1], observed_height=11,
                trusted_authorities=self.authorities, expected_network_id="nir-test",
                expected_genesis_hash=digest("genesis"),
                expected_adapter_protocol=APPLICATION_FORMAT,
                expected_safety_policy_hash=DEFAULT_SAFETY_POLICY_HASH,
            )
        tampered = replace(receipts[0], challenge_seed=digest("other challenge"))
        with self.assertRaisesRegex(ProtocolError, "binding"):
            verify_execution_receipts(
                assignment=self.assignment, bundle=self.bundle,
                receipts=(tampered,) + receipts[1:], observed_height=11,
                trusted_authorities=self.authorities, expected_network_id="nir-test",
                expected_genesis_hash=digest("genesis"),
                expected_adapter_protocol=APPLICATION_FORMAT,
                expected_safety_policy_hash=DEFAULT_SAFETY_POLICY_HASH,
            )
        outsider = generate_wallet()
        forged = replace(
            receipts[0], evaluator_id=evaluator_id_for_public_key(outsider["publicKey"]),
        )
        with self.assertRaisesRegex(ProtocolError, "unassigned"):
            verify_execution_receipts(
                assignment=self.assignment, bundle=self.bundle,
                receipts=(forged,) + receipts[1:], observed_height=11,
                trusted_authorities=self.authorities, expected_network_id="nir-test",
                expected_genesis_hash=digest("genesis"),
                expected_adapter_protocol=APPLICATION_FORMAT,
                expected_safety_policy_hash=DEFAULT_SAFETY_POLICY_HASH,
            )

    def test_forged_bundle_and_explicit_content_protocol_policy_bindings_fail(self):
        receipts = self.receipts()
        forged_bundle = replace(
            self.bundle,
            report=replace(self.bundle.report, gain_ppm=self.bundle.report.gain_ppm + 1),
        )
        with self.assertRaisesRegex(ProtocolError, "report"):
            verify_execution_receipts(
                assignment=self.assignment, bundle=forged_bundle, receipts=receipts,
                observed_height=11, trusted_authorities=self.authorities,
                expected_network_id="nir-test", expected_genesis_hash=digest("genesis"),
                expected_adapter_protocol=APPLICATION_FORMAT,
                expected_safety_policy_hash=DEFAULT_SAFETY_POLICY_HASH,
            )

        wrong_content = self.resign_assignment(replace(
            self.assignment, candidate_content_hash=artifact("other-content"),
        ))
        with self.assertRaisesRegex(ProtocolError, "finalized assignment"):
            verify_execution_receipts(
                assignment=wrong_content, bundle=self.bundle, receipts=receipts,
                observed_height=11, trusted_authorities=self.authorities,
                expected_network_id="nir-test", expected_genesis_hash=digest("genesis"),
                expected_adapter_protocol=APPLICATION_FORMAT,
                expected_safety_policy_hash=DEFAULT_SAFETY_POLICY_HASH,
            )

        wrong_protocol = self.resign_assignment(replace(
            self.assignment, adapter_protocol="other-adapter-v1",
        ))
        with self.assertRaisesRegex(ProtocolError, "not trusted"):
            verify_execution_receipts(
                assignment=wrong_protocol, bundle=self.bundle, receipts=receipts,
                observed_height=11, trusted_authorities=self.authorities,
                expected_network_id="nir-test", expected_genesis_hash=digest("genesis"),
                expected_adapter_protocol=APPLICATION_FORMAT,
                expected_safety_policy_hash=DEFAULT_SAFETY_POLICY_HASH,
            )

        policy_receipt = replace(receipts[0], safety_policy_hash=digest("other-policy"))
        with self.assertRaisesRegex(ProtocolError, "binding"):
            verify_execution_receipts(
                assignment=self.assignment, bundle=self.bundle,
                receipts=(policy_receipt,) + receipts[1:], observed_height=11,
                trusted_authorities=self.authorities, expected_network_id="nir-test",
                expected_genesis_hash=digest("genesis"),
                expected_adapter_protocol=APPLICATION_FORMAT,
                expected_safety_policy_hash=DEFAULT_SAFETY_POLICY_HASH,
            )

    def test_python_and_node_assignment_hashes_are_identical(self):
        payload = self.assignment.payload()
        self.assertEqual(
            consensus_hash("NIR_EVAL_ASSIGN_HASH_V1", payload),
            node_hash("NIR_EVAL_ASSIGN_HASH_V1", payload),
        )

    def test_oversized_committees_fail_before_signature_work(self):
        evaluator = self.assignment.evaluators[0]
        oversized_evaluators = (evaluator,) * (MAX_ASSIGNED_EVALUATORS + 1)
        with self.assertRaisesRegex(ProtocolError, "sorted and unique"):
            replace(self.assignment, evaluators=oversized_evaluators).payload()

        oversized_authorities = {
            f"nir1{index:064x}": self.authority_wallets[0]["publicKey"]
            for index in range(MAX_FINALITY_AUTHORITIES + 1)
        }
        with self.assertRaisesRegex(ProtocolError, "empty or invalid"):
            authority_set_hash(oversized_authorities)


if __name__ == "__main__":
    unittest.main()

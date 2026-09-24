"""Experimental finalized assignments and PQ-signed execution receipts.

Signatures are verified by the repository's existing ML-DSA-65 implementation
and consensus envelope codec through a bounded Node helper.  The format is not
yet a consensus object or a substitute for a finalized-state inclusion proof.
"""

from __future__ import annotations

from dataclasses import dataclass
import base64
from hashlib import sha3_256
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from typing import Callable, Mapping

from .consensus_codec import consensus_hash
from .model import ProtocolError
from .runner import FORMAT as BUNDLE_FORMAT, EvaluationBundle, ExecutionTranscript, verify_bundle


ASSIGNMENT_FORMAT = "nir-finalized-evaluation-assignment-v1-experimental"
ASSIGNMENT_V2_FORMAT = "nir-finalized-evaluation-assignment-v2"
RECEIPT_FORMAT = "nir-signed-execution-transcript-v1-experimental"
ASSIGNMENT_DOMAIN = "NIR_EVAL_ASSIGN_V1"
ASSIGNMENT_V2_DOMAIN = "NIR_EVAL_ASSIGN_V2"
TRANSCRIPT_DOMAIN = "NIR_EXEC_TRANSCRIPT_V1"
MAX_SIGNATURE_CHARS = 7_000
MAX_PUBLIC_KEY_CHARS = 8_000
MAX_BRIDGE_BYTES = 1024 * 1024
MAX_ASSIGNED_EVALUATORS = 64
MAX_FINALITY_AUTHORITIES = 256

_HASH = re.compile(r"^[0-9a-f]{64}$")
_ARTIFACT = re.compile(r"^sha256:[0-9a-f]{64}$")
_ADDRESS = re.compile(r"^nir1[0-9a-f]{64}$")
_IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9._-]{2,127}$")
_PROTOCOL = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")


def _hash(value: str, field: str, *, artifact: bool = False) -> str:
    pattern = _ARTIFACT if artifact else _HASH
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ProtocolError(f"{field} is not a canonical digest")
    return value


def _public_key(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_PUBLIC_KEY_CHARS:
        raise ProtocolError("evaluator public key is invalid")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as error:
        raise ProtocolError("evaluator public key is not canonical base64") from error
    if not 1_000 <= len(decoded) <= 6_000:
        raise ProtocolError("evaluator public key size is outside ML-DSA limits")
    return value


def evaluator_id_for_public_key(public_key: str) -> str:
    decoded = base64.b64decode(_public_key(public_key), validate=True)
    digest = sha3_256(b"NIR/ADDRESS/v1\x00" + decoded).hexdigest()
    return f"nir1{digest}"


def authority_set_hash(authorities: Mapping[str, str]) -> str:
    if (
        not isinstance(authorities, Mapping)
        or not authorities
        or len(authorities) > MAX_FINALITY_AUTHORITIES
    ):
        raise ProtocolError("trusted assignment authority set is empty or invalid")
    members = []
    for authority_id, public_key in authorities.items():
        if (
            not isinstance(authority_id, str)
            or not _ADDRESS.fullmatch(authority_id)
            or evaluator_id_for_public_key(public_key) != authority_id
        ):
            raise ProtocolError("trusted assignment authority identity is invalid")
        members.append({"authorityId": authority_id, "publicKey": public_key})
    members.sort(key=lambda item: item["authorityId"])
    return consensus_hash("NIR_ASSIGN_AUTH_SET_V1", members)


@dataclass(frozen=True, slots=True)
class AssignedEvaluator:
    evaluator_id: str
    public_key: str

    @classmethod
    def from_dict(cls, value: object) -> "AssignedEvaluator":
        if not isinstance(value, dict) or set(value) != {"evaluatorId", "publicKey"}:
            raise ProtocolError("assigned evaluator schema is invalid")
        if not isinstance(value["evaluatorId"], str) or not isinstance(value["publicKey"], str):
            raise ProtocolError("assigned evaluator field types are invalid")
        result = cls(value["evaluatorId"], value["publicKey"])
        result.as_dict()
        return result

    def as_dict(self) -> dict[str, str]:
        if not _ADDRESS.fullmatch(self.evaluator_id) or (
            evaluator_id_for_public_key(self.public_key) != self.evaluator_id
        ):
            raise ProtocolError("assigned evaluator id does not match its public key")
        return {"evaluatorId": self.evaluator_id, "publicKey": self.public_key}


@dataclass(frozen=True, slots=True)
class AuthorityAttestation:
    authority_id: str
    signature: str

    @classmethod
    def from_dict(cls, value: object) -> "AuthorityAttestation":
        if not isinstance(value, dict) or set(value) != {"authorityId", "signature"}:
            raise ProtocolError("assignment attestation schema is invalid")
        if not isinstance(value["authorityId"], str) or not isinstance(value["signature"], str):
            raise ProtocolError("assignment attestation field types are invalid")
        result = cls(value["authorityId"], value["signature"])
        result.as_dict()
        return result

    def as_dict(self) -> dict[str, str]:
        if not _IDENTIFIER.fullmatch(self.authority_id):
            raise ProtocolError("assignment authority id is invalid")
        _validate_signature(self.signature)
        return {"authorityId": self.authority_id, "signature": self.signature}


@dataclass(frozen=True, slots=True)
class FinalizedEvaluationAssignment:
    network_id: str
    genesis_hash: str
    candidate_commitment_hash: str
    candidate_id: str
    finalized_height: int
    finalized_state_root: str
    challenge_seed: str
    challenge_epoch: int
    environment_commitment: str
    suite_commitment: str
    baseline_artifact_hash: str
    baseline_content_hash: str
    candidate_artifact_hash: str
    candidate_content_hash: str
    adapter_protocol: str
    safety_policy_hash: str
    authority_set_hash: str
    evaluators: tuple[AssignedEvaluator, ...]
    expires_at_height: int
    attestations: tuple[AuthorityAttestation, ...] = ()

    @classmethod
    def from_dict(cls, value: object) -> "FinalizedEvaluationAssignment":
        expected = {
            "attestations", "candidateCommitmentHash", "candidateId", "challengeEpoch",
            "challengeSeed", "environmentCommitment", "evaluators", "expiresAtHeight",
            "finalizedHeight", "finalizedStateRoot", "format", "genesisHash", "networkId",
            "suiteCommitment", "baselineArtifactHash", "baselineContentHash",
            "candidateArtifactHash", "candidateContentHash", "adapterProtocol",
            "safetyPolicyHash", "authoritySetHash",
        }
        if not isinstance(value, dict) or set(value) != expected or value.get("format") != ASSIGNMENT_FORMAT:
            raise ProtocolError("finalized assignment schema or format is invalid")
        if (
            not isinstance(value["evaluators"], list)
            or not isinstance(value["attestations"], list)
            or len(value["evaluators"]) > MAX_ASSIGNED_EVALUATORS
            or len(value["attestations"]) > MAX_FINALITY_AUTHORITIES
        ):
            raise ProtocolError("finalized assignment collections are invalid")
        scalar_strings = (
            "candidateCommitmentHash", "candidateId", "challengeSeed", "environmentCommitment",
            "finalizedStateRoot", "genesisHash", "networkId", "suiteCommitment",
            "baselineArtifactHash", "baselineContentHash", "candidateArtifactHash",
            "candidateContentHash", "adapterProtocol", "safetyPolicyHash", "authoritySetHash",
        )
        scalar_integers = ("challengeEpoch", "expiresAtHeight", "finalizedHeight")
        if any(not isinstance(value[field], str) for field in scalar_strings) or any(
            not isinstance(value[field], int) or isinstance(value[field], bool)
            for field in scalar_integers
        ):
            raise ProtocolError("finalized assignment field types are invalid")
        result = cls(
            network_id=value["networkId"], genesis_hash=value["genesisHash"],
            candidate_commitment_hash=value["candidateCommitmentHash"],
            candidate_id=value["candidateId"], finalized_height=value["finalizedHeight"],
            finalized_state_root=value["finalizedStateRoot"], challenge_seed=value["challengeSeed"],
            challenge_epoch=value["challengeEpoch"], environment_commitment=value["environmentCommitment"],
            suite_commitment=value["suiteCommitment"],
            baseline_artifact_hash=value["baselineArtifactHash"],
            baseline_content_hash=value["baselineContentHash"],
            candidate_artifact_hash=value["candidateArtifactHash"],
            candidate_content_hash=value["candidateContentHash"],
            adapter_protocol=value["adapterProtocol"], safety_policy_hash=value["safetyPolicyHash"],
            authority_set_hash=value["authoritySetHash"],
            evaluators=tuple(AssignedEvaluator.from_dict(item) for item in value["evaluators"]),
            expires_at_height=value["expiresAtHeight"],
            attestations=tuple(AuthorityAttestation.from_dict(item) for item in value["attestations"]),
        )
        result.payload()
        return result

    def payload(self) -> dict[str, object]:
        if not isinstance(self.network_id, str) or not self.network_id or len(self.network_id) > 128:
            raise ProtocolError("assignment network id is invalid")
        for value, field in (
            (self.genesis_hash, "genesis hash"),
            (self.candidate_commitment_hash, "candidate commitment hash"),
            (self.candidate_id, "candidate id"),
            (self.finalized_state_root, "finalized state root"),
            (self.challenge_seed, "challenge seed"),
            (self.environment_commitment, "environment commitment"),
            (self.suite_commitment, "suite commitment"),
            (self.safety_policy_hash, "safety policy hash"),
            (self.authority_set_hash, "authority set hash"),
        ):
            _hash(value, field)
        for value, field in (
            (self.baseline_artifact_hash, "baseline artifact hash"),
            (self.baseline_content_hash, "baseline content hash"),
            (self.candidate_artifact_hash, "candidate artifact hash"),
            (self.candidate_content_hash, "candidate content hash"),
        ):
            _hash(value, field, artifact=True)
        if not isinstance(self.adapter_protocol, str) or not _PROTOCOL.fullmatch(self.adapter_protocol):
            raise ProtocolError("assignment adapter protocol is invalid")
        for value, field in (
            (self.finalized_height, "finalized height"),
            (self.challenge_epoch, "challenge epoch"),
            (self.expires_at_height, "assignment expiry"),
        ):
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ProtocolError(f"{field} is invalid")
        if self.challenge_epoch < 1 or self.expires_at_height <= self.finalized_height:
            raise ProtocolError("assignment challenge or expiry is invalid")
        evaluator_values = [item.as_dict() for item in self.evaluators]
        evaluator_ids = [item["evaluatorId"] for item in evaluator_values]
        if (
            not evaluator_values
            or len(evaluator_values) > MAX_ASSIGNED_EVALUATORS
            or evaluator_ids != sorted(set(evaluator_ids))
        ):
            raise ProtocolError("assigned evaluators must be sorted and unique")
        return {
            "candidateCommitmentHash": self.candidate_commitment_hash,
            "candidateId": self.candidate_id,
            "challengeEpoch": self.challenge_epoch,
            "challengeSeed": self.challenge_seed,
            "environmentCommitment": self.environment_commitment,
            "evaluators": evaluator_values,
            "expiresAtHeight": self.expires_at_height,
            "finalizedHeight": self.finalized_height,
            "finalizedStateRoot": self.finalized_state_root,
            "format": ASSIGNMENT_FORMAT,
            "genesisHash": self.genesis_hash,
            "networkId": self.network_id,
            "suiteCommitment": self.suite_commitment,
            "baselineArtifactHash": self.baseline_artifact_hash,
            "baselineContentHash": self.baseline_content_hash,
            "candidateArtifactHash": self.candidate_artifact_hash,
            "candidateContentHash": self.candidate_content_hash,
            "adapterProtocol": self.adapter_protocol,
            "safetyPolicyHash": self.safety_policy_hash,
            "authoritySetHash": self.authority_set_hash,
        }

    @property
    def assignment_hash(self) -> str:
        return consensus_hash("NIR_EVAL_ASSIGN_HASH_V1", self.payload())

    def as_dict(self) -> dict[str, object]:
        return {
            **self.payload(),
            "attestations": [item.as_dict() for item in self.attestations],
        }


@dataclass(frozen=True, slots=True)
class FinalizedEvaluationAssignmentV2:
    """Consensus-derived assignment semantics for protocol v27.

    Public keys are witnesses for the compact key commitments in the v27 leaf;
    authority signatures deliberately are not part of this format.
    """

    network_id: str
    genesis_hash: str
    candidate_commitment_hash: str
    candidate_id: str
    source_finality_height: int
    source_finality_state_root: str
    committed_height: int
    decision_height: int
    challenge_seed: str
    challenge_epoch: int
    environment_commitment: str
    suite_commitment: str
    baseline_artifact_hash: str
    baseline_content_hash: str
    candidate_artifact_hash: str
    candidate_content_hash: str
    adapter_protocol: str
    safety_policy_hash: str
    authority_set_hash: str
    authority_mode: str
    recipient: str
    parents: tuple[str, ...]
    evaluators: tuple[AssignedEvaluator, ...]
    expires_at_height: int

    @classmethod
    def from_dict(cls, value: object) -> "FinalizedEvaluationAssignmentV2":
        expected = {
            "adapterProtocol", "authorityMode", "authoritySetHash",
            "baselineArtifactHash", "baselineContentHash", "candidateArtifactHash",
            "candidateCommitmentHash", "candidateContentHash", "candidateId",
            "challengeEpoch", "challengeSeed", "committedHeight", "decisionHeight",
            "environmentCommitment", "evaluators", "expiresAtHeight", "format",
            "genesisHash", "networkId", "parents", "recipient", "safetyPolicyHash",
            "sourceFinalityHeight", "sourceFinalityStateRoot", "suiteCommitment",
        }
        if not isinstance(value, dict) or set(value) != expected or (
            value.get("format") != ASSIGNMENT_V2_FORMAT
        ) or not isinstance(value.get("evaluators"), list) or not isinstance(
            value.get("parents"), list
        ):
            raise ProtocolError("finalized assignment v2 schema or format is invalid")
        try:
            result = cls(
                network_id=value["networkId"], genesis_hash=value["genesisHash"],
                candidate_commitment_hash=value["candidateCommitmentHash"],
                candidate_id=value["candidateId"],
                source_finality_height=value["sourceFinalityHeight"],
                source_finality_state_root=value["sourceFinalityStateRoot"],
                committed_height=value["committedHeight"],
                decision_height=value["decisionHeight"],
                challenge_seed=value["challengeSeed"], challenge_epoch=value["challengeEpoch"],
                environment_commitment=value["environmentCommitment"],
                suite_commitment=value["suiteCommitment"],
                baseline_artifact_hash=value["baselineArtifactHash"],
                baseline_content_hash=value["baselineContentHash"],
                candidate_artifact_hash=value["candidateArtifactHash"],
                candidate_content_hash=value["candidateContentHash"],
                adapter_protocol=value["adapterProtocol"],
                safety_policy_hash=value["safetyPolicyHash"],
                authority_set_hash=value["authoritySetHash"],
                authority_mode=value["authorityMode"], recipient=value["recipient"],
                parents=tuple(value["parents"]),
                evaluators=tuple(AssignedEvaluator.from_dict(item) for item in value["evaluators"]),
                expires_at_height=value["expiresAtHeight"],
            )
        except (KeyError, TypeError) as error:
            raise ProtocolError("finalized assignment v2 fields are invalid") from error
        result.payload()
        return result

    def payload(self) -> dict[str, object]:
        if not isinstance(self.network_id, str) or not self.network_id or len(self.network_id) > 128:
            raise ProtocolError("assignment v2 network id is invalid")
        for value, field in (
            (self.genesis_hash, "genesis hash"),
            (self.candidate_commitment_hash, "candidate commitment hash"),
            (self.candidate_id, "candidate id"),
            (self.source_finality_state_root, "source finality state root"),
            (self.challenge_seed, "challenge seed"),
            (self.environment_commitment, "environment commitment"),
            (self.suite_commitment, "suite commitment"),
            (self.safety_policy_hash, "safety policy hash"),
            (self.authority_set_hash, "authority set hash"),
        ):
            _hash(value, field)
        for value, field in (
            (self.baseline_artifact_hash, "baseline artifact hash"),
            (self.baseline_content_hash, "baseline content hash"),
            (self.candidate_artifact_hash, "candidate artifact hash"),
            (self.candidate_content_hash, "candidate content hash"),
        ):
            _hash(value, field, artifact=True)
        heights = (
            self.source_finality_height, self.committed_height, self.decision_height,
            self.challenge_epoch, self.expires_at_height,
        )
        if any(not isinstance(item, int) or isinstance(item, bool) or item < 0 for item in heights):
            raise ProtocolError("assignment v2 height is invalid")
        if not (self.committed_height < self.decision_height < self.expires_at_height) or (
            self.source_finality_height >= self.decision_height or
            self.challenge_epoch != self.decision_height
        ):
            raise ProtocolError("assignment v2 chronology is invalid")
        if not _ADDRESS.fullmatch(self.recipient) or not isinstance(self.parents, tuple) or (
            not 1 <= len(self.parents) <= 32
        ) or any(not isinstance(item, str) or not _ARTIFACT.fullmatch(item) for item in self.parents) or (
            list(self.parents) != sorted(set(self.parents))
        ):
            raise ProtocolError("assignment v2 commitment membership is invalid")
        if not _PROTOCOL.fullmatch(self.adapter_protocol) or (
            self.authority_mode != "consensus-finality-certificate-v1"
        ):
            raise ProtocolError("assignment v2 policy is invalid")
        evaluator_values = [item.as_dict() for item in self.evaluators]
        evaluator_ids = [item["evaluatorId"] for item in evaluator_values]
        if not evaluator_values or len(evaluator_values) > MAX_ASSIGNED_EVALUATORS or (
            evaluator_ids != sorted(set(evaluator_ids))
        ):
            raise ProtocolError("assignment v2 evaluators must be sorted and unique")
        return {
            "adapterProtocol": self.adapter_protocol,
            "authorityMode": self.authority_mode,
            "authoritySetHash": self.authority_set_hash,
            "baselineArtifactHash": self.baseline_artifact_hash,
            "baselineContentHash": self.baseline_content_hash,
            "candidateArtifactHash": self.candidate_artifact_hash,
            "candidateCommitmentHash": self.candidate_commitment_hash,
            "candidateContentHash": self.candidate_content_hash,
            "candidateId": self.candidate_id,
            "challengeEpoch": self.challenge_epoch,
            "challengeSeed": self.challenge_seed,
            "committedHeight": self.committed_height,
            "decisionHeight": self.decision_height,
            "environmentCommitment": self.environment_commitment,
            "evaluators": evaluator_values,
            "expiresAtHeight": self.expires_at_height,
            "format": ASSIGNMENT_V2_FORMAT,
            "genesisHash": self.genesis_hash,
            "networkId": self.network_id,
            "parents": list(self.parents),
            "recipient": self.recipient,
            "safetyPolicyHash": self.safety_policy_hash,
            "sourceFinalityHeight": self.source_finality_height,
            "sourceFinalityStateRoot": self.source_finality_state_root,
            "suiteCommitment": self.suite_commitment,
        }

    @property
    def assignment_hash(self) -> str:
        return consensus_hash(ASSIGNMENT_V2_DOMAIN, self.payload())

    def as_dict(self) -> dict[str, object]:
        return self.payload()


def _validate_signature(signature: str) -> None:
    if not isinstance(signature, str) or not signature or len(signature) > MAX_SIGNATURE_CHARS:
        raise ProtocolError("ML-DSA signature is invalid")
    try:
        decoded = base64.b64decode(signature, validate=True)
    except (ValueError, TypeError) as error:
        raise ProtocolError("ML-DSA signature is not canonical base64") from error
    if not 2_000 <= len(decoded) <= 5_000:
        raise ProtocolError("ML-DSA signature size is outside protocol limits")


def verify_pq_signature(payload: object, signature: str, public_key: str, domain: str) -> bool:
    _validate_signature(signature)
    _public_key(public_key)
    helper = Path(__file__).parents[1] / "blockchain" / "pq-verify-cli.mjs"
    node = shutil.which("node")
    if node is None or not helper.is_file():
        raise ProtocolError("ML-DSA verification runtime is unavailable")
    request = json.dumps(
        {"domain": domain, "payload": payload, "publicKey": public_key, "signature": signature},
        ensure_ascii=False, separators=(",", ":"), sort_keys=True,
    ).encode("utf-8")
    if len(request) > MAX_BRIDGE_BYTES:
        raise ProtocolError("ML-DSA verification request is too large")
    try:
        result = subprocess.run(
            [node, str(helper)], input=request, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=5, check=False,
            env={"PATH": os.defpath, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
        )
        response = json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
        raise ProtocolError("ML-DSA verification runtime failed closed") from error
    return result.returncode == 0 and response == {"valid": True}


def verify_finalized_assignment(
    assignment: FinalizedEvaluationAssignment | FinalizedEvaluationAssignmentV2,
    *,
    trusted_authorities: Mapping[str, str] | None,
    expected_network_id: str,
    expected_genesis_hash: str,
    observed_height: int,
    exact_chain_anchor: object | None = None,
) -> None:
    payload = assignment.payload()
    if assignment.network_id != expected_network_id or assignment.genesis_hash != expected_genesis_hash:
        raise ProtocolError("assignment belongs to another network or genesis")
    if isinstance(assignment, FinalizedEvaluationAssignmentV2):
        if trusted_authorities not in (None, {}) or (
            not isinstance(observed_height, int) or isinstance(observed_height, bool) or
            observed_height < assignment.decision_height or
            observed_height > assignment.expires_at_height
        ):
            raise ProtocolError("assignment v2 is not finalized or has expired")
        if (
            exact_chain_anchor is None
            or getattr(exact_chain_anchor, "exact_assignment_included", None) is not True
            or getattr(exact_chain_anchor, "chain_assignment_included", None) is not True
            or getattr(exact_chain_anchor, "candidate_commitment_included", None) is not True
            or getattr(exact_chain_anchor, "assignment_hash", None) != assignment.assignment_hash
            or getattr(exact_chain_anchor, "finalized_height", None) !=
                assignment.source_finality_height
            or getattr(exact_chain_anchor, "finalized_state_root", None) !=
                assignment.source_finality_state_root
        ):
            raise ProtocolError("assignment v2 lacks a matching exact chain anchor")
        return
    if not isinstance(assignment, FinalizedEvaluationAssignment) or trusted_authorities is None:
        raise ProtocolError("legacy assignment trust inputs are invalid")
    if not isinstance(observed_height, int) or isinstance(observed_height, bool) or (
        observed_height < assignment.finalized_height or observed_height > assignment.expires_at_height
    ):
        raise ProtocolError("assignment is not finalized or has expired")
    if assignment.authority_set_hash != authority_set_hash(trusted_authorities):
        raise ProtocolError("assignment authority set does not match the trusted checkpoint")
    if len(assignment.attestations) > len(trusted_authorities):
        raise ProtocolError("assignment contains too many authority attestations")
    authority_quorum = (2 * len(trusted_authorities)) // 3 + 1
    seen: set[str] = set()
    for attestation in assignment.attestations:
        attestation.as_dict()
        public_key = trusted_authorities.get(attestation.authority_id)
        if (
            public_key is None
            or evaluator_id_for_public_key(public_key) != attestation.authority_id
            or attestation.authority_id in seen
            or not verify_pq_signature(
            payload, attestation.signature, public_key, ASSIGNMENT_DOMAIN,
            )
        ):
            raise ProtocolError("assignment authority signature is invalid or duplicated")
        seen.add(attestation.authority_id)
    if len(seen) < authority_quorum:
        raise ProtocolError("assignment finality authority quorum was not reached")


@dataclass(frozen=True, slots=True)
class SignedExecutionTranscript:
    assignment_hash: str
    candidate_id: str
    execution_bundle_hash: str
    transcript_hash: str
    role: str
    challenge_seed: str
    challenge_epoch: int
    environment_commitment: str
    suite_commitment: str
    adapter_protocol: str
    safety_policy_hash: str
    evaluator_id: str
    signature: str

    @classmethod
    def from_dict(cls, value: object) -> "SignedExecutionTranscript":
        expected = {
            "assignmentHash", "candidateId", "challengeEpoch", "challengeSeed",
            "environmentCommitment", "evaluatorId", "executionBundleHash", "format", "role",
            "signature", "suiteCommitment", "transcriptHash",
            "adapterProtocol", "safetyPolicyHash",
        }
        if not isinstance(value, dict) or set(value) != expected or value.get("format") != RECEIPT_FORMAT:
            raise ProtocolError("signed execution transcript schema or format is invalid")
        string_fields = expected - {"challengeEpoch"}
        if any(not isinstance(value[field], str) for field in string_fields) or (
            not isinstance(value["challengeEpoch"], int) or isinstance(value["challengeEpoch"], bool)
        ):
            raise ProtocolError("signed execution transcript field types are invalid")
        result = cls(
            assignment_hash=value["assignmentHash"], candidate_id=value["candidateId"],
            execution_bundle_hash=value["executionBundleHash"], transcript_hash=value["transcriptHash"],
            role=value["role"], challenge_seed=value["challengeSeed"],
            challenge_epoch=value["challengeEpoch"], environment_commitment=value["environmentCommitment"],
            suite_commitment=value["suiteCommitment"], evaluator_id=value["evaluatorId"],
            adapter_protocol=value["adapterProtocol"], safety_policy_hash=value["safetyPolicyHash"],
            signature=value["signature"],
        )
        result.payload()
        _validate_signature(result.signature)
        return result

    def payload(self) -> dict[str, object]:
        for value, field in (
            (self.assignment_hash, "assignment hash"), (self.candidate_id, "candidate id"),
            (self.execution_bundle_hash, "execution bundle hash"),
            (self.transcript_hash, "transcript hash"), (self.challenge_seed, "challenge seed"),
            (self.environment_commitment, "environment commitment"),
            (self.suite_commitment, "suite commitment"),
            (self.safety_policy_hash, "safety policy hash"),
        ):
            _hash(value, field)
        if not isinstance(self.adapter_protocol, str) or not _PROTOCOL.fullmatch(self.adapter_protocol):
            raise ProtocolError("signed transcript adapter protocol is invalid")
        if self.role not in {"baseline", "candidate"} or not _ADDRESS.fullmatch(self.evaluator_id):
            raise ProtocolError("signed transcript role or evaluator is invalid")
        if not isinstance(self.challenge_epoch, int) or isinstance(self.challenge_epoch, bool) or self.challenge_epoch < 1:
            raise ProtocolError("signed transcript challenge epoch is invalid")
        return {
            "assignmentHash": self.assignment_hash, "candidateId": self.candidate_id,
            "challengeEpoch": self.challenge_epoch, "challengeSeed": self.challenge_seed,
            "environmentCommitment": self.environment_commitment,
            "evaluatorId": self.evaluator_id, "executionBundleHash": self.execution_bundle_hash,
            "format": RECEIPT_FORMAT, "role": self.role,
            "suiteCommitment": self.suite_commitment, "transcriptHash": self.transcript_hash,
            "adapterProtocol": self.adapter_protocol, "safetyPolicyHash": self.safety_policy_hash,
        }

    def as_dict(self) -> dict[str, object]:
        return {**self.payload(), "signature": self.signature}


def create_signed_execution_transcript(
    *, assignment: FinalizedEvaluationAssignment | FinalizedEvaluationAssignmentV2,
    bundle: EvaluationBundle, transcript: ExecutionTranscript, evaluator_id: str,
    signer: Callable[[str, dict[str, object]], str],
) -> SignedExecutionTranscript:
    verify_bundle(bundle, expected_hash=bundle.bundle_hash)
    assigned = {item.evaluator_id for item in assignment.evaluators}
    bundle_transcripts = bundle.baseline + bundle.candidate
    if (
        assignment.candidate_commitment_hash != bundle.commitment.commitment_hash
        or assignment.candidate_id != bundle.commitment.candidate_id
        or assignment.challenge_seed != bundle.challenge_seed
        or assignment.challenge_epoch != bundle.challenge_epoch
        or assignment.environment_commitment != bundle.environment.commitment
        or assignment.suite_commitment != bundle.commitment.suite_commitment
        or assignment.baseline_artifact_hash != bundle.commitment.baseline_hash
        or assignment.baseline_content_hash != bundle.commitment.baseline_content_hash
        or assignment.candidate_artifact_hash != bundle.commitment.artifact_hash
        or assignment.candidate_content_hash != bundle.commitment.content_hash
        or assignment.adapter_protocol != bundle.environment.adapter_protocol
        or
        evaluator_id not in assigned
        or transcript.run.verifier_id != evaluator_id
        or not any(item.transcript_hash == transcript.transcript_hash for item in bundle_transcripts)
    ):
        raise ProtocolError("cannot sign a transcript outside the assigned evaluator bundle")
    receipt = SignedExecutionTranscript(
        assignment_hash=assignment.assignment_hash,
        candidate_id=bundle.commitment.candidate_id,
        execution_bundle_hash=bundle.bundle_hash,
        transcript_hash=transcript.transcript_hash,
        role=transcript.role,
        challenge_seed=transcript.challenge_seed,
        challenge_epoch=transcript.challenge_epoch,
        environment_commitment=transcript.environment_hash,
        suite_commitment=bundle.commitment.suite_commitment,
        adapter_protocol=bundle.environment.adapter_protocol,
        safety_policy_hash=assignment.safety_policy_hash,
        evaluator_id=evaluator_id,
        signature="",
    )
    signature = signer(TRANSCRIPT_DOMAIN, receipt.payload())
    _validate_signature(signature)
    return SignedExecutionTranscript(**{
        name: getattr(receipt, name) for name in receipt.__dataclass_fields__ if name != "signature"
    }, signature=signature)


def verify_execution_receipts(
    *, assignment: FinalizedEvaluationAssignment | FinalizedEvaluationAssignmentV2,
    bundle: EvaluationBundle, receipts: tuple[SignedExecutionTranscript, ...], observed_height: int,
    trusted_authorities: Mapping[str, str] | None, expected_network_id: str,
    expected_genesis_hash: str, expected_adapter_protocol: str,
    expected_safety_policy_hash: str, exact_chain_anchor: object | None = None,
) -> None:
    verify_finalized_assignment(
        assignment, trusted_authorities=trusted_authorities,
        expected_network_id=expected_network_id, expected_genesis_hash=expected_genesis_hash,
        observed_height=observed_height,
        exact_chain_anchor=exact_chain_anchor,
    )
    verify_bundle(bundle, expected_hash=bundle.bundle_hash)
    if (
        assignment.adapter_protocol != expected_adapter_protocol
        or assignment.safety_policy_hash != expected_safety_policy_hash
    ):
        raise ProtocolError("assignment adapter protocol or safety policy is not trusted")
    if (
        not isinstance(observed_height, int)
        or isinstance(observed_height, bool)
        or observed_height < (assignment.decision_height if isinstance(
            assignment, FinalizedEvaluationAssignmentV2) else assignment.finalized_height)
        or observed_height > assignment.expires_at_height
    ):
        raise ProtocolError("execution receipts use an expired assignment")
    if (
        assignment.candidate_commitment_hash != bundle.commitment.commitment_hash
        or assignment.candidate_id != bundle.commitment.candidate_id
        or assignment.challenge_seed != bundle.challenge_seed
        or assignment.challenge_epoch != bundle.challenge_epoch
        or assignment.environment_commitment != bundle.environment.commitment
        or assignment.suite_commitment != bundle.commitment.suite_commitment
        or assignment.baseline_artifact_hash != bundle.commitment.baseline_hash
        or assignment.baseline_content_hash != bundle.commitment.baseline_content_hash
        or assignment.candidate_artifact_hash != bundle.commitment.artifact_hash
        or assignment.candidate_content_hash != bundle.commitment.content_hash
        or assignment.adapter_protocol != bundle.environment.adapter_protocol
    ):
        raise ProtocolError("execution bundle does not match its finalized assignment")
    evaluators = {item.evaluator_id: item.public_key for item in assignment.evaluators}
    transcripts = {
        (item.role, item.run.verifier_id): item
        for item in bundle.baseline + bundle.candidate
    }
    expected = {(role, evaluator) for evaluator in evaluators for role in ("baseline", "candidate")}
    if set(transcripts) != expected or len(receipts) != len(expected):
        raise ProtocolError("execution bundle or receipts do not cover the exact assigned committee")
    seen: set[tuple[str, str]] = set()
    for receipt in receipts:
        payload = receipt.payload()
        key = (receipt.role, receipt.evaluator_id)
        transcript = transcripts.get(key)
        public_key = evaluators.get(receipt.evaluator_id)
        if key in seen or transcript is None or public_key is None:
            raise ProtocolError("execution receipt signer is unassigned or duplicated")
        if (
            receipt.assignment_hash != assignment.assignment_hash
            or receipt.candidate_id != assignment.candidate_id
            or receipt.execution_bundle_hash != bundle.bundle_hash
            or receipt.transcript_hash != transcript.transcript_hash
            or receipt.challenge_seed != assignment.challenge_seed
            or receipt.challenge_epoch != assignment.challenge_epoch
            or receipt.environment_commitment != assignment.environment_commitment
            or receipt.suite_commitment != assignment.suite_commitment
            or receipt.adapter_protocol != assignment.adapter_protocol
            or receipt.safety_policy_hash != assignment.safety_policy_hash
            or not verify_pq_signature(payload, receipt.signature, public_key, TRANSCRIPT_DOMAIN)
        ):
            raise ProtocolError("execution receipt signature or binding is invalid")
        seen.add(key)
    if seen != expected:
        raise ProtocolError("execution receipt committee is incomplete")

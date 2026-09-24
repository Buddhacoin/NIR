"""Honest light-client anchor for an experimental evaluation assignment.

Current consensus commits the progress admission transaction and a monolithic
state root, but exposes no Merkle proof for the derived challenge/evaluator
assignment.  Consequently this verifier proves the former and anchors the
claimed finalized state root; it deliberately returns ``exact_assignment_included=False``.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import shutil
import subprocess
from typing import Any, Sequence

from .execution_receipt import FinalizedEvaluationAssignment
from .model import ProtocolError
from .runner import CandidateCommitment


MAX_PROOF_BYTES = 32 * 1024 * 1024
PROOF_FORMAT = "nir-assignment-chain-anchor-v1-experimental"


@dataclass(frozen=True, slots=True)
class AssignmentChainProof:
    finality_proofs: tuple[dict[str, Any], ...]
    commitment_transaction: dict[str, Any]
    transaction_proof: dict[str, Any]
    transaction_block_height: int

    @classmethod
    def from_dict(cls, value: object) -> "AssignmentChainProof":
        expected = {
            "commitmentTransaction", "finalityProofs", "format",
            "transactionBlockHeight", "transactionProof",
        }
        if (
            not isinstance(value, dict)
            or set(value) != expected
            or value.get("format") != PROOF_FORMAT
            or not isinstance(value.get("finalityProofs"), list)
            or not isinstance(value.get("commitmentTransaction"), dict)
            or not isinstance(value.get("transactionProof"), dict)
            or not isinstance(value.get("transactionBlockHeight"), int)
            or isinstance(value.get("transactionBlockHeight"), bool)
        ):
            raise ProtocolError("assignment chain proof schema is invalid")
        result = cls(
            finality_proofs=tuple(value["finalityProofs"]),
            commitment_transaction=value["commitmentTransaction"],
            transaction_proof=value["transactionProof"],
            transaction_block_height=value["transactionBlockHeight"],
        )
        result.as_dict()
        return result

    def as_dict(self) -> dict[str, object]:
        if (
            not isinstance(self.finality_proofs, tuple)
            or not self.finality_proofs
            or any(not isinstance(item, dict) for item in self.finality_proofs)
            or not isinstance(self.commitment_transaction, dict)
            or not isinstance(self.transaction_proof, dict)
            or not isinstance(self.transaction_block_height, int)
            or isinstance(self.transaction_block_height, bool)
            or self.transaction_block_height < 1
        ):
            raise ProtocolError("assignment chain proof fields are invalid")
        value = {
            "commitmentTransaction": self.commitment_transaction,
            "finalityProofs": list(self.finality_proofs),
            "format": PROOF_FORMAT,
            "transactionBlockHeight": self.transaction_block_height,
            "transactionProof": self.transaction_proof,
        }
        try:
            encoded = json.dumps(
                value, ensure_ascii=False, separators=(",", ":"), sort_keys=True,
            ).encode("utf-8")
        except (TypeError, ValueError, RecursionError) as error:
            raise ProtocolError("assignment chain proof is not bounded JSON") from error
        if len(encoded) > MAX_PROOF_BYTES:
            raise ProtocolError("assignment chain proof exceeds the size limit")
        return value


@dataclass(frozen=True, slots=True)
class AssignmentChainAnchorResult:
    candidate_commitment_included: bool
    exact_assignment_included: bool
    finalized_height: int
    finalized_state_root: str
    transaction_block_height: int
    consensus_gap: str


def verify_assignment_chain_anchor(
    *,
    assignment: FinalizedEvaluationAssignment,
    proof: AssignmentChainProof,
    checkpoint: dict[str, Any],
    trusted_validators: Sequence[dict[str, Any]],
    handoffs: Sequence[dict[str, Any]] = (),
    expected_network_id: str,
    expected_genesis_hash: str,
) -> AssignmentChainAnchorResult:
    """Verify existing finality and transaction proofs without inventing a root."""
    if (
        not isinstance(assignment, FinalizedEvaluationAssignment)
        or not isinstance(proof, AssignmentChainProof)
        or not isinstance(checkpoint, dict)
        or not isinstance(trusted_validators, (list, tuple))
        or not isinstance(handoffs, (list, tuple))
        or assignment.network_id != expected_network_id
        or assignment.genesis_hash != expected_genesis_hash
    ):
        raise ProtocolError("assignment chain proof trust inputs are invalid")
    assignment.payload()
    proof.as_dict()
    request = {
        "assignment": assignment.as_dict(),
        "checkpoint": checkpoint,
        "commitmentTransaction": proof.commitment_transaction,
        "expectedGenesisHash": expected_genesis_hash,
        "expectedNetworkId": expected_network_id,
        "finalityProofs": list(proof.finality_proofs),
        "handoffs": list(handoffs),
        "transactionBlockHeight": proof.transaction_block_height,
        "transactionProof": proof.transaction_proof,
        "trustedValidators": list(trusted_validators),
    }
    try:
        encoded = json.dumps(
            request, ensure_ascii=False, separators=(",", ":"), sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError, RecursionError) as error:
        raise ProtocolError("assignment chain proof is not bounded JSON") from error
    if not encoded or len(encoded) > MAX_PROOF_BYTES:
        raise ProtocolError("assignment chain proof exceeds the size limit")
    node = shutil.which("node")
    helper = Path(__file__).parents[1] / "blockchain" / "assignment-chain-anchor-cli.mjs"
    if node is None or not helper.is_file():
        raise ProtocolError("assignment light-client verifier is unavailable")
    try:
        completed = subprocess.run(
            [node, str(helper)], input=encoded, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=15, check=False,
            env={"PATH": os.defpath, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
        )
        response = json.loads(completed.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
        raise ProtocolError("assignment light-client verifier failed closed") from error
    if completed.returncode != 0 or not isinstance(response, dict) or response.get("ok") is not True:
        raise ProtocolError("assignment light-client inclusion proof is invalid")
    result = response.get("result")
    if (
        not isinstance(result, dict)
        or set(result) != {
            "candidateCommitmentIncluded", "exactAssignmentIncluded", "finalizedHeight",
            "finalizedStateRoot", "transactionBlockHeight",
        }
        or result.get("candidateCommitmentIncluded") is not True
        or result.get("exactAssignmentIncluded") is not False
        or not isinstance(result.get("finalizedHeight"), int)
        or isinstance(result.get("finalizedHeight"), bool)
        or not isinstance(result.get("finalizedStateRoot"), str)
        or not isinstance(result.get("transactionBlockHeight"), int)
        or isinstance(result.get("transactionBlockHeight"), bool)
    ):
        raise ProtocolError("assignment light-client verifier returned an invalid result")

    transaction = proof.commitment_transaction
    try:
        commitment = CandidateCommitment.from_dict({
            "artifact_hash": transaction["artifactHash"],
            "baseline_hash": transaction["baselineHash"],
            "baseline_content_hash": transaction["baselineContentHash"],
            "candidate_id": transaction["candidateId"],
            "committed_epoch": proof.transaction_block_height,
            "content_hash": transaction["contentHash"],
            "network_id": transaction["networkId"],
            "parents": transaction["parents"],
            "recipient": transaction["recipient"],
            "suite_commitment": transaction["suiteCommitment"],
        })
    except (KeyError, TypeError) as error:
        raise ProtocolError("finalized progress commitment schema is invalid") from error
    if commitment.commitment_hash != assignment.candidate_commitment_hash:
        raise ProtocolError("finalized transaction does not match the assignment commitment hash")
    return AssignmentChainAnchorResult(
        candidate_commitment_included=True,
        exact_assignment_included=False,
        finalized_height=result["finalizedHeight"],
        finalized_state_root=result["finalizedStateRoot"],
        transaction_block_height=result["transactionBlockHeight"],
        consensus_gap=(
            "current stateRoot has no membership proof for progressCommitments/challenge committee; "
            "exact assignment inclusion is not proven"
        ),
    )

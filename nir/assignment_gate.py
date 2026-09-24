"""Operator preflight for an experimental signed evaluation assignment package.

This command never starts an AI adapter and never accepts private key material.
Trust anchors and the externally pinned replay checkpoint come from a separate
operator policy document, not from the untrusted assignment package.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import sys
from typing import Any, Sequence

from .execution_receipt import FinalizedEvaluationAssignment, SignedExecutionTranscript
from .model import ProtocolError
from .replay_store import (
    ConsumedEvaluationStore,
    DurableAssignmentReceiptReplayGuard,
    ReplayStoreError,
)
from .runner import EvaluationBundle


PACKAGE_FORMAT = "nir-signed-assignment-package-v1-experimental"
POLICY_FORMAT = "nir-assignment-verification-policy-v1-experimental"
RESULT_FORMAT = "nir-assignment-preflight-result-v1-experimental"
MAX_PACKAGE_BYTES = 32 * 1024 * 1024
MAX_POLICY_BYTES = 1024 * 1024
MAX_RECEIPTS = 512
WARNING = (
    "EXPERIMENTAL OPERATOR VERIFICATION: verifies a completed signed execution package and "
    "advances local replay state only. It does not authorize or start an AI adapter, prove exact "
    "assignment chain inclusion, mine NIR, or award NIR."
)


class AssignmentGateError(ProtocolError):
    """A package, policy, or CLI input is not safe to verify."""


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise AssignmentGateError("JSON contains a duplicate field")
        result[key] = value
    return result


def _reject_nonfinite(_value: str) -> None:
    raise AssignmentGateError("JSON contains a non-finite number")


def _read_bounded_json(path: str | Path, *, limit: int) -> object:
    requested = os.path.abspath(os.fspath(path))
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(requested, flags)
    except OSError as error:
        raise AssignmentGateError("input file is unavailable or unsafe") from error
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_size > limit
        ):
            raise AssignmentGateError("input file is not a bounded regular file")
        chunks = bytearray()
        while len(chunks) <= limit:
            chunk = os.read(descriptor, min(64 * 1024, limit + 1 - len(chunks)))
            if not chunk:
                break
            chunks.extend(chunk)
        if len(chunks) > limit:
            raise AssignmentGateError("input file exceeds its size limit")
        linked = os.stat(requested, follow_symlinks=False)
        if (metadata.st_dev, metadata.st_ino) != (linked.st_dev, linked.st_ino):
            raise AssignmentGateError("input file changed while it was read")
    except OSError as error:
        raise AssignmentGateError("input file could not be read safely") from error
    finally:
        os.close(descriptor)
    try:
        return json.loads(
            chunks, object_pairs_hook=_strict_object, parse_constant=_reject_nonfinite,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        if isinstance(error, AssignmentGateError):
            raise
        raise AssignmentGateError("input is not strict UTF-8 JSON") from error


def _parse_package(value: object) -> tuple[FinalizedEvaluationAssignment, EvaluationBundle, tuple[SignedExecutionTranscript, ...]]:
    if (
        not isinstance(value, dict)
        or set(value) != {"assignment", "bundle", "format", "receipts"}
        or value.get("format") != PACKAGE_FORMAT
        or not isinstance(value.get("assignment"), dict)
        or not isinstance(value.get("bundle"), dict)
        or not isinstance(value.get("receipts"), list)
        or not 1 <= len(value["receipts"]) <= MAX_RECEIPTS
        or any(not isinstance(item, dict) for item in value["receipts"])
    ):
        raise AssignmentGateError("signed assignment package schema is invalid")
    return (
        FinalizedEvaluationAssignment.from_dict(value["assignment"]),
        EvaluationBundle.from_dict(value["bundle"]),
        tuple(SignedExecutionTranscript.from_dict(item) for item in value["receipts"]),
    )


def _parse_policy(value: object) -> dict[str, object]:
    expected = {
        "expectedAdapterProtocol", "expectedGenesisHash", "expectedNetworkId",
        "expectedSafetyPolicyHash", "format", "observedHeight", "replayCheckpoint",
        "trustedAuthorities",
    }
    if not isinstance(value, dict) or set(value) != expected or value.get("format") != POLICY_FORMAT:
        raise AssignmentGateError("operator verification policy schema is invalid")
    strings = (
        "expectedAdapterProtocol", "expectedGenesisHash", "expectedNetworkId",
        "expectedSafetyPolicyHash",
    )
    checkpoint = value["replayCheckpoint"]
    authorities = value["trustedAuthorities"]
    if (
        any(not isinstance(value[field], str) or not value[field] for field in strings)
        or not isinstance(value["observedHeight"], int)
        or isinstance(value["observedHeight"], bool)
        or value["observedHeight"] < 0
        or not isinstance(authorities, dict)
        or not 1 <= len(authorities) <= 128
        or any(not isinstance(key, str) or not isinstance(item, str) for key, item in authorities.items())
        or not isinstance(checkpoint, dict)
        or set(checkpoint) != {"generation", "stateHash"}
        or not isinstance(checkpoint["generation"], int)
        or isinstance(checkpoint["generation"], bool)
        or checkpoint["generation"] < 0
        or not isinstance(checkpoint["stateHash"], str)
        or len(checkpoint["stateHash"]) != 64
        or any(character not in "0123456789abcdef" for character in checkpoint["stateHash"])
    ):
        raise AssignmentGateError("operator verification policy values are invalid")
    return value


def current_replay_checkpoint(replay_store: str | Path) -> dict[str, object]:
    """Initialize/inspect local state; this is not proof against prior rollback."""
    with ConsumedEvaluationStore(replay_store) as store:
        generation, state_hash = store.checkpoint
    return {"generation": generation, "stateHash": state_hash}


def verify_assignment_package(
    *, package_path: str | Path, policy_path: str | Path, replay_store: str | Path,
) -> dict[str, object]:
    package = _read_bounded_json(package_path, limit=MAX_PACKAGE_BYTES)
    policy = _parse_policy(_read_bounded_json(policy_path, limit=MAX_POLICY_BYTES))
    assignment, bundle, receipts = _parse_package(package)
    checkpoint = policy["replayCheckpoint"]
    assert isinstance(checkpoint, dict)
    expected_checkpoint = (checkpoint["generation"], checkpoint["stateHash"])
    assert isinstance(expected_checkpoint[0], int) and isinstance(expected_checkpoint[1], str)

    with ConsumedEvaluationStore(replay_store, expected_checkpoint=expected_checkpoint) as store:
        previous = store.checkpoint
        guard = DurableAssignmentReceiptReplayGuard(store)
        replay_keys = guard.consume(
            assignment=assignment,
            bundle=bundle,
            receipts=receipts,
            trusted_authorities=policy["trustedAuthorities"],
            expected_network_id=policy["expectedNetworkId"],
            expected_genesis_hash=policy["expectedGenesisHash"],
            expected_adapter_protocol=policy["expectedAdapterProtocol"],
            expected_safety_policy_hash=policy["expectedSafetyPolicyHash"],
            observed_height=policy["observedHeight"],
        )
        current = store.checkpoint

    return {
        "adapterLaunchAuthorized": False,
        "assignmentHash": assignment.assignment_hash,
        "bundleHash": bundle.bundle_hash,
        "candidateId": assignment.candidate_id,
        "chainInclusionVerified": False,
        "chainMutation": False,
        "experimental": True,
        "format": RESULT_FORMAT,
        "localReplayStateAdvanced": True,
        "ok": True,
        "packageVerified": True,
        "previousReplayCheckpoint": {"generation": previous[0], "stateHash": previous[1]},
        "receiptCount": len(receipts),
        "replayCheckpoint": {"generation": current[0], "stateHash": current[1]},
        "replayKeyCount": len(replay_keys),
        "scope": "signed-execution-package-local-verification",
        "warning": WARNING,
    }


def _options(arguments: Sequence[str]) -> tuple[str, dict[str, str], bool]:
    values = list(arguments)
    json_mode = False
    if "--json" in values:
        if values.count("--json") != 1:
            raise AssignmentGateError("--json may be specified only once")
        values.remove("--json")
        json_mode = True
    if not values or values[0] not in {"checkpoint", "verify"}:
        raise AssignmentGateError("command must be checkpoint or verify")
    command = values.pop(0)
    options: dict[str, str] = {}
    index = 0
    while index < len(values):
        name = values[index]
        if name not in {"--package", "--policy", "--replay-store"} or name in options:
            raise AssignmentGateError("CLI options are invalid or duplicated")
        index += 1
        if index >= len(values) or values[index].startswith("--"):
            raise AssignmentGateError("CLI option value is missing")
        options[name] = values[index]
        index += 1
    required = {"--replay-store"} if command == "checkpoint" else {
        "--package", "--policy", "--replay-store",
    }
    if set(options) != required:
        raise AssignmentGateError("required CLI options are missing or unexpected")
    return command, options, json_mode


def _failure(code: str) -> dict[str, object]:
    return {
        "adapterLaunchAuthorized": False,
        "chainInclusionVerified": False,
        "chainMutation": False,
        "error": code,
        "experimental": True,
        "format": RESULT_FORMAT,
        "localReplayStateAdvanced": False,
        "ok": False,
        "packageVerified": False,
        "warning": WARNING,
    }


def main(arguments: Sequence[str] | None = None) -> int:
    values = list(sys.argv[1:] if arguments is None else arguments)
    json_requested = "--json" in values
    try:
        command, options, json_mode = _options(values)
        if command == "checkpoint":
            result = {
                "adapterLaunchAuthorized": False,
                "chainInclusionVerified": False,
                "chainMutation": False,
                "experimental": True,
                "format": RESULT_FORMAT,
                "localReplayStateAdvanced": False,
                "ok": True,
                "packageVerified": False,
                "replayCheckpoint": current_replay_checkpoint(options["--replay-store"]),
                "scope": "local-replay-checkpoint-inspection",
                "warning": WARNING,
            }
        else:
            result = verify_assignment_package(
                package_path=options["--package"], policy_path=options["--policy"],
                replay_store=options["--replay-store"],
            )
    except ReplayStoreError:
        result = _failure("REPLAY_STATE_REJECTED")
        json_mode = json_requested
    except (AssignmentGateError, ProtocolError):
        result = _failure("PACKAGE_VERIFICATION_FAILED")
        json_mode = json_requested
    except Exception:
        # Operator mode must fail closed without leaking paths, subprocess
        # diagnostics, or untrusted package contents through a traceback.
        result = _failure("INTERNAL_VERIFICATION_ERROR")
        json_mode = json_requested
    output = json.dumps(result, separators=(",", ":"), sort_keys=True)
    if json_mode:
        print(output)
    else:
        status = "PASS" if result["ok"] else "FAIL"
        print(f"NIR signed assignment preflight: {status}")
        print(WARNING)
        if result["ok"]:
            print("Machine result: " + output)
        else:
            print(f"Reason: {result['error']}")
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())

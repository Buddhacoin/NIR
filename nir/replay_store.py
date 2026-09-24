"""Crash-safe local replay prevention for consumed NIR evaluation work.

This store provides one durable winner among processes that share one locked
directory.  It is not a distributed exactly-once service.  Coordinated rollback
of every local copy is detectable only when the caller pins the exported
checkpoint outside this directory.
"""

from __future__ import annotations

from contextlib import contextmanager
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
from typing import Any, Iterator, Mapping

from .consensus_codec import consensus_hash
from .model import ProtocolError


FORMAT = "nir-consumed-evaluation-store-v1"
MAX_RECORDS = 100_000
MAX_STORE_BYTES = 16 * 1024 * 1024
_COPIES = ("consumed-a.json", "consumed-b.json")
_LOCK = ".writer.lock"
_ZERO_HASH = "0" * 64
_DIGEST = re.compile(r"^[0-9a-f]{64}$")


class ReplayStoreError(ProtocolError):
    """The durable replay state is unsafe, corrupt, or divergent."""


class ChallengeAlreadyConsumed(ReplayStoreError):
    """The exact evaluation assignment/challenge was already used."""


def _canonical(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True,
    ).encode("utf-8")


def _state_hash(payload: dict[str, Any]) -> str:
    return hashlib.sha256(b"NIR_CONSUMED_EVALUATION_STORE_V1\0" + _canonical(payload)).hexdigest()


def _new_state(consumed: list[str], generation: int, previous_hash: str) -> dict[str, Any]:
    payload = {
        "consumed": consumed,
        "format": FORMAT,
        "generation": generation,
        "previousHash": previous_hash,
    }
    return {**payload, "stateHash": _state_hash(payload)}


def _empty_state() -> dict[str, Any]:
    return _new_state([], 0, _ZERO_HASH)


def _validate_state(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "consumed", "format", "generation", "previousHash", "stateHash",
    }:
        raise ReplayStoreError("consumed evaluation state schema is invalid")
    consumed = value["consumed"]
    generation = value["generation"]
    if (
        value["format"] != FORMAT
        or not isinstance(generation, int)
        or isinstance(generation, bool)
        or generation < 0
        or not isinstance(consumed, list)
        or len(consumed) > MAX_RECORDS
        or consumed != sorted(set(consumed))
        or any(not isinstance(item, str) or not _DIGEST.fullmatch(item) for item in consumed)
        or not isinstance(value["previousHash"], str)
        or not _DIGEST.fullmatch(value["previousHash"])
        or not isinstance(value["stateHash"], str)
        or not _DIGEST.fullmatch(value["stateHash"])
    ):
        raise ReplayStoreError("consumed evaluation state is invalid")
    if generation == 0 and (consumed or value["previousHash"] != _ZERO_HASH):
        raise ReplayStoreError("empty consumed evaluation state is invalid")
    payload = {key: value[key] for key in ("consumed", "format", "generation", "previousHash")}
    if value["stateHash"] != _state_hash(payload):
        raise ReplayStoreError("consumed evaluation state hash is invalid")
    return value


class ConsumedEvaluationStore:
    """Two-copy atomic replay state guarded by an exclusive interprocess lock.

    A caller that publishes ``checkpoint`` outside this directory can pass it as
    ``expected_checkpoint`` on restart to detect a coordinated rollback of both
    local copies. Without such an external anchor no local filesystem format can
    distinguish a byte-for-byte rollback of every local file.
    """

    def __init__(
        self, root: str | Path, *, expected_checkpoint: tuple[int, str] | None = None,
    ) -> None:
        requested = os.path.abspath(os.fspath(root))
        if not all(hasattr(os, name) for name in ("O_DIRECTORY", "O_NOFOLLOW")):
            raise ReplayStoreError("consumed evaluation store requires secure POSIX file opens")
        os.makedirs(requested, mode=0o700, exist_ok=True)
        linked = os.lstat(requested)
        if (
            not stat.S_ISDIR(linked.st_mode)
            or stat.S_ISLNK(linked.st_mode)
            or linked.st_mode & 0o077
        ):
            raise ReplayStoreError("consumed evaluation store root is unsafe")
        resolved = os.path.realpath(requested)
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        self._root_path = resolved
        self._root_fd = os.open(resolved, flags)
        self._root_identity = os.fstat(self._root_fd)
        self._closed = False
        self._poisoned = False
        try:
            self._assert_root()
            with self._locked():
                state = self._load_and_repair()
                if expected_checkpoint is not None:
                    generation, state_hash = expected_checkpoint
                    if generation != state["generation"] or state_hash != state["stateHash"]:
                        raise ReplayStoreError("consumed evaluation store rollback detected")
                self._checkpoint = (state["generation"], state["stateHash"])
        except Exception:
            os.close(self._root_fd)
            self._closed = True
            raise

    def __enter__(self) -> "ConsumedEvaluationStore":
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()

    @property
    def checkpoint(self) -> tuple[int, str]:
        return self._checkpoint

    def close(self) -> None:
        if not self._closed:
            os.close(self._root_fd)
            self._closed = True

    def _assert_root(self) -> None:
        if self._closed or self._poisoned:
            raise ReplayStoreError("consumed evaluation store is closed or poisoned")
        try:
            descriptor = os.fstat(self._root_fd)
            linked = os.lstat(self._root_path)
            if (
                not stat.S_ISDIR(descriptor.st_mode)
                or not stat.S_ISDIR(linked.st_mode)
                or stat.S_ISLNK(linked.st_mode)
                or descriptor.st_mode & 0o077
                or linked.st_mode & 0o077
                or (descriptor.st_dev, descriptor.st_ino)
                != (self._root_identity.st_dev, self._root_identity.st_ino)
                or (linked.st_dev, linked.st_ino)
                != (self._root_identity.st_dev, self._root_identity.st_ino)
                or os.path.realpath(self._root_path) != self._root_path
            ):
                raise ReplayStoreError("consumed evaluation store root was replaced")
        except Exception as error:
            self._poisoned = True
            if isinstance(error, ReplayStoreError):
                raise
            raise ReplayStoreError("consumed evaluation store root was replaced") from error

    def _open_regular(self, name: str, flags: int, mode: int = 0o600) -> int:
        try:
            descriptor = os.open(
                name, flags | getattr(os, "O_NOFOLLOW", 0), mode, dir_fd=self._root_fd,
            )
        except OSError as error:
            if error.errno in {errno.ELOOP, errno.EMLINK}:
                raise ReplayStoreError("consumed evaluation store file is unsafe") from error
            raise
        try:
            metadata = os.fstat(descriptor)
            linked = os.stat(name, dir_fd=self._root_fd, follow_symlinks=False)
        except Exception:
            os.close(descriptor)
            raise
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_mode & 0o077
            or (metadata.st_dev, metadata.st_ino) != (linked.st_dev, linked.st_ino)
        ):
            os.close(descriptor)
            raise ReplayStoreError("consumed evaluation store file is unsafe")
        return descriptor

    @contextmanager
    def _locked(self) -> Iterator[None]:
        self._assert_root()
        descriptor = None
        for _attempt in range(2):
            try:
                descriptor = self._open_regular(_LOCK, os.O_RDWR | os.O_CREAT)
                break
            except FileNotFoundError:
                self._assert_root()
        if descriptor is None:
            raise ReplayStoreError("consumed evaluation writer lock could not be opened safely")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            self._assert_root()
            yield
            self._assert_root()
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def _read_copy(self, name: str) -> dict[str, Any] | None:
        self._assert_root()
        try:
            descriptor = self._open_regular(name, os.O_RDONLY)
        except FileNotFoundError:
            return None
        try:
            metadata = os.fstat(descriptor)
            if metadata.st_size > MAX_STORE_BYTES:
                raise ReplayStoreError("consumed evaluation state exceeds its size limit")
            chunks = bytearray()
            while len(chunks) <= MAX_STORE_BYTES:
                chunk = os.read(descriptor, min(64 * 1024, MAX_STORE_BYTES + 1 - len(chunks)))
                if not chunk:
                    break
                chunks.extend(chunk)
            if len(chunks) > MAX_STORE_BYTES:
                raise ReplayStoreError("consumed evaluation state exceeds its size limit")
            self._assert_root()
            linked = os.stat(name, dir_fd=self._root_fd, follow_symlinks=False)
            if (metadata.st_dev, metadata.st_ino) != (linked.st_dev, linked.st_ino):
                raise ReplayStoreError("consumed evaluation state changed during read")
            try:
                value = json.loads(chunks, object_pairs_hook=self._strict_object)
            except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
                raise ReplayStoreError("consumed evaluation state JSON is invalid") from error
            return _validate_state(value)
        finally:
            os.close(descriptor)

    @staticmethod
    def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ReplayStoreError("consumed evaluation state contains duplicate fields")
            result[key] = value
        return result

    def _write_copy(self, name: str, state: dict[str, Any]) -> None:
        self._assert_root()
        temporary = f".{name}.tmp-{os.getpid()}-{secrets.token_hex(16)}"
        descriptor = self._open_regular(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        try:
            data = _canonical(state) + b"\n"
            written = 0
            while written < len(data):
                written += os.write(descriptor, data[written:])
            os.fchmod(descriptor, 0o600)
            os.fsync(descriptor)
            created_metadata = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        self._assert_root()
        temporary_metadata = os.stat(temporary, dir_fd=self._root_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(temporary_metadata.st_mode)
            or temporary_metadata.st_nlink != 1
            or temporary_metadata.st_mode & 0o077
            or (temporary_metadata.st_dev, temporary_metadata.st_ino)
            != (created_metadata.st_dev, created_metadata.st_ino)
        ):
            raise ReplayStoreError("consumed evaluation temporary state is unsafe")
        os.replace(temporary, name, src_dir_fd=self._root_fd, dst_dir_fd=self._root_fd)
        os.fsync(self._root_fd)
        self._assert_root()

    def _load_and_repair(self) -> dict[str, Any]:
        states: list[dict[str, Any] | None] = []
        errors: list[ReplayStoreError | None] = []
        for name in _COPIES:
            try:
                states.append(self._read_copy(name))
                errors.append(None)
            except ReplayStoreError as error:
                # Unsafe link/identity failures are never repaired through.
                if "unsafe" in str(error) or "changed during read" in str(error):
                    raise
                states.append(None)
                errors.append(error)
        left, right = states
        if left is None and right is None:
            if any(errors):
                raise ReplayStoreError("both consumed evaluation state copies are invalid")
            chosen = _empty_state()
        elif left is None:
            chosen = right
        elif right is None:
            chosen = left
        elif left["stateHash"] == right["stateHash"]:
            chosen = left
        else:
            newer, older = (left, right) if left["generation"] > right["generation"] else (right, left)
            if (
                newer["generation"] != older["generation"] + 1
                or newer["previousHash"] != older["stateHash"]
            ):
                raise ReplayStoreError("consumed evaluation state copies diverged or rolled back")
            chosen = newer
        assert chosen is not None
        for name, state in zip(_COPIES, states):
            if state is None or state["stateHash"] != chosen["stateHash"]:
                self._write_copy(name, chosen)
        return chosen

    def consume_many(self, replay_keys: list[str] | tuple[str, ...]) -> tuple[int, str]:
        if (
            not isinstance(replay_keys, (list, tuple))
            or not replay_keys
            or len(replay_keys) > MAX_RECORDS
            or len(set(replay_keys)) != len(replay_keys)
            or any(not isinstance(key, str) or not _DIGEST.fullmatch(key) for key in replay_keys)
        ):
            raise ReplayStoreError("evaluation replay keys must be unique 64-character lowercase hex digests")
        with self._locked():
            current = self._load_and_repair()
            if any(key in current["consumed"] for key in replay_keys):
                raise ChallengeAlreadyConsumed("evaluation assignment or transcript was already consumed")
            if len(current["consumed"]) + len(replay_keys) > MAX_RECORDS:
                raise ReplayStoreError("consumed evaluation store is full")
            next_state = _new_state(
                sorted([*current["consumed"], *replay_keys]),
                current["generation"] + 1,
                current["stateHash"],
            )
            for name in _COPIES:
                self._write_copy(name, next_state)
            self._checkpoint = (next_state["generation"], next_state["stateHash"])
            return self._checkpoint

    def consume(self, replay_key: str) -> tuple[int, str]:
        return self.consume_many([replay_key])


def assignment_transcript_replay_key(assignment: object, receipt: object) -> str:
    """Bind one evaluator role under one finalized assignment and chain context."""
    try:
        assignment.payload()
        receipt.payload()
        evaluator_ids = {item.evaluator_id for item in assignment.evaluators}
        if (
            receipt.assignment_hash != assignment.assignment_hash
            or receipt.candidate_id != assignment.candidate_id
            or receipt.challenge_seed != assignment.challenge_seed
            or receipt.challenge_epoch != assignment.challenge_epoch
            or receipt.environment_commitment != assignment.environment_commitment
            or receipt.suite_commitment != assignment.suite_commitment
            or receipt.adapter_protocol != assignment.adapter_protocol
            or receipt.safety_policy_hash != assignment.safety_policy_hash
            or receipt.evaluator_id not in evaluator_ids
            or receipt.role not in {"baseline", "candidate"}
        ):
            raise ReplayStoreError("signed transcript does not match its finalized assignment")
        return consensus_hash(
            "NIR_EVAL_ASSIGNMENT_TRANSCRIPT_REPLAY_V1",
            {
                "assignmentHash": assignment.assignment_hash,
                "candidateId": assignment.candidate_id,
                "evaluatorId": receipt.evaluator_id,
                "genesisHash": assignment.genesis_hash,
                "networkId": assignment.network_id,
                "role": receipt.role,
            },
        )
    except ReplayStoreError:
        raise
    except (AttributeError, TypeError, ValueError, ProtocolError) as error:
        raise ReplayStoreError("assignment or signed transcript replay binding is invalid") from error


class DurableAssignmentReceiptReplayGuard:
    """Verify a complete finalized assignment result, then consume it atomically.

    The guarantee is local to processes sharing this store. It becomes rollback
    detecting across restarts only when ``store.checkpoint`` is pinned through an
    external trusted channel and supplied as ``expected_checkpoint`` on reopen.
    """

    def __init__(self, store: ConsumedEvaluationStore) -> None:
        self._store = store

    def consume(
        self,
        *,
        assignment: object,
        bundle: object,
        receipts: tuple[object, ...],
        trusted_authorities: Mapping[str, str],
        expected_network_id: str,
        expected_genesis_hash: str,
        expected_adapter_protocol: str,
        expected_safety_policy_hash: str,
        observed_height: int,
    ) -> tuple[str, ...]:
        from .execution_receipt import verify_execution_receipts

        verify_execution_receipts(
            assignment=assignment, bundle=bundle, receipts=receipts,
            observed_height=observed_height,
            trusted_authorities=trusted_authorities,
            expected_network_id=expected_network_id,
            expected_genesis_hash=expected_genesis_hash,
            expected_adapter_protocol=expected_adapter_protocol,
            expected_safety_policy_hash=expected_safety_policy_hash,
        )
        replay_keys = tuple(
            sorted(assignment_transcript_replay_key(assignment, receipt) for receipt in receipts)
        )
        if not replay_keys or len(set(replay_keys)) != len(replay_keys):
            raise ReplayStoreError("execution receipts do not produce unique replay keys")
        self._store.consume_many(replay_keys)
        return replay_keys


class DurableChallengeReplayGuard:
    """Minimal bundle-facing adapter around :class:`ConsumedEvaluationStore`."""

    def __init__(self, store: ConsumedEvaluationStore) -> None:
        self._store = store

    def consume(self, bundle: object) -> str:
        # Local import avoids making the runner depend on storage policy.
        from .runner import _hash_object, verify_bundle

        verify_bundle(bundle)  # type: ignore[arg-type]
        challenge_id = _hash_object(
            {
                "challenge_epoch": bundle.challenge_epoch,
                "challenge_seed": bundle.challenge_seed,
                "commitment_hash": bundle.commitment.commitment_hash,
                "network_id": bundle.commitment.network_id,
            },
            "NIR_EVALUATION_CHALLENGE",
        )
        self._store.consume(challenge_id)
        return challenge_id

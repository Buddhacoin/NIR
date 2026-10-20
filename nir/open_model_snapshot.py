"""Temporary byte snapshot for curated open-model packages.

The snapshot is an integrity handoff, not an OS sandbox or an immutable mount.
The same local user can still modify returned paths. Do not run untrusted model
code or treat the result as reward-eligible evidence on this basis alone.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
import os
from pathlib import Path
import stat
import tempfile
from typing import Iterator

from nir.open_model_package import (
    PackageError, _inventory, _open_root, _validated_manifest, verify_package,
)


REQUIRED_FILES = {
    "Qwen/Qwen3-0.6B": frozenset({
        "LICENSE", "config.json", "generation_config.json", "merges.txt",
        "model.safetensors", "tokenizer.json", "tokenizer_config.json",
        "vocab.json",
    }),
    "TinyLlama/TinyLlama-1.1B-Chat-v1.0": frozenset({
        "config.json", "generation_config.json", "model.safetensors",
        "special_tokens_map.json", "tokenizer.json", "tokenizer.model",
        "tokenizer_config.json",
    }),
}
MAX_SNAPSHOT_BYTES = 4 * (1 << 30)


class SnapshotError(ValueError):
    """The source cannot be copied as a verified curated package."""


@dataclass(frozen=True, slots=True)
class VerifiedSnapshot:
    path: Path
    identity: str


def _copy_file(source: int, destination: int, name: str, item: dict) -> None:
    """Copy one top-level file via pinned directory descriptors, checking both ends."""
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
    input_fd = os.open(name, flags, dir_fd=source)
    try:
        before = os.fstat(input_fd)
        expected_size = item["size"]
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                before.st_size != expected_size):
            raise SnapshotError("source file type or size changed")
        output_fd = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) |
            os.O_NOFOLLOW,
            0o400,
            dir_fd=destination,
        )
        try:
            digest = sha256()
            total = 0
            while True:
                chunk = os.read(input_fd, min(1 << 20, expected_size + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > expected_size:
                    raise SnapshotError("source file grew during copy")
                digest.update(chunk)
                remaining = memoryview(chunk)
                while remaining:
                    written = os.write(output_fd, remaining)
                    if written <= 0:
                        raise SnapshotError("snapshot write made no progress")
                    remaining = remaining[written:]
            after = os.fstat(input_fd)
            if (total != expected_size or
                    f"sha256:{digest.hexdigest()}" != item["sha256"] or
                    (before.st_dev, before.st_ino, before.st_size,
                     before.st_mtime_ns, before.st_ctime_ns) !=
                    (after.st_dev, after.st_ino, after.st_size,
                     after.st_mtime_ns, after.st_ctime_ns)):
                raise SnapshotError("source file changed during copy")
            os.fchmod(output_fd, 0o400)
            os.fsync(output_fd)
        finally:
            os.close(output_fd)
    finally:
        os.close(input_fd)


@contextmanager
def verified_snapshot(root: str | Path, manifest: object) -> Iterator[VerifiedSnapshot]:
    """Yield a private, verified local copy and delete it on context exit.

    The caller must use ``snapshot.path`` rather than the source path. This
    function does not verify Hub provenance, publisher, actual runtime, or
    isolation. Same-UID processes may still modify files in the temp tree.
    """
    try:
        checked = _validated_manifest(manifest)
        required = REQUIRED_FILES.get(checked["repository"])
        if required is None or {item["path"] for item in checked["files"]} != required:
            raise SnapshotError("curated model core files are missing or unexpected")
        if sum(item["size"] for item in checked["files"]) > MAX_SNAPSHOT_BYTES:
            raise SnapshotError("model package exceeds local snapshot size limit")
        identity = verify_package(root, checked)
        with tempfile.TemporaryDirectory(prefix="nir-model-snapshot-") as temporary:
            snapshot_root = Path(temporary).resolve() / "package"
            snapshot_root.mkdir(mode=0o700)
            source_fd = _open_root(root)
            destination_fd = _open_root(snapshot_root)
            try:
                if set(_inventory(source_fd, required, set())) != required:
                    raise SnapshotError("source inventory changed before copy")
                for item in checked["files"]:
                    _copy_file(source_fd, destination_fd, item["path"], item)
            finally:
                os.close(destination_fd)
                os.close(source_fd)
            if verify_package(snapshot_root, checked) != identity:
                raise SnapshotError("copied package identity differs from source")
            if verify_package(root, checked) != identity:
                raise SnapshotError("source changed while snapshot was created")
            yield VerifiedSnapshot(snapshot_root, identity)
    except (PackageError, OSError, TypeError, NotImplementedError) as error:
        raise SnapshotError("model package could not be snapshotted safely") from error

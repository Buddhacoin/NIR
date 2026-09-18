"""Bounded canonical commitments for the supported NIR model-content bundle."""

from __future__ import annotations

from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import tarfile
from typing import BinaryIO, Iterable

from .model import ProtocolError


FORMAT = "nir-model-content-v1"
MANIFEST_NAME = "nir-model-content.json"
MAX_FILES = 256
MAX_ENTRIES = 4096
MAX_DEPTH = 16
MAX_PATH_BYTES = 240
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 1 << 30
MAX_MANIFEST_BYTES = 64 * 1024
MAX_ARCHIVE_BYTES = MAX_TOTAL_BYTES + (2 * 1024 * 1024)
CHUNK_BYTES = 1024 * 1024
_SEGMENT = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$")


def _require_secure_open_support() -> None:
    if (
        not getattr(os, "O_NOFOLLOW", 0)
        or not getattr(os, "O_DIRECTORY", 0)
        or os.open not in os.supports_dir_fd
        or os.stat not in os.supports_dir_fd
        or os.stat not in os.supports_follow_symlinks
        or os.scandir not in os.supports_fd
    ):
        raise ProtocolError("platform lacks secure descriptor-relative model content traversal")


def _canonical_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ProtocolError("model content path is invalid")
    try:
        encoded = value.encode("ascii")
    except UnicodeEncodeError as error:
        raise ProtocolError("model content paths must be unambiguous ASCII") from error
    path = PurePosixPath(value)
    parts = path.parts
    if value.startswith("/") or not parts or len(parts) > MAX_DEPTH or len(encoded) > MAX_PATH_BYTES:
        raise ProtocolError("model content path is outside limits")
    if any(part in {"", ".", ".."} or not _SEGMENT.fullmatch(part) for part in parts):
        raise ProtocolError("model content path is not canonical")
    canonical = "/".join(parts)
    if canonical != value:
        raise ProtocolError("model content path is not canonical")
    return canonical


def _parse_manifest(content: bytes) -> tuple[tuple[str, bool], ...]:
    if not content or len(content) > MAX_MANIFEST_BYTES:
        raise ProtocolError("model content manifest size is outside limits")
    try:
        def strict_object(pairs):
            result = {}
            for key, entry in pairs:
                if key in result:
                    raise ProtocolError("model content manifest contains a duplicate field")
                result[key] = entry
            return result

        value = json.loads(content, object_pairs_hook=strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("model content manifest is not valid JSON") from error
    if not isinstance(value, dict) or set(value) != {"files", "format"} or value["format"] != FORMAT:
        raise ProtocolError("model content manifest schema is invalid")
    files = value["files"]
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise ProtocolError("model content file count is outside limits")
    normalized: list[tuple[str, bool]] = []
    folded: set[str] = set()
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"executable", "path"}:
            raise ProtocolError("model content file entry schema is invalid")
        path = _canonical_path(entry["path"])
        executable = entry["executable"]
        if not isinstance(executable, bool):
            raise ProtocolError("model content executable flag is invalid")
        collision_key = path.casefold()
        if collision_key in folded:
            raise ProtocolError("model content paths are duplicated or case-colliding")
        folded.add(collision_key)
        normalized.append((path, executable))
    return tuple(sorted(normalized))


def _metadata_tuple(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _open_regular(path: Path) -> tuple[int, os.stat_result]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ProtocolError("model content file cannot be opened safely") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ProtocolError("model content must use unique regular files")
    except Exception:
        os.close(descriptor)
        raise
    return descriptor, metadata


def _open_relative(root_descriptor: int, relative: str, *, directory: bool = False) -> int:
    parts = _canonical_path(relative).split("/")
    current = os.dup(root_descriptor)
    try:
        for index, part in enumerate(parts):
            final = index == len(parts) - 1
            flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
            if not final or directory:
                flags |= os.O_DIRECTORY
            next_descriptor = os.open(part, flags, dir_fd=current)
            os.close(current)
            current = next_descriptor
        return current
    except OSError as error:
        os.close(current)
        raise ProtocolError("model content path changed or cannot be opened safely") from error


def _hash_stream(
    digest: object, source: BinaryIO, size: int, *, before_check=None, after_check=None,
) -> None:
    if size < 1 or size > MAX_FILE_BYTES:
        raise ProtocolError("model content file size is outside limits")
    if before_check is not None:
        before_check()
    remaining = size
    while remaining:
        chunk = source.read(min(CHUNK_BYTES, remaining))
        if not chunk:
            raise ProtocolError("model content file ended before its declared size")
        digest.update(chunk)
        remaining -= len(chunk)
    if source.read(1):
        raise ProtocolError("model content file exceeds its declared size")
    if after_check is not None:
        after_check()


def _frame_file(digest: object, path: str, executable: bool, size: int) -> None:
    encoded = path.encode("ascii")
    digest.update(struct.pack(">I", len(encoded)))
    digest.update(encoded)
    digest.update(b"\x01" if executable else b"\x00")
    digest.update(struct.pack(">Q", size))


def _directory_entries(root_descriptor: int) -> dict[str, os.stat_result]:
    entries: dict[str, os.stat_result] = {}
    collisions: set[str] = set()
    entry_count = 0

    def visit(directory_descriptor: int, prefix: str, depth: int) -> None:
        nonlocal entry_count
        if depth > MAX_DEPTH:
            raise ProtocolError("model content directory depth is outside limits")
        try:
            children = list(os.scandir(directory_descriptor))
        except OSError as error:
            raise ProtocolError("model content directory cannot be scanned") from error
        for child in children:
            entry_count += 1
            if entry_count > MAX_ENTRIES:
                raise ProtocolError("model content directory entry count is outside limits")
            relative = f"{prefix}/{child.name}" if prefix else child.name
            canonical = _canonical_path(relative)
            collision = canonical.casefold()
            if collision in collisions:
                raise ProtocolError("model content paths are duplicated or case-colliding")
            collisions.add(collision)
            metadata = os.stat(child.name, dir_fd=directory_descriptor, follow_symlinks=False)
            if stat.S_ISLNK(metadata.st_mode):
                raise ProtocolError("model content symbolic links are forbidden")
            if stat.S_ISDIR(metadata.st_mode):
                child_descriptor = _open_relative(root_descriptor, canonical, directory=True)
                try:
                    opened = os.fstat(child_descriptor)
                    if (opened.st_dev, opened.st_ino, opened.st_mode) != (
                        metadata.st_dev, metadata.st_ino, metadata.st_mode,
                    ):
                        raise ProtocolError("model content directory changed during scan")
                    visit(child_descriptor, canonical, depth + 1)
                    if _metadata_tuple(opened) != _metadata_tuple(os.fstat(child_descriptor)):
                        raise ProtocolError("model content directory changed during scan")
                finally:
                    os.close(child_descriptor)
            elif stat.S_ISREG(metadata.st_mode):
                if metadata.st_nlink != 1:
                    raise ProtocolError("model content hard links are forbidden")
                entries[canonical] = metadata
            else:
                raise ProtocolError("model content special files are forbidden")

    visit(root_descriptor, "", 1)
    return entries


def _canonicalize_directory(root: Path) -> str:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW | os.O_DIRECTORY
    try:
        root_descriptor = os.open(root, flags)
    except OSError as error:
        raise ProtocolError("model content directory is invalid") from error
    try:
        root_before = os.fstat(root_descriptor)
        entries = _directory_entries(root_descriptor)
        manifest_entry = entries.pop(MANIFEST_NAME, None)
        if manifest_entry is None:
            raise ProtocolError("model content manifest is missing")
        manifest_descriptor = _open_relative(root_descriptor, MANIFEST_NAME)
        try:
            manifest_before = os.fstat(manifest_descriptor)
            if _metadata_tuple(manifest_entry) != _metadata_tuple(manifest_before):
                raise ProtocolError("model content manifest changed after directory scan")
            with os.fdopen(manifest_descriptor, "rb", closefd=False) as source:
                manifest_content = source.read(MAX_MANIFEST_BYTES + 1)
            if _metadata_tuple(manifest_before) != _metadata_tuple(os.fstat(manifest_descriptor)):
                raise ProtocolError("model content manifest changed while it was read")
        finally:
            os.close(manifest_descriptor)
        manifest = _parse_manifest(manifest_content)
        expected = {path for path, _ in manifest}
        if set(entries) != expected:
            raise ProtocolError("model content files do not exactly match the manifest allowlist")
        digest = sha256(b"NIR_MODEL_CONTENT_V1\x00")
        total = 0
        for relative, executable in manifest:
            scanned = entries[relative]
            descriptor = _open_relative(root_descriptor, relative)
            try:
                before = os.fstat(descriptor)
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                    raise ProtocolError("model content must use unique regular files")
                if _metadata_tuple(scanned) != _metadata_tuple(before):
                    raise ProtocolError("model content changed after directory scan")
                actual_executable = bool(before.st_mode & 0o111)
                if actual_executable != executable:
                    raise ProtocolError("model content executable bit does not match manifest")
                total += before.st_size
                if total > MAX_TOTAL_BYTES:
                    raise ProtocolError("model content total size is outside limits")
                _frame_file(digest, relative, executable, before.st_size)
                with os.fdopen(descriptor, "rb", closefd=False) as source:
                    _hash_stream(digest, source, before.st_size)
                after = os.fstat(descriptor)
                if _metadata_tuple(before) != _metadata_tuple(after):
                    raise ProtocolError("model content changed while it was being hashed")
            finally:
                os.close(descriptor)
        root_after = os.fstat(root_descriptor)
        try:
            path_after = os.stat(root, follow_symlinks=False)
        except OSError as error:
            raise ProtocolError("model content root changed during hashing") from error
        if (
            _metadata_tuple(root_before) != _metadata_tuple(root_after)
            or not stat.S_ISDIR(path_after.st_mode)
            or (path_after.st_dev, path_after.st_ino) != (root_before.st_dev, root_before.st_ino)
        ):
            raise ProtocolError("model content root changed during hashing")
        return f"sha256:{digest.hexdigest()}"
    finally:
        os.close(root_descriptor)


def _strip_archive_wrapper(names: Iterable[str]) -> tuple[str, dict[str, str]]:
    canonical_names = [_canonical_path(name.rstrip("/")) for name in names]
    manifests = [name for name in canonical_names if name == MANIFEST_NAME or name.endswith(f"/{MANIFEST_NAME}")]
    if len(manifests) != 1:
        raise ProtocolError("archive must contain exactly one model content manifest")
    manifest = manifests[0]
    prefix = manifest[: -len(MANIFEST_NAME)].rstrip("/")
    mapping: dict[str, str] = {}
    folded: set[str] = set()
    for original, canonical in zip(names, canonical_names, strict=True):
        if prefix:
            if canonical == prefix:
                relative = ""
            elif canonical.startswith(f"{prefix}/"):
                relative = canonical[len(prefix) + 1 :]
            else:
                raise ProtocolError("archive contains entries outside its single wrapper directory")
        else:
            relative = canonical
        if relative:
            collision = relative.casefold()
            if collision in folded:
                raise ProtocolError("archive paths are duplicated or case-colliding")
            folded.add(collision)
            mapping[original] = relative
    return manifest, mapping


def _canonicalize_tar(path: Path) -> str:
    descriptor, before = _open_regular(path)
    try:
        if before.st_size < 1 or before.st_size > MAX_ARCHIVE_BYTES:
            raise ProtocolError("model content archive size is outside limits")
        with os.fdopen(descriptor, "rb", closefd=False) as archive_source:
            try:
                archive = tarfile.open(fileobj=archive_source, mode="r:*")
            except (OSError, tarfile.TarError) as error:
                raise ProtocolError("model content archive is invalid") from error
            with archive:
                members = archive.getmembers()
                if not members or len(members) > MAX_ENTRIES:
                    raise ProtocolError("model content archive entry count is outside limits")
                for member in members:
                    if not (member.isdir() or member.isreg()):
                        raise ProtocolError("model content archive links and special files are forbidden")
                manifest_name, mapping = _strip_archive_wrapper([member.name for member in members])
                by_relative = {mapping[member.name]: member for member in members if mapping.get(member.name)}
                manifest_member = next(member for member in members if member.name.rstrip("/") == manifest_name)
                manifest_stream = archive.extractfile(manifest_member)
                if manifest_stream is None or manifest_member.size > MAX_MANIFEST_BYTES:
                    raise ProtocolError("model content manifest is invalid")
                manifest = _parse_manifest(manifest_stream.read(MAX_MANIFEST_BYTES + 1))
                expected = {MANIFEST_NAME, *(relative for relative, _ in manifest)}
                regular = {relative for relative, member in by_relative.items() if member.isreg()}
                if regular != expected:
                    raise ProtocolError("model content archive does not exactly match the manifest allowlist")
                digest = sha256(b"NIR_MODEL_CONTENT_V1\x00")
                total = 0
                for relative, executable in manifest:
                    member = by_relative[relative]
                    actual_executable = bool(member.mode & 0o111)
                    if actual_executable != executable:
                        raise ProtocolError("model content executable bit does not match manifest")
                    total += member.size
                    if total > MAX_TOTAL_BYTES:
                        raise ProtocolError("model content total size is outside limits")
                    source = archive.extractfile(member)
                    if source is None:
                        raise ProtocolError("model content archive member cannot be read")
                    _frame_file(digest, relative, executable, member.size)
                    _hash_stream(digest, source, member.size)
            after = os.fstat(descriptor)
            if _metadata_tuple(before) != _metadata_tuple(after):
                raise ProtocolError("model content archive changed while it was being read")
            return f"sha256:{digest.hexdigest()}"
    finally:
        os.close(descriptor)


def canonical_model_content_commitment(path: str | Path) -> str:
    """Return the bounded `nir-model-content-v1` commitment for a directory or tar archive."""
    _require_secure_open_support()
    source = Path(path)
    if source.is_symlink():
        raise ProtocolError("model content source cannot be a symbolic link")
    if source.is_dir():
        return _canonicalize_directory(source)
    return _canonicalize_tar(source)

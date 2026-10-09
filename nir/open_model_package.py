"""Strict, read-only byte identity for a pinned open-model package.

This is an inventory check, not a downloader, sandbox, runtime attestation, or
reward proof. A production runner must verify and execute an immutable snapshot
inside isolation and independently attest the runtime/dependency digests.
"""

from __future__ import annotations

from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat
from typing import Any


FORMAT = "nir-open-model-package-v2"
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_REVISION = re.compile(r"^[0-9a-f]{40}$")
_REPOSITORY_PART = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
_PATH_PART = re.compile(r"^[A-Za-z0-9._+-]{1,255}$")
MAX_FILES = 10_000
MAX_FILE_BYTES = 128 * (1 << 30)
MAX_TOTAL_BYTES = 1 << 40
MAX_PATH_BYTES = 4_096
MAX_PATH_COMPONENTS = 32


class PackageError(ValueError):
    """An open-model package is malformed or differs from its inventory."""


def _path(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise PackageError("package path is invalid")
    try:
        length = len(value.encode("utf-8"))
    except UnicodeEncodeError as error:
        raise PackageError("package path is not valid UTF-8") from error
    if length > MAX_PATH_BYTES:
        raise PackageError("package path is invalid")
    parts = value.split("/")
    if len(parts) > MAX_PATH_COMPONENTS or any(
        part in {"", ".", ".."} or not _PATH_PART.fullmatch(part) for part in parts
    ):
        raise PackageError("package path is not a canonical relative path")
    return value


def _validated_manifest(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "format", "repository", "revision", "runtimeDigest", "dependencyDigest", "files",
    } or value["format"] != FORMAT:
        raise PackageError("open-model package manifest schema is invalid")
    repository = value["repository"]
    if (not isinstance(repository, str) or len(repository.split("/")) != 2 or
            any(not _REPOSITORY_PART.fullmatch(part) or part in {".", ".."}
                for part in repository.split("/"))):
        raise PackageError("open-model repository is invalid")
    if not isinstance(value["revision"], str) or not _REVISION.fullmatch(value["revision"]):
        raise PackageError("open-model revision must be a pinned Git commit")
    for field in ("runtimeDigest", "dependencyDigest"):
        if not isinstance(value[field], str) or not _DIGEST.fullmatch(value[field]):
            raise PackageError(f"{field} must be a SHA-256 digest")
    files = value["files"]
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise PackageError("package file count is outside limits")
    total = 0
    previous = ""
    normalized = []
    for item in files:
        if not isinstance(item, dict) or set(item) != {"path", "size", "sha256"}:
            raise PackageError("package file entry schema is invalid")
        name = _path(item["path"])
        if name <= previous:
            raise PackageError("package paths must be sorted and unique")
        previous = name
        size = item["size"]
        if not isinstance(size, int) or isinstance(size, bool) or not 0 <= size <= MAX_FILE_BYTES:
            raise PackageError("package file size is outside limits")
        total += size
        if total > MAX_TOTAL_BYTES:
            raise PackageError("package total size is outside limits")
        if not isinstance(item["sha256"], str) or not _DIGEST.fullmatch(item["sha256"]):
            raise PackageError("package file SHA-256 digest is invalid")
        normalized.append({"path": name, "size": size, "sha256": item["sha256"]})
    return {
        "format": FORMAT,
        "repository": repository,
        "revision": value["revision"],
        "runtimeDigest": value["runtimeDigest"],
        "dependencyDigest": value["dependencyDigest"],
        "files": normalized,
    }


def _open_root(root: str | Path) -> int:
    if not getattr(os, "O_NOFOLLOW", 0) or not getattr(os, "O_DIRECTORY", 0):
        raise PackageError("this host cannot open package directories safely")
    path = os.fspath(root)
    if not isinstance(path, str) or not path.startswith("/") or "\x00" in path:
        raise PackageError("package root must be an absolute directory path")
    parts = path.split("/")[1:]
    if any(part in {"", ".", ".."} for part in parts):
        raise PackageError("package root path is not canonical")
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open("/", flags)
    try:
        for part in parts:
            next_descriptor = os.open(part, flags | nofollow, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except (OSError, TypeError, NotImplementedError) as error:
        os.close(descriptor)
        raise PackageError("package root cannot be opened without symlinks") from error


def _inventory(
    directory: int, expected: set[str], expected_dirs: set[str], prefix: str = "",
) -> list[str]:
    found = []
    for name in os.listdir(directory):
        relative = f"{prefix}{name}"
        _path(relative)
        metadata = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if stat.S_ISDIR(metadata.st_mode):
            if relative not in expected_dirs:
                raise PackageError("package contains an unlisted directory")
            child = os.open(
                name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) |
                getattr(os, "O_NOFOLLOW", 0), dir_fd=directory,
            )
            try:
                found.extend(_inventory(child, expected, expected_dirs, f"{relative}/"))
            finally:
                os.close(child)
        elif stat.S_ISREG(metadata.st_mode):
            if relative not in expected:
                raise PackageError("package contains an unlisted file")
            if metadata.st_nlink != 1:
                raise PackageError("package contains a hard-linked file")
            found.append(relative)
        else:
            raise PackageError("package contains a symlink or special file")
        if len(found) > MAX_FILES:
            raise PackageError("package file count is outside limits")
    return found


def _measure(root: int, name: str, expected_size: int) -> str:
    current = os.dup(root)
    try:
        parts = name.split("/")
        for part in parts[:-1]:
            next_descriptor = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) |
                getattr(os, "O_NOFOLLOW", 0), dir_fd=current,
            )
            os.close(current)
            current = next_descriptor
        descriptor = os.open(
            parts[-1], os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) |
            getattr(os, "O_NOFOLLOW", 0), dir_fd=current,
        )
        try:
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                    before.st_size != expected_size):
                raise PackageError("package file type or size does not match manifest")
            hasher = sha256()
            total = 0
            while True:
                chunk = os.read(descriptor, min(1 << 20, expected_size + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > expected_size:
                    raise PackageError("package file grew while being read")
                hasher.update(chunk)
            after = os.fstat(descriptor)
            if (total != expected_size or before.st_dev != after.st_dev or
                    before.st_ino != after.st_ino or before.st_size != after.st_size or
                    before.st_mtime_ns != after.st_mtime_ns or
                    before.st_ctime_ns != after.st_ctime_ns):
                raise PackageError("package file changed while being read")
            return f"sha256:{hasher.hexdigest()}"
        finally:
            os.close(descriptor)
    finally:
        os.close(current)


def verify_package(root: str | Path, manifest: object) -> str:
    """Measure all package bytes and return a domain-separated v2 identity.

    Runtime and dependency digests are *bound declarations*, not observations
    of the current host. No model bytes are executed or retained by this call.
    """
    checked = _validated_manifest(manifest)
    try:
        descriptor = _open_root(root)
        try:
            expected = {item["path"] for item in checked["files"]}
            expected_dirs = {
                "/".join(parts[:index])
                for name in expected for parts in (name.split("/"),)
                for index in range(1, len(parts))
            }
            actual = set(_inventory(descriptor, expected, expected_dirs))
            if actual != expected:
                raise PackageError("package inventory has extra or missing files")
            for item in checked["files"]:
                measured = _measure(descriptor, item["path"], item["size"])
                if measured != item["sha256"]:
                    raise PackageError("package file SHA-256 does not match manifest")
            # Detect additions/removals during the streaming pass. This is not
            # an atomic snapshot: execution still requires an immutable mount.
            if set(_inventory(descriptor, expected, expected_dirs)) != expected:
                raise PackageError("package inventory changed during measurement")
        finally:
            os.close(descriptor)
    except (OSError, TypeError, NotImplementedError, RecursionError) as error:
        raise PackageError("package could not be measured safely") from error
    canonical = json.dumps(checked, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    return f"sha256:{sha256(b'NIR_OPEN_MODEL_PACKAGE_V2\x00' + canonical).hexdigest()}"

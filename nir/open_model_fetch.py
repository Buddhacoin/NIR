"""Fetch a reviewed-by-caller Hub revision into a verified local core package.

This is a download and consistency preflight only. Hub/TLS trust does not prove
publisher authorship or licence. It cannot execute a model or earn rewards.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha1, sha256
import os
from pathlib import Path
import re
import stat
import tempfile
from typing import Callable, Iterator

from nir.open_model_package import FORMAT, PackageError, _path, _validated_manifest, verify_package
from nir.open_model_snapshot import MAX_SNAPSHOT_BYTES, REQUIRED_FILES
from nir.open_model_source import (
    ORIGIN, SourceError, _fetch, _json_response, verify_hub_source,
)


_SHA1 = re.compile(r"^[0-9a-f]{40}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
SUPPORTED_REVISIONS = {
    "Qwen/Qwen3-0.6B": "c1899de289a04d12100db370d81485cdf75e47ca",
    "TinyLlama/TinyLlama-1.1B-Chat-v1.0": "fe8a4ea1ffedaf415f4da2f062534de366a451e6",
}


class FetchError(ValueError):
    """Pinned model core files could not be downloaded and reconciled safely."""


@dataclass(frozen=True, slots=True)
class FetchedPackage:
    path: Path
    manifest: dict
    identity: str


def _download_hub(*, repo_id: str, filename: str, revision: str,
                  token: bool, local_dir: str, endpoint: str) -> str:
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as error:
        raise FetchError("huggingface_hub is required for model downloads") from error
    # token=False prevents implicit use of a user's Hub token. Download only
    # to this invocation's temporary directory, never into a user cache path.
    return hf_hub_download(repo_id=repo_id, filename=filename,
                           revision=revision, token=token,
                           local_dir=local_dir, endpoint=endpoint)


def _pinned_tree(repo: str, revision: str, fetch: Callable) -> dict[str, dict]:
    metadata = _json_response(f"{ORIGIN}/api/models/{repo}/revision/{revision}", fetch)
    if (not isinstance(metadata, dict) or metadata.get("id") != repo or
            metadata.get("sha") != revision or metadata.get("private") is not False or
            metadata.get("gated") is not False):
        raise FetchError("pinned Hub revision is unavailable or restricted")
    tree = _json_response(
        f"{ORIGIN}/api/models/{repo}/tree/{revision}?recursive=true&expand=false", fetch,
    )
    if not isinstance(tree, list) or not 1 <= len(tree) <= 1_000:
        raise FetchError("pinned Hub tree is missing or too large")
    required = REQUIRED_FILES[repo]
    selected: dict[str, dict] = {}
    seen = set()
    for entry in tree:
        if not isinstance(entry, dict) or entry.get("type") != "file":
            raise FetchError("pinned Hub tree contains a non-file")
        name = _path(entry.get("path"))
        if name in seen:
            raise FetchError("pinned Hub tree contains duplicate paths")
        seen.add(name)
        size = entry.get("size")
        if type(size) is not int or size < 0:
            raise FetchError("pinned Hub tree contains invalid size")
        oid = entry.get("oid")
        if not isinstance(oid, str) or not _SHA1.fullmatch(oid):
            raise FetchError("pinned Hub tree contains invalid Git object id")
        lfs = entry.get("lfs")
        if lfs is not None and (not isinstance(lfs, dict) or
                                type(lfs.get("size")) is not int or lfs["size"] != size or
                                not isinstance(lfs.get("oid"), str) or
                                not _SHA256.fullmatch(lfs["oid"])):
            raise FetchError("pinned Hub tree contains invalid LFS metadata")
        if name in required:
            selected[name] = entry
    if set(selected) != required:
        raise FetchError("pinned Hub revision lacks curated core files")
    if sum(item["size"] for item in selected.values()) > MAX_SNAPSHOT_BYTES:
        raise FetchError("pinned model core exceeds 4 GiB limit")
    return selected


def _copy_download(download_root: Path, output_root: Path, name: str,
                   entry: dict) -> dict:
    """Read the exact top-level download without symlinks, measuring its copy."""
    input_root = os.open(download_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    output_root_fd = os.open(output_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=input_root)
        try:
            before = os.fstat(source)
            size = entry["size"]
            if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                    before.st_size != size):
                raise FetchError("downloaded file type or size differs from Hub tree")
            target = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o400, dir_fd=output_root_fd)
            try:
                raw = sha256()
                git = sha1(b"blob " + str(size).encode("ascii") + b"\0")
                total = 0
                while True:
                    chunk = os.read(source, min(1 << 20, size + 1 - total))
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > size:
                        raise FetchError("downloaded file grew during copy")
                    raw.update(chunk)
                    git.update(chunk)
                    remaining = memoryview(chunk)
                    while remaining:
                        written = os.write(target, remaining)
                        if written <= 0:
                            raise FetchError("model package write made no progress")
                        remaining = remaining[written:]
                after = os.fstat(source)
                if (total != size or (before.st_dev, before.st_ino, before.st_size,
                                      before.st_mtime_ns, before.st_ctime_ns) !=
                        (after.st_dev, after.st_ino, after.st_size,
                         after.st_mtime_ns, after.st_ctime_ns)):
                    raise FetchError("downloaded file changed while copied")
                lfs = entry.get("lfs")
                if ((lfs is None and git.hexdigest() != entry["oid"]) or
                        (lfs is not None and raw.hexdigest() != lfs["oid"])):
                    raise FetchError("downloaded bytes differ from pinned Hub tree")
                os.fchmod(target, 0o400)
                os.fsync(target)
                return {"path": name, "size": size, "sha256": "sha256:" + raw.hexdigest()}
            finally:
                os.close(target)
        finally:
            os.close(source)
    finally:
        os.close(output_root_fd)
        os.close(input_root)


@contextmanager
def fetched_curated_model(
    repository: str, revision: str, runtime_digest: str, dependency_digest: str,
    *, fetch: Callable = _fetch, downloader: Callable | None = None,
    parent: str | Path | None = None,
) -> Iterator[FetchedPackage]:
    """Download a pinned core package and yield it only while its temp tree lives.

    Digest parameters are caller declarations, not measurements of runtime or
    dependencies. This does not review licences, safely execute code, isolate
    same-UID processes, or make a package reward-eligible.
    """
    if (repository not in REQUIRED_FILES or not isinstance(revision, str) or
            not _SHA1.fullmatch(revision) or SUPPORTED_REVISIONS.get(repository) != revision):
        raise FetchError("a supported pinned repository revision is required")
    # Validate declarations before network access.
    prototype = {"format": FORMAT, "repository": repository,
                 "revision": revision, "runtimeDigest": runtime_digest,
                 "dependencyDigest": dependency_digest,
                 "files": [{"path": "placeholder", "size": 0,
                            "sha256": "sha256:" + "0" * 64}]}
    try:
        _validated_manifest(prototype)
        selected = _pinned_tree(repository, revision, fetch)
    except (SourceError, PackageError, OSError, TypeError, ValueError) as error:
        if isinstance(error, FetchError):
            raise
        raise FetchError("pinned Hub metadata could not be validated") from error
    try:
        temporary = tempfile.TemporaryDirectory(prefix="nir-model-fetch-", dir=parent)
    except (OSError, TypeError, ValueError) as error:
        raise FetchError("private model download directory could not be created") from error
    with temporary as temp:
        try:
            base = Path(temp).resolve()
            download_root = base / "incoming"
            output_root = base / "package"
            download_root.mkdir(mode=0o700)
            output_root.mkdir(mode=0o700)
            files = []
            for name in sorted(selected):
                try:
                    result = (downloader or _download_hub)(
                        repo_id=repository, filename=name, revision=revision,
                        token=False, local_dir=str(download_root), endpoint=ORIGIN,
                    )
                except Exception as error:
                    raise FetchError("pinned model file download failed") from error
                if not isinstance(result, (str, Path)) or os.path.abspath(result) != str(download_root / name):
                    raise FetchError("downloader returned an unexpected file path")
                files.append(_copy_download(download_root, output_root, name, selected[name]))
            manifest = {"format": FORMAT, "repository": repository,
                        "revision": revision, "runtimeDigest": runtime_digest,
                        "dependencyDigest": dependency_digest, "files": files}
            identity = verify_package(output_root, manifest)
            if verify_hub_source(output_root, manifest, fetch=fetch) != identity:
                raise FetchError("downloaded package identity changed")
        except (FetchError, SourceError, PackageError, OSError, TypeError, ValueError) as error:
            if isinstance(error, FetchError):
                raise
            raise FetchError("model download or package verification failed") from error
        yield FetchedPackage(output_root, manifest, identity)

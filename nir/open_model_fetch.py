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
from time import monotonic
from typing import Callable, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

from nir.open_model_package import FORMAT, PackageError, _path, _validated_manifest, verify_package
from nir.open_model_snapshot import MAX_SNAPSHOT_BYTES, REQUIRED_FILES
from nir.open_model_source import (
    ORIGIN, SourceError, _fetch, _json_response, _tls_context, verify_hub_source,
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


class _HubRedirect(HTTPRedirectHandler):
    """Follow only HTTPS redirects to known Hub-controlled download hosts."""

    def redirect_request(self, request, fp, code, message, headers, newurl):
        parsed = urlsplit(newurl)
        host = parsed.hostname or ""
        if (parsed.scheme != "https" or parsed.username or parsed.password or
                parsed.port not in (None, 443) or
                not (host == "huggingface.co" or host.endswith(".hf.co") or
                     host.endswith(".huggingface.co"))):
            raise FetchError("model download redirected outside trusted HTTPS hosts")
        return super().redirect_request(request, fp, code, message, headers, newurl)


def _download_hub(*, repo_id: str, filename: str, revision: str,
                  token: bool, local_dir: str, endpoint: str,
                  expected_size: int, open_response: Callable | None = None,
                  clock: Callable[[], float] = monotonic,
                  deadline: float | None = None) -> str:
    """Stream no more than the pinned file size before accepting any bytes.

    This bounds our own download writes, unlike a downloader that fills its
    cache before the caller gets to inspect the returned file. It does not
    provide a host-wide disk quota or protect against a same-UID process.
    """
    if (token is not False or endpoint != ORIGIN or type(expected_size) is not int or
            expected_size < 0 or expected_size > MAX_SNAPSHOT_BYTES or
            repo_id not in REQUIRED_FILES or filename not in REQUIRED_FILES[repo_id] or
            not _SHA1.fullmatch(revision)):
        raise FetchError("unsupported pinned model download")
    url = f"{ORIGIN}/{quote(repo_id, safe='/')}/resolve/{revision}/{quote(filename, safe='')}"
    opener = open_response or build_opener(_HubRedirect, HTTPSHandler(context=_tls_context())).open
    deadline = clock() + 20 * 60 if deadline is None else deadline
    directory = os.open(local_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        target = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o400, dir_fd=directory)
        try:
            request = Request(url, headers={"Accept-Encoding": "identity"}, method="GET")
            with opener(request, timeout=15) as response:
                if clock() >= deadline:
                    raise FetchError("model download exceeded time limit")
                if response.status != 200:
                    raise FetchError("model download returned a non-success status")
                length = response.headers.get("Content-Length")
                if length is not None and (not length.isdigit() or int(length) != expected_size):
                    raise FetchError("model download length differs from pinned metadata")
                if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                    raise FetchError("compressed model download is not accepted")
                count = 0
                while True:
                    if clock() >= deadline:
                        raise FetchError("model download exceeded time limit")
                    chunk = response.read(min(1 << 20, expected_size + 1 - count))
                    if clock() >= deadline:
                        raise FetchError("model download exceeded time limit")
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > expected_size:
                        raise FetchError("model download exceeded pinned byte limit")
                    remaining = memoryview(chunk)
                    while remaining:
                        written = os.write(target, remaining)
                        if written <= 0:
                            raise FetchError("model download write made no progress")
                        remaining = remaining[written:]
                if count != expected_size:
                    raise FetchError("model download ended before pinned byte count")
            os.fsync(target)
        finally:
            os.close(target)
        return str(Path(local_dir) / filename)
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        raise FetchError("pinned model download failed") from error
    finally:
        os.close(directory)


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
            deadline = monotonic() + 20 * 60
            for name in sorted(selected):
                try:
                    result = (downloader or _download_hub)(
                        repo_id=repository, filename=name, revision=revision,
                        token=False, local_dir=str(download_root), endpoint=ORIGIN,
                        expected_size=selected[name]["size"],
                        deadline=deadline,
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

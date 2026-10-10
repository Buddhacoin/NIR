"""Read-only Hub/source consistency preflight for two curated model repositories.

This checks local bytes against metadata served by Hugging Face for one full
commit SHA, under TLS and Hub API trust. It does not authenticate a publisher,
verify a signature or licence, download weights, establish an immutable local
snapshot, execute a model, or make evidence reward-eligible. In particular,
Hub metadata is not a cryptographic proof that the claimed publisher authored
the model. A caller must separately review the exact revision and licence.
"""

from __future__ import annotations

from hashlib import sha1, sha256
import json
import os
from pathlib import Path
import re
import ssl
import stat
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

from nir.open_model_package import (
    PackageError, _open_root, _path, _validated_manifest, verify_package,
)


ALLOWED_REPOS = frozenset({
    "Qwen/Qwen3-0.6B", "TinyLlama/TinyLlama-1.1B-Chat-v1.0",
})
ORIGIN = "https://huggingface.co"
MAX_RESPONSE = 2 * 1024 * 1024
MAX_TREE_FILES = 1_000
_SHA1 = re.compile(r"^[0-9a-f]{40}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class SourceError(ValueError):
    """Local package and pinned Hub metadata cannot be reconciled safely."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def _tls_context() -> ssl.SSLContext:
    """Require an actual CA store; use certifi on Python installs without one."""
    try:
        context = ssl.create_default_context()
        if context.get_ca_certs():
            return context
        if os.environ.get("SSL_CERT_FILE") or os.environ.get("SSL_CERT_DIR"):
            raise SourceError("configured TLS CA store is empty")
        import certifi  # optional fallback for macOS framework Python
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError as error:
        raise SourceError("no trusted TLS CA store is available") from error
    except (OSError, ssl.SSLError) as error:
        raise SourceError("trusted TLS CA store could not be loaded") from error


def _fetch(url: str) -> tuple[int, dict[str, str], bytes]:
    """Fetch only caller-constructed API URLs; never follow a redirect."""
    request = Request(url, headers={"Accept": "application/json"}, method="GET")
    opener = build_opener(_NoRedirect, HTTPSHandler(context=_tls_context()))
    try:
        with opener.open(request, timeout=5) as response:
            headers = {name.lower(): value for name, value in response.headers.items()}
            body = response.read(MAX_RESPONSE + 1)
            return response.status, headers, body
    except HTTPError as error:
        raise SourceError(f"Hub API returned HTTP {error.code}") from error
    except (URLError, OSError, TimeoutError) as error:
        raise SourceError("Hub API is unavailable") from error


def _no_duplicate_keys(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise SourceError("Hub JSON contains duplicate fields")
        result[name] = value
    return result


def _json_response(url: str, fetch: Callable) -> object:
    try:
        status, headers, body = fetch(url)
        normalized = {str(key).lower(): value for key, value in headers.items()}
        length = normalized.get("content-length")
        if (status != 200 or "link" in normalized or "location" in normalized or
                normalized.get("content-encoding", "identity") != "identity" or
                not re.fullmatch(r"application/json(?:\s*;.*)?", normalized.get("content-type", ""), re.I) or
                not isinstance(body, bytes) or len(body) > MAX_RESPONSE or
                (length is not None and (not str(length).isdigit() or int(length) != len(body)))):
            raise SourceError("invalid or incomplete Hub API response")
        parsed = json.loads(body.decode("utf-8", errors="strict"), object_pairs_hook=_no_duplicate_keys)
        count = normalized.get("x-total-count")
        if count is not None and (not str(count).isdigit() or
                                  not isinstance(parsed, list) or int(count) != len(parsed)):
            raise SourceError("Hub tree response is incomplete")
        return parsed
    except (UnicodeError, json.JSONDecodeError, TypeError, ValueError) as error:
        if isinstance(error, SourceError):
            raise
        raise SourceError("Hub API response is malformed") from error


def _git_blob_oid(directory: int, name: str, expected_size: int, expected_raw_sha: str) -> str:
    """Compute Git's blob SHA-1 while also rechecking the manifest's raw SHA-256."""
    current = os.dup(directory)
    try:
        parts = name.split("/")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
        for part in parts[:-1]:
            next_fd = os.open(part, flags | os.O_DIRECTORY, dir_fd=current)
            os.close(current)
            current = next_fd
        fd = os.open(parts[-1], flags, dir_fd=current)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != expected_size:
                raise SourceError("local Git file changed before measurement")
            blob = sha1(b"blob " + str(expected_size).encode("ascii") + b"\0")
            raw = sha256()
            size = 0
            while True:
                chunk = os.read(fd, min(1 << 20, expected_size + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > expected_size:
                    raise SourceError("local Git file grew during measurement")
                blob.update(chunk)
                raw.update(chunk)
            after = os.fstat(fd)
            if (size != expected_size or f"sha256:{raw.hexdigest()}" != expected_raw_sha or
                    (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) !=
                    (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
                raise SourceError("local Git file changed during measurement")
            return blob.hexdigest()
        finally:
            os.close(fd)
    finally:
        os.close(current)


def verify_hub_source(root: str | Path, manifest: object, *, fetch: Callable = _fetch) -> str:
    """Return local package identity iff it agrees with a pinned Hub file tree.

    The result remains a *source-consistency preflight*, not publisher
    authentication or a reward proof. Neither Hub data nor local bytes are
    held atomically after this function returns.
    """
    try:
        checked = _validated_manifest(manifest)
        if checked["repository"] not in ALLOWED_REPOS:
            raise SourceError("model repository is not curated")
        # Validate local bytes before trusting any remote account metadata.
        identity = verify_package(root, checked)
        repo = checked["repository"]
        revision = checked["revision"]
        metadata_url = f"{ORIGIN}/api/models/{repo}/revision/{revision}"
        tree_url = f"{ORIGIN}/api/models/{repo}/tree/{revision}?recursive=true&expand=false"
        metadata = _json_response(metadata_url, fetch)
        if (not isinstance(metadata, dict) or metadata.get("id") != repo or
                metadata.get("sha") != revision or metadata.get("private") is not False or
                metadata.get("gated") is not False):
            raise SourceError("pinned Hub model metadata does not match")
        tree = _json_response(tree_url, fetch)
        if not isinstance(tree, list) or not 1 <= len(tree) <= MAX_TREE_FILES:
            raise SourceError("pinned Hub file tree is missing or outside limits")
        files = {item["path"]: item for item in checked["files"]}
        seen = set()
        matched = set()
        descriptor = _open_root(root)
        try:
            for entry in tree:
                if not isinstance(entry, dict) or entry.get("type") != "file":
                    raise SourceError("Hub tree contains a non-file or malformed entry")
                name = _path(entry.get("path"))
                if name in seen:
                    raise SourceError("Hub tree contains duplicate path")
                seen.add(name)
                if type(entry.get("size")) is not int or entry["size"] < 0:
                    raise SourceError("Hub file size is invalid")
                if not isinstance(entry.get("oid"), str) or not _SHA1.fullmatch(entry["oid"]):
                    raise SourceError("Hub Git OID is missing")
                lfs = entry.get("lfs")
                if lfs is not None and (not isinstance(lfs, dict) or
                                        type(lfs.get("size")) is not int or
                                        lfs["size"] != entry["size"] or
                                        not isinstance(lfs.get("oid"), str) or
                                        not _SHA256.fullmatch(lfs["oid"])):
                    raise SourceError("Hub LFS metadata is malformed")
                # The execution package may intentionally select a subset of
                # the repository. Every Hub entry is validated, but only
                # listed local files are byte-compared. Local extra files are
                # rejected by verify_package above and below.
                if name not in files:
                    continue
                matched.add(name)
                expected = files[name]
                if entry["size"] != expected["size"]:
                    raise SourceError("Hub file size differs from local manifest")
                if lfs is None:
                    actual_oid = _git_blob_oid(descriptor, name, expected["size"], expected["sha256"])
                    if actual_oid != entry["oid"]:
                        raise SourceError("Git blob OID differs from pinned Hub tree")
                else:
                    if expected["sha256"] != f"sha256:{lfs['oid']}":
                        raise SourceError("LFS object differs from pinned Hub tree")
            if matched != set(files):
                raise SourceError("Hub tree omits local package files")
        finally:
            os.close(descriptor)
        # Ensure a package mutation during remote requests is not silently accepted.
        if verify_package(root, checked) != identity:
            raise SourceError("local package changed during source preflight")
        return identity
    except (PackageError, OSError, TypeError, NotImplementedError) as error:
        if isinstance(error, SourceError):
            raise
        raise SourceError("source preflight could not safely verify package") from error

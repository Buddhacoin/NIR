"""Opt-in local Qwen inference experiment; never a mining or reward proof.

The temporary package is writable by another same-UID process. Pre/post byte
checks are useful corruption checks, NOT an immutable execution boundary.
"""

from __future__ import annotations

import argparse
from hashlib import sha256
from importlib.metadata import PackageNotFoundError, version
import json
import os
import platform
from pathlib import Path
import stat
import sys
from typing import Callable

from nir.open_model_fetch import SUPPORTED_REVISIONS, fetched_curated_model
from nir.open_model_package import PackageError, verify_package


REPOSITORY = "Qwen/Qwen3-0.6B"
REVISION = SUPPORTED_REVISIONS[REPOSITORY]
RUNTIME_VERSIONS = {"mlx": "0.32.3", "mlx-lm": "0.32.0", "transformers": "5.17.0"}
REPLAY_FORMAT = "nir-local-open-model-replay-v1"
REPLAY_SCOPE = "non-reward-local-replay"
REPLAY_DOMAIN = b"NIR_LOCAL_OPEN_MODEL_REPLAY_V1\x00"


class LocalRunError(ValueError):
    """Local inference could not be completed without violating its limits."""


def _digest(label: str) -> str:
    # These are declarations for package identity, not attestations.
    return "sha256:" + sha256(label.encode("ascii")).hexdigest()


def _valid_prompt(prompt: object) -> bool:
    return (isinstance(prompt, str) and 1 <= len(prompt) <= 256 and
            prompt == prompt.strip() and
            all(ord(char) >= 32 and ord(char) != 127 for char in prompt))


def _record_payload(prompt: str, answer: str, package_identity: str) -> dict:
    return {
        "format": REPLAY_FORMAT, "scope": REPLAY_SCOPE,
        "repository": REPOSITORY, "revision": REVISION,
        "packageIdentity": package_identity, "prompt": prompt, "answer": answer,
        "generation": {"temperature": "0", "maxTokens": 32},
        "runtimeDeclaration": dict(RUNTIME_VERSIONS),
        "rewardEligible": False, "networkSubmitted": False,
        "independentlyVerified": False,
    }


def _record_hash(payload: dict) -> str:
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"),
                            ensure_ascii=False, allow_nan=False).encode("utf-8")
    return "sha256:" + sha256(REPLAY_DOMAIN + serialized).hexdigest()


def make_replay_record(prompt: str, answer: str, package_identity: str) -> dict:
    """A content-bound transcript, not an execution attestation or reward claim."""
    if (not _valid_prompt(prompt) or not isinstance(answer, str) or len(answer) > 4096 or
            not isinstance(package_identity, str) or
            not package_identity.startswith("sha256:") or
            len(package_identity) != 71 or
            any(char not in "0123456789abcdef" for char in package_identity[7:])):
        raise LocalRunError("local replay record fields are invalid")
    payload = _record_payload(prompt, answer, package_identity)
    return {**payload, "recordHash": _record_hash(payload)}


def validate_replay_record(record: object) -> dict:
    """Check exact transcript structure and hash; this does not check model execution."""
    if not isinstance(record, dict):
        raise LocalRunError("local replay record is invalid")
    prompt = record.get("prompt")
    answer = record.get("answer")
    identity = record.get("packageIdentity")
    expected = make_replay_record(prompt, answer, identity)
    if (set(record) != set(expected) or
            json.dumps(record, sort_keys=True, separators=(",", ":"),
                       ensure_ascii=False, allow_nan=False) !=
            json.dumps(expected, sort_keys=True, separators=(",", ":"),
                       ensure_ascii=False, allow_nan=False)):
        raise LocalRunError("local replay record differs from its exact commitment")
    return expected


def load_replay_record(path: str | Path) -> dict:
    """Read one bounded regular JSON file without following a final symlink."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= 16_384:
            raise LocalRunError("local replay input must be a bounded regular file")
        data = os.read(descriptor, 16_385)
        after = os.fstat(descriptor)
        if (len(data) != before.st_size or len(data) > 16_384 or
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
                 before.st_ctime_ns) !=
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns,
                 after.st_ctime_ns)):
            raise LocalRunError("local replay input changed during reading")
    finally:
        os.close(descriptor)

    def unique_pairs(pairs: list[tuple[str, object]]) -> dict:
        value = {}
        for key, item in pairs:
            if key in value:
                raise LocalRunError("local replay input has duplicate keys")
            value[key] = item
        return value

    try:
        return validate_replay_record(json.loads(data.decode("utf-8"), object_pairs_hook=unique_pairs))
    except (UnicodeError, ValueError, TypeError) as error:
        raise LocalRunError("local replay input is invalid") from error


def replay_record(record: object, *, fetch_package: Callable = fetched_curated_model,
                  backend: Callable[[Path, str], str] = None) -> dict:
    """Rerun pinned model locally; matching outputs are not independent attestation."""
    checked = validate_replay_record(record)
    kwargs = {"fetch_package": fetch_package}
    if backend is not None:
        kwargs["backend"] = backend
    rerun = run_pinned_qwen(checked["prompt"], **kwargs)
    if (rerun["packageIdentity"] != checked["packageIdentity"] or
            rerun["answer"] != checked["answer"]):
        raise LocalRunError("local replay differs from recorded package or answer")
    return {"status": "local-replay-matched", "recordHash": checked["recordHash"],
            "rewardEligible": False, "networkSubmitted": False,
            "independentlyVerified": False}


def runtime_status() -> dict:
    """Read-only local prerequisite check; no model metadata or bytes are fetched."""
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        return {"status": "unsupported-machine"}
    if sys.version_info[:2] != (3, 13):
        return {"status": "python-3.13-required"}
    for distribution, expected in RUNTIME_VERSIONS.items():
        try:
            actual = version(distribution)
        except PackageNotFoundError:
            return {"status": "missing-runtime", "package": distribution}
        if actual != expected:
            return {"status": "runtime-version-mismatch", "package": distribution,
                    "expected": expected}
    return {"status": "pinned-qwen-runtime-ready"}


def _check_runtime() -> None:
    result = runtime_status()
    if result["status"] != "pinned-qwen-runtime-ready":
        raise LocalRunError(f"local runtime unavailable: {result['status']}")


def _mlx_backend(package_path: Path, prompt: str) -> str:
    _check_runtime()
    # The package has already been downloaded and checked. Do not allow the
    # runtime to retrieve model code or fall back to an online model ID.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    model, tokenizer = load(str(package_path), trust_remote_code=False)
    formatted = tokenizer.apply_chat_template(
        [{"role": "user", "content": prompt}], tokenize=False,
        add_generation_prompt=True, enable_thinking=False,
    )
    return generate(model, tokenizer, prompt=formatted, verbose=False,
                    max_tokens=32, sampler=make_sampler(temp=0.0))


def run_pinned_qwen(
    prompt: str, *, fetch_package: Callable = fetched_curated_model,
    backend: Callable[[Path, str], str] = _mlx_backend,
) -> dict:
    """Fetch pinned Qwen bytes, run one local prompt, return non-reward output."""
    if not _valid_prompt(prompt):
        raise LocalRunError("prompt must be 1–256 printable characters")
    if backend is _mlx_backend:
        _check_runtime()
    try:
        with fetch_package(
            REPOSITORY, REVISION,
            _digest("local-unattested-mlx-0.32.3-mlx-lm-0.32.0"),
            _digest("local-unattested-dependencies-transformers-5.17.0"),
        ) as package:
            if (package.manifest.get("repository") != REPOSITORY or
                    package.manifest.get("revision") != REVISION or
                    verify_package(package.path, package.manifest) != package.identity):
                raise LocalRunError("model package identity differs before inference")
            answer = backend(package.path, prompt)
            if verify_package(package.path, package.manifest) != package.identity:
                raise LocalRunError("model package changed during inference")
            if not isinstance(answer, str) or len(answer) > 4096:
                raise LocalRunError("model output exceeds local limits")
            return {
                "repository": REPOSITORY, "revision": REVISION,
                "packageIdentity": package.identity, "answer": answer,
                "record": make_replay_record(prompt, answer, package.identity),
                "rewardEligible": False, "networkSubmitted": False,
                "independentlyVerified": False,
            }
    except (PackageError, OSError) as error:
        raise LocalRunError("model package could not be verified") from error


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt")
    parser.add_argument("--replay-record", help="rerun a bounded local transcript file")
    parser.add_argument("--check-runtime", action="store_true")
    parser.add_argument("--allow-1.5gb-download", dest="allow_large_download", action="store_true")
    args = parser.parse_args()
    if args.check_runtime:
        if args.prompt is not None or args.replay_record is not None or args.allow_large_download:
            parser.error("runtime check cannot be combined with model execution")
        print(json.dumps(runtime_status()))
        return
    if (args.prompt is None) == (args.replay_record is None):
        parser.error("provide exactly one of --prompt or --replay-record")
    if not args.allow_large_download:
        parser.error("confirm the temporary ~1.5 GB model download with --allow-1.5gb-download")
    _check_runtime()
    if args.replay_record is not None:
        print(json.dumps(replay_record(load_replay_record(args.replay_record)), ensure_ascii=False))
    else:
        print(json.dumps(run_pinned_qwen(args.prompt), ensure_ascii=False))


if __name__ == "__main__":
    main()

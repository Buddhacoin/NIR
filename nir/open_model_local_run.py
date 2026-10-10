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
import sys
from typing import Callable

from nir.open_model_fetch import SUPPORTED_REVISIONS, fetched_curated_model
from nir.open_model_package import PackageError, verify_package


REPOSITORY = "Qwen/Qwen3-0.6B"
REVISION = SUPPORTED_REVISIONS[REPOSITORY]
RUNTIME_VERSIONS = {"mlx": "0.32.3", "mlx-lm": "0.32.0", "transformers": "5.17.0"}


class LocalRunError(ValueError):
    """Local inference could not be completed without violating its limits."""


def _digest(label: str) -> str:
    # These are declarations for package identity, not attestations.
    return "sha256:" + sha256(label.encode("ascii")).hexdigest()


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
    if (not isinstance(prompt, str) or not 1 <= len(prompt) <= 256 or
            prompt != prompt.strip() or any(ord(char) < 32 or ord(char) == 127 for char in prompt)):
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
                "rewardEligible": False, "networkSubmitted": False,
                "independentlyVerified": False,
            }
    except (PackageError, OSError) as error:
        raise LocalRunError("model package could not be verified") from error


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt")
    parser.add_argument("--check-runtime", action="store_true")
    parser.add_argument("--allow-1.5gb-download", dest="allow_large_download", action="store_true")
    args = parser.parse_args()
    if args.check_runtime:
        if args.prompt is not None or args.allow_large_download:
            parser.error("runtime check cannot be combined with model execution")
        print(json.dumps(runtime_status()))
        return
    if args.prompt is None:
        parser.error("--prompt is required for model execution")
    if not args.allow_large_download:
        parser.error("confirm the temporary ~1.5 GB model download with --allow-1.5gb-download")
    _check_runtime()
    print(json.dumps(run_pinned_qwen(args.prompt), ensure_ascii=False))


if __name__ == "__main__":
    main()

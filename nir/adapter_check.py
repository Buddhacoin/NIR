"""Developer-only conformance check for a local NIR application adapter."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from typing import Sequence

from .application_adapter import AdapterError, AdapterTimeout, ApplicationAdapter


FORMAT = "nir-adapter-conformance-check-v1"
DEFAULT_TIMEOUT_MS = 5_000
PUBLIC_CHECK_SEED = hashlib.sha256(b"nir-adapter-check-public-seed-v1").hexdigest()
WARNING = (
    "DEVELOPER ONLY: this runs the exact argv after -- as a local child process. "
    "It is not sandboxed, does not test intelligence, does not mine NIR, and does not touch the chain. "
    "Do not include passwords, tokens, keys, seeds, or other secrets."
)
_SECRET_ARGUMENT = re.compile(
    r"(?:^|[-_])(?:password|passphrase|private[-_]?key|secret|api[-_]?key|token|mnemonic|seed)(?:$|[=_-])",
    re.IGNORECASE,
)
_URL_CREDENTIAL = re.compile(r"://[^/@\s]+:[^/@\s]+@")


class CheckConfigurationError(ValueError):
    """Raised before any adapter process is started."""


def parse_arguments(arguments: Sequence[str]) -> tuple[bool, int, list[str]]:
    values = list(arguments)
    if "--" not in values:
        raise CheckConfigurationError("an exact adapter argv is required after --")
    separator = values.index("--")
    options = values[:separator]
    adapter_argv = values[separator + 1 :]
    json_mode = False
    timeout_ms = DEFAULT_TIMEOUT_MS
    index = 0
    while index < len(options):
        option = options[index]
        if option == "--json":
            if json_mode:
                raise CheckConfigurationError("--json may be specified only once")
            json_mode = True
        elif option == "--timeout-ms":
            index += 1
            if index >= len(options) or not options[index].isascii() or not options[index].isdigit():
                raise CheckConfigurationError("--timeout-ms requires an integer")
            timeout_ms = int(options[index])
            if not 1 <= timeout_ms <= 300_000:
                raise CheckConfigurationError("--timeout-ms must be between 1 and 300000")
        else:
            raise CheckConfigurationError("unknown checker option before --")
        index += 1
    if not adapter_argv:
        raise CheckConfigurationError("adapter argv after -- must not be empty")
    if any(_SECRET_ARGUMENT.search(value) or _URL_CREDENTIAL.search(value) for value in adapter_argv):
        raise CheckConfigurationError("secret-looking adapter arguments are forbidden")
    return json_mode, timeout_ms, adapter_argv


def check_adapter(adapter_argv: Sequence[str], timeout_ms: int) -> dict[str, object]:
    base: dict[str, object] = {
        "argumentCount": len(adapter_argv),
        "chainMutation": False,
        "developerOnly": True,
        "format": FORMAT,
        "miningClaim": False,
        "scope": "transport-handshake-only",
        "timeoutMs": timeout_ms,
        "warning": WARNING,
    }
    try:
        with ApplicationAdapter(list(adapter_argv), startup_timeout_ms=timeout_ms) as adapter:
            description = adapter.describe(PUBLIC_CHECK_SEED)
        return {
            **base,
            "adapter": {
                "capabilities": list(description.capabilities),
                "determinism": description.determinism,
                "maxInputBytes": description.max_input_bytes,
                "modelIdentity": description.model_identity,
                "statePolicy": description.state_policy,
            },
            "ok": True,
        }
    except AdapterTimeout:
        return {**base, "error": "adapter handshake timed out", "ok": False}
    except AdapterError:
        return {**base, "error": "adapter failed transport conformance", "ok": False}


def _human(report: dict[str, object]) -> str:
    lines = [f"NIR local adapter check: {'PASS' if report['ok'] else 'FAIL'}"]
    if report["ok"]:
        adapter = report["adapter"]
        assert isinstance(adapter, dict)
        lines.extend(
            [
                f"Model identity: {adapter['modelIdentity']}",
                f"Capabilities: {', '.join(adapter['capabilities'])}",
                f"Determinism: {adapter['determinism']}",
                f"State policy: {adapter['statePolicy']}",
                f"Maximum input: {adapter['maxInputBytes']} bytes",
                "Result: transport handshake only; no mining eligibility was established.",
            ]
        )
    else:
        lines.append(f"Reason: {report['error']}")
    return "\n".join(lines)


def main(arguments: Sequence[str] | None = None) -> int:
    values = list(sys.argv[1:] if arguments is None else arguments)
    json_requested = "--json" in values[: values.index("--") if "--" in values else len(values)]
    try:
        json_mode, timeout_ms, adapter_argv = parse_arguments(values)
    except CheckConfigurationError as error:
        report = {
            "chainMutation": False,
            "developerOnly": True,
            "error": str(error),
            "format": FORMAT,
            "miningClaim": False,
            "ok": False,
            "scope": "configuration-only",
            "warning": WARNING,
        }
        print(WARNING, file=sys.stderr)
        print(json.dumps(report, indent=2, sort_keys=True) if json_requested else _human(report))
        return 2
    print(WARNING, file=sys.stderr)
    report = check_adapter(adapter_argv, timeout_ms)
    print(json.dumps(report, indent=2, sort_keys=True) if json_mode else _human(report))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())

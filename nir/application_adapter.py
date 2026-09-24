"""Fail-closed child-process transport for local NIR AI applications.

The adapter protocol is deliberately data-only: one UTF-8 JSON object per
line on stdin/stdout.  This module starts an argv vector without a shell and
owns the entire child process group.  It is a transport boundary, not an OS
sandbox; a production evaluator must still place it inside an isolated runner.
"""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import selectors
import select
import signal
import stat
import subprocess
import tempfile
import time
from typing import Any, Mapping, Sequence

from .model import ProtocolError


FORMAT = "nir-application-adapter-v1"
PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 16 * 1024 * 1024
MAX_JSON_DEPTH = 64
MAX_JSON_NODES = 100_000
MAX_ARG_BYTES = 16 * 1024
MAX_ARGS = 128
MAX_TIMEOUT_MS = 300_000
MAX_ENVIRONMENT_VARIABLES = 32
MAX_ENVIRONMENT_BYTES = 32 * 1024
MAX_ID_CHARS = 128
MAX_DIAGNOSTIC_CHARS = 1_024
MAX_MEASURED_ENTRYPOINT_BYTES = 1 << 30

_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_HEX = re.compile(r"^[0-9a-f]{64}$")
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_CAPABILITY = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_ENVIRONMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
_SECRET_ENVIRONMENT_NAME = re.compile(
    r"(?:^|_)(?:password|passphrase|private|secret|token|key|mnemonic|seed)(?:_|$)",
    re.IGNORECASE,
)
_MEDIA_TYPES = frozenset({"application/json", "text/plain"})


class AdapterError(ProtocolError):
    """Raised when the local adapter violates the wire or lifecycle contract."""


class AdapterTimeout(AdapterError):
    """Raised when the application does not return a complete frame in time."""


class AdapterRemoteError(AdapterError):
    """A bounded, structured error returned by the application."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"application adapter error {code}: {message}")
        self.code = code
        self.remote_message = message


@dataclass(frozen=True, slots=True)
class AdapterDescription:
    capabilities: tuple[str, ...]
    determinism: str
    max_input_bytes: int
    model_identity: str
    state_policy: str


@dataclass(frozen=True, slots=True)
class AdapterUsage:
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True, slots=True)
class AdapterResult:
    case_id: str
    media_type: str
    value: Any
    usage: AdapterUsage


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise AdapterError("adapter frame contains a duplicate JSON field")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise AdapterError(f"adapter frame contains forbidden JSON constant {value}")


def _bounded_json(value: Any) -> None:
    nodes = 0

    def visit(item: Any, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > MAX_JSON_NODES:
            raise AdapterError("adapter JSON node count exceeds the protocol limit")
        if depth > MAX_JSON_DEPTH:
            raise AdapterError("adapter JSON nesting exceeds the protocol limit")
        if item is None or isinstance(item, (str, bool, int, float)):
            return
        if isinstance(item, list):
            for child in item:
                visit(child, depth + 1)
            return
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str):
                    raise AdapterError("adapter JSON object keys must be strings")
                visit(child, depth + 1)
            return
        raise AdapterError("adapter payload contains a non-JSON value")

    visit(value, 0)


def _encode_frame(value: object) -> bytes:
    _bounded_json(value)
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError, RecursionError) as error:
        raise AdapterError("adapter request is not bounded canonical JSON") from error
    if not encoded or len(encoded) > MAX_FRAME_BYTES or b"\n" in encoded:
        raise AdapterError("adapter request frame exceeds the protocol limit")
    return encoded + b"\n"


def _decode_frame(frame: bytes) -> dict[str, Any]:
    if not frame or len(frame) > MAX_FRAME_BYTES:
        raise AdapterError("adapter response frame size is outside protocol limits")
    try:
        value = json.loads(
            frame,
            object_pairs_hook=_strict_object,
            parse_constant=_reject_constant,
        )
    except AdapterError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise AdapterError("adapter response is not valid bounded UTF-8 JSON") from error
    _bounded_json(value)
    if not isinstance(value, dict):
        raise AdapterError("adapter response root must be an object")
    return value


def _exact(value: Mapping[str, Any], expected: set[str], context: str) -> None:
    if set(value) != expected:
        raise AdapterError(f"{context} schema contains missing or unknown fields")


def _identifier(value: Any, field: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise AdapterError(f"{field} is invalid")
    return value


def _snapshot_regular_file(path: str | Path, snapshot: str | Path) -> tuple[int, str]:
    """Stream one measured file into an unlinked read-only snapshot."""
    entrypoint = os.fspath(path)
    try:
        if stat.S_ISLNK(os.stat(entrypoint, follow_symlinks=False).st_mode):
            raise AdapterError("measured adapter entrypoint cannot be a symbolic link")
    except AdapterError:
        raise
    except OSError as error:
        raise AdapterError("measured adapter entrypoint cannot be opened") from error
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(entrypoint, flags)
    except OSError as error:
        raise AdapterError("measured adapter entrypoint cannot be opened") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise AdapterError("measured adapter entrypoint must be a regular file")
        if metadata.st_size <= 0 or metadata.st_size > MAX_MEASURED_ENTRYPOINT_BYTES:
            raise AdapterError("measured adapter entrypoint size is outside runner limits")
        digest = sha256()
        total = 0
        snapshot_path = os.fspath(snapshot)
        output = os.open(
            snapshot_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
            0o400,
        )
        try:
            while True:
                chunk = os.read(
                    descriptor,
                    min(1 << 20, MAX_MEASURED_ENTRYPOINT_BYTES + 1 - total),
                )
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_MEASURED_ENTRYPOINT_BYTES:
                    raise AdapterError("measured adapter entrypoint size is outside runner limits")
                digest.update(chunk)
                written = 0
                while written < len(chunk):
                    count = os.write(output, chunk[written:])
                    if count <= 0:
                        raise AdapterError("measured entrypoint snapshot write made no progress")
                    written += count
            if total != metadata.st_size:
                raise AdapterError("measured adapter entrypoint changed while being read")
            os.fsync(output)
        finally:
            os.close(output)
        snapshot_descriptor = os.open(
            snapshot_path, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0),
        )
        os.unlink(snapshot_path)
        return snapshot_descriptor, f"sha256:{digest.hexdigest()}"
    except Exception:
        try:
            os.unlink(os.fspath(snapshot))
        except OSError:
            pass
        raise
    finally:
        os.close(descriptor)


class ApplicationAdapter:
    """Own one local adapter child and exchange strict request/response frames."""

    def __init__(
        self,
        argv: Sequence[str],
        *,
        startup_timeout_ms: int = 30_000,
        environment: Mapping[str, str] | None = None,
        measured_entrypoint: str | Path | None = None,
    ) -> None:
        if (
            not isinstance(argv, (list, tuple))
            or not 1 <= len(argv) <= MAX_ARGS
            or any(
                not isinstance(arg, str)
                or not arg
                or "\x00" in arg
                or len(arg.encode("utf-8")) > MAX_ARG_BYTES
                for arg in argv
            )
        ):
            raise AdapterError("adapter argv is invalid or outside protocol limits")
        self._startup_timeout_ms = self._timeout(startup_timeout_ms)
        self._temporary = tempfile.TemporaryDirectory(prefix="nir-adapter-")
        self._closed = False
        self._buffer = bytearray()
        self._counter = 0
        self._description: AdapterDescription | None = None
        self._measured_entrypoint: str | None = None
        self._measured_entrypoint_digest: str | None = None
        launch_argv = list(argv)
        measured_descriptor: int | None = None
        if measured_entrypoint is not None:
            entrypoint = os.fspath(measured_entrypoint)
            if not isinstance(entrypoint, str) or not entrypoint or not os.path.isabs(entrypoint):
                self._temporary.cleanup()
                raise AdapterError("measured adapter entrypoint must be an absolute path")
            positions = [index for index, argument in enumerate(argv) if argument == entrypoint]
            if not positions:
                self._temporary.cleanup()
                raise AdapterError("measured adapter entrypoint is not present in exact argv")
            if len(positions) != 1 or positions[0] == 0:
                self._temporary.cleanup()
                raise AdapterError(
                    "descriptor-bound entrypoint must be one unique argv argument after the launcher"
                )
            try:
                snapshot = os.path.join(self._temporary.name, "measured-entrypoint")
                measured_descriptor, self._measured_entrypoint_digest = _snapshot_regular_file(
                    entrypoint, snapshot,
                )
                descriptor_path = f"/dev/fd/{measured_descriptor}"
                if not os.path.exists("/dev/fd"):
                    raise AdapterError("descriptor-bound adapter launch is unsupported on this host")
                launch_argv[positions[0]] = descriptor_path
            except Exception:
                if measured_descriptor is not None:
                    os.close(measured_descriptor)
                self._temporary.cleanup()
                raise
            self._measured_entrypoint = entrypoint
        child_environment = {
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PATH": os.defpath,
        }
        if environment is not None:
            if not isinstance(environment, Mapping) or len(environment) > MAX_ENVIRONMENT_VARIABLES:
                self._temporary.cleanup()
                raise AdapterError("adapter environment variable count exceeds the protocol limit")
            environment_bytes = 0
            for key, value in environment.items():
                if (
                    not isinstance(key, str)
                    or not _ENVIRONMENT_NAME.fullmatch(key)
                    or _SECRET_ENVIRONMENT_NAME.search(key)
                    or not isinstance(value, str)
                    or "\x00" in value
                ):
                    self._temporary.cleanup()
                    raise AdapterError("adapter environment name or value is forbidden")
                environment_bytes += len(key.encode("utf-8")) + len(value.encode("utf-8")) + 2
                if environment_bytes > MAX_ENVIRONMENT_BYTES:
                    self._temporary.cleanup()
                    raise AdapterError("adapter environment size exceeds the protocol limit")
                child_environment[key] = value
        try:
            self._process = subprocess.Popen(
                launch_argv,
                cwd=self._temporary.name,
                env=child_environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                shell=False,
                start_new_session=True,
                close_fds=True,
                pass_fds=(() if measured_descriptor is None else (measured_descriptor,)),
                bufsize=0,
            )
        except (OSError, ValueError) as error:
            self._temporary.cleanup()
            raise AdapterError("adapter child process could not be started") from error
        finally:
            if measured_descriptor is not None:
                os.close(measured_descriptor)
        # start_new_session makes the child PID the process-group ID.
        self._process_group = self._process.pid
        if self._process.stdin is None or self._process.stdout is None:
            self.close(force=True)
            raise AdapterError("adapter child process pipes are unavailable")
        try:
            os.set_blocking(self._process.stdin.fileno(), False)
            self._selector = selectors.DefaultSelector()
            self._selector.register(self._process.stdout, selectors.EVENT_READ)
        except Exception as error:
            if hasattr(self, "_selector"):
                try:
                    self._selector.close()
                except Exception:
                    pass
            self.close(force=True)
            raise AdapterError("adapter response selector could not be registered") from error

    @staticmethod
    def _timeout(value: int) -> int:
        if (
            not isinstance(value, int)
            or isinstance(value, bool)
            or not 1 <= value <= MAX_TIMEOUT_MS
        ):
            raise AdapterError("adapter timeout is outside protocol limits")
        return value

    def __enter__(self) -> "ApplicationAdapter":
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()

    @property
    def pid(self) -> int:
        return self._process.pid

    @property
    def working_directory(self) -> Path:
        return Path(self._temporary.name)

    @property
    def measured_entrypoint_digest(self) -> str | None:
        return self._measured_entrypoint_digest

    def verify_entrypoint_measurement(self, expected_digest: str) -> None:
        """Fail unless the descriptor-bound launch snapshot matches its commitment."""
        if not isinstance(expected_digest, str) or not _DIGEST.fullmatch(expected_digest):
            self.close(force=True)
            raise AdapterError("expected adapter entrypoint digest is invalid")
        if self._measured_entrypoint is None or self._measured_entrypoint_digest is None:
            self.close(force=True)
            raise AdapterError("adapter execution lacks a measured entrypoint")
        if self._measured_entrypoint_digest != expected_digest:
            self.close(force=True)
            raise AdapterError("measured adapter entrypoint does not match its commitment")

    def _request_id(self) -> str:
        self._counter += 1
        return f"r-{self._counter}"

    def _write(self, request: dict[str, Any], deadline: float) -> None:
        if self._closed or self._process.poll() is not None:
            raise AdapterError("adapter child process is not running")
        frame = _encode_frame(request)
        descriptor = self._process.stdin.fileno()
        written = 0
        while written < len(frame):
            if self._process.poll() is not None:
                raise AdapterError("adapter child exited while reading a request")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AdapterTimeout("adapter request write deadline expired")
            try:
                _, writable, _ = select.select([], [descriptor], [], remaining)
            except (OSError, ValueError) as error:
                raise AdapterError("adapter input readiness check failed") from error
            if not writable:
                raise AdapterTimeout("adapter request write deadline expired")
            try:
                count = os.write(descriptor, frame[written:])
            except BlockingIOError:
                continue
            except (BrokenPipeError, OSError) as error:
                raise AdapterError("adapter child closed its input") from error
            if count <= 0:
                raise AdapterError("adapter request write made no progress")
            written += count

    def _read(self, deadline: float) -> dict[str, Any]:
        while True:
            newline = self._buffer.find(b"\n")
            if newline >= 0:
                frame = bytes(self._buffer[:newline])
                del self._buffer[: newline + 1]
                return _decode_frame(frame)
            if len(self._buffer) > MAX_FRAME_BYTES:
                raise AdapterError("adapter response frame exceeds the protocol limit")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AdapterTimeout("adapter response deadline expired")
            events = self._selector.select(remaining)
            if not events:
                raise AdapterTimeout("adapter response deadline expired")
            try:
                chunk = os.read(self._process.stdout.fileno(), 64 * 1024)
            except OSError as error:
                raise AdapterError("adapter response could not be read") from error
            if not chunk:
                if self._buffer:
                    raise AdapterError("adapter ended with an incomplete response frame")
                raise AdapterError("adapter child exited before returning a response")
            self._buffer.extend(chunk)

    def _exchange(
        self, method: str, params: dict[str, Any], timeout_ms: int
    ) -> dict[str, Any]:
        request_id = self._request_id()
        request = {
            "format": FORMAT,
            "method": method,
            "params": params,
            "requestId": request_id,
        }
        try:
            deadline = time.monotonic() + timeout_ms / 1000
            self._write(request, deadline)
            response = self._read(deadline)
            if response.get("format") != FORMAT or response.get("requestId") != request_id:
                raise AdapterError("adapter response is bound to another request or format")
            if "result" in response:
                _exact(response, {"format", "requestId", "result"}, "adapter response")
                if not isinstance(response["result"], dict):
                    raise AdapterError("adapter result must be an object")
                return response["result"]
            _exact(response, {"error", "format", "requestId"}, "adapter response")
            error = response["error"]
            if not isinstance(error, dict):
                raise AdapterError("adapter error must be an object")
            _exact(error, {"code", "message"}, "adapter error")
            code = error["code"]
            message = error["message"]
            if (
                not isinstance(code, str)
                or not _ERROR_CODE.fullmatch(code)
                or not isinstance(message, str)
                or not message
                or len(message) > MAX_DIAGNOSTIC_CHARS
            ):
                raise AdapterError("adapter error fields are invalid")
            raise AdapterRemoteError(code, message)
        except Exception:
            self.close(force=True)
            raise

    def describe(self, challenge_seed: str) -> AdapterDescription:
        if self._description is not None:
            raise AdapterError("adapter handshake may only be performed once")
        if not isinstance(challenge_seed, str) or not _HEX.fullmatch(challenge_seed):
            raise AdapterError("adapter challenge seed is invalid")
        try:
            result = self._exchange(
                "describe",
                {"challengeSeed": challenge_seed, "protocolVersion": PROTOCOL_VERSION},
                self._startup_timeout_ms,
            )
            _exact(
                result,
                {"capabilities", "determinism", "maxInputBytes", "modelIdentity", "statePolicy"},
                "describe result",
            )
            capabilities = result["capabilities"]
            if (
                not isinstance(capabilities, list)
                or not capabilities
                or len(capabilities) > 64
                or any(not isinstance(item, str) or not _CAPABILITY.fullmatch(item) for item in capabilities)
                or capabilities != sorted(set(capabilities))
            ):
                raise AdapterError("adapter capabilities must be sorted and unique")
            if result["determinism"] not in {"deterministic", "seeded", "nondeterministic"}:
                raise AdapterError("adapter determinism mode is invalid")
            maximum = result["maxInputBytes"]
            if (
                not isinstance(maximum, int)
                or isinstance(maximum, bool)
                or not 1 <= maximum <= MAX_FRAME_BYTES
            ):
                raise AdapterError("adapter maximum input size is invalid")
            if not isinstance(result["modelIdentity"], str) or not _DIGEST.fullmatch(result["modelIdentity"]):
                raise AdapterError("adapter model identity is invalid")
            if result["statePolicy"] not in {"reset-per-case", "reset-per-run"}:
                raise AdapterError("adapter state policy is invalid")
            description = AdapterDescription(
                capabilities=tuple(capabilities),
                determinism=result["determinism"],
                max_input_bytes=maximum,
                model_identity=result["modelIdentity"],
                state_policy=result["statePolicy"],
            )
            self._description = description
            return description
        except Exception:
            self.close(force=True)
            raise

    def evaluate(
        self,
        *,
        case_id: str,
        input_media_type: str,
        input_value: Any,
        seed: str,
        timeout_ms: int,
        tool_policy: str = "none",
    ) -> AdapterResult:
        if self._description is None:
            raise AdapterError("adapter handshake is required before evaluation")
        case_id = _identifier(case_id, "case id")
        if input_media_type not in _MEDIA_TYPES:
            raise AdapterError("adapter input media type is unsupported")
        if input_media_type == "text/plain" and not isinstance(input_value, str):
            raise AdapterError("text input must be a string")
        if tool_policy != "none":
            raise AdapterError("this adapter version permits only the none tool policy")
        if not isinstance(seed, str) or not _HEX.fullmatch(seed):
            raise AdapterError("adapter case seed is invalid")
        timeout_ms = self._timeout(timeout_ms)
        encoded_input = _encode_frame(input_value)
        if len(encoded_input) - 1 > self._description.max_input_bytes:
            raise AdapterError("adapter input exceeds the declared application limit")
        try:
            result = self._exchange(
                "evaluate",
                {
                    "caseId": case_id,
                    "input": {"mediaType": input_media_type, "value": input_value},
                    "seed": seed,
                    "timeoutMs": timeout_ms,
                    "toolPolicy": tool_policy,
                },
                timeout_ms,
            )
            _exact(result, {"caseId", "output", "usage"}, "evaluate result")
            if result["caseId"] != case_id:
                raise AdapterError("adapter result belongs to another case")
            output = result["output"]
            usage = result["usage"]
            if not isinstance(output, dict) or not isinstance(usage, dict):
                raise AdapterError("adapter output and usage must be objects")
            _exact(output, {"mediaType", "value"}, "adapter output")
            _exact(usage, {"inputTokens", "outputTokens"}, "adapter usage")
            if output["mediaType"] not in _MEDIA_TYPES:
                raise AdapterError("adapter output media type is unsupported")
            if output["mediaType"] == "text/plain" and not isinstance(output["value"], str):
                raise AdapterError("text output must be a string")
            _bounded_json(output["value"])
            for field in ("inputTokens", "outputTokens"):
                if (
                    not isinstance(usage[field], int)
                    or isinstance(usage[field], bool)
                    or not 0 <= usage[field] <= 10**12
                ):
                    raise AdapterError("adapter token usage is invalid")
            return AdapterResult(
                case_id=case_id,
                media_type=output["mediaType"],
                value=output["value"],
                usage=AdapterUsage(usage["inputTokens"], usage["outputTokens"]),
            )
        except Exception:
            self.close(force=True)
            raise

    def close(self, *, force: bool = False) -> None:
        if getattr(self, "_closed", True):
            return
        self._closed = True
        process = self._process
        try:
            self._selector.close()
        except Exception:
            pass
        try:
            if process.stdin is not None:
                process.stdin.close()
        except OSError:
            pass
        grace = 0 if force else 0.2
        try:
            process.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            pass
        # Signal the owned group even when the leader exited after stdin closed:
        # an adapter must not leave forked descendants behind.
        try:
            os.killpg(self._process_group, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            pass
        group_deadline = time.monotonic() + 0.5
        while time.monotonic() < group_deadline:
            try:
                os.killpg(self._process_group, 0)
            except ProcessLookupError:
                break
            time.sleep(0.01)
        try:
            os.killpg(self._process_group, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired as error:
            raise AdapterError("adapter process group could not be reaped") from error
        finally:
            if process.stdout is not None:
                process.stdout.close()
            self._temporary.cleanup()

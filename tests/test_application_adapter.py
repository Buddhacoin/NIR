import json
import os
from pathlib import Path
import sys
import tempfile
import textwrap
import time
import unittest
from unittest.mock import patch

from nir.application_adapter import (
    AdapterError,
    AdapterRemoteError,
    AdapterTimeout,
    ApplicationAdapter,
    MAX_FRAME_BYTES,
)


SEED = "a" * 64
IDENTITY = f"sha256:{'b' * 64}"


def child_source(mode: str) -> str:
    common = f'''\
import json
import os
import sys
import time

FORMAT = "nir-application-adapter-v1"
IDENTITY = "{IDENTITY}"

for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "describe":
        response = {{
            "format": FORMAT,
            "requestId": request["requestId"],
            "result": {{
                "capabilities": ["text"],
                "determinism": "seeded",
                "maxInputBytes": 1048576,
                "modelIdentity": IDENTITY,
                "statePolicy": "reset-per-case"
            }}
        }}
    else:
        response = {{
            "format": FORMAT,
            "requestId": request["requestId"],
            "result": {{
                "caseId": request["params"]["caseId"],
                "output": {{"mediaType": "text/plain", "value": "42"}},
                "usage": {{"inputTokens": 3, "outputTokens": 1}}
            }}
        }}
'''
    endings = {
        "normal": '    print(json.dumps(response, separators=(",", ":")), flush=True)\n',
        "timeout": '''\
    if request["method"] == "evaluate":
        time.sleep(10)
    print(json.dumps(response), flush=True)
''',
        "unknown": '''\
    if request["method"] == "describe":
        response["result"]["unexpected"] = True
    print(json.dumps(response), flush=True)
''',
        "wrong_id": '''\
    response["requestId"] = "other"
    print(json.dumps(response), flush=True)
''',
        "remote_error": '''\
    if request["method"] == "evaluate":
        response = {"format": FORMAT, "requestId": request["requestId"],
                    "error": {"code": "TIMEOUT", "message": "model deadline"}}
    print(json.dumps(response), flush=True)
''',
        "oversize": f'''\
    if request["method"] == "describe":
        sys.stdout.write("x" * ({MAX_FRAME_BYTES} + 1))
        sys.stdout.flush()
    else:
        print(json.dumps(response), flush=True)
''',
        "fork": '''\
    if request["method"] == "describe":
        child = os.fork()
        if child == 0:
            time.sleep(30)
            os._exit(0)
        response["result"]["modelIdentity"] = IDENTITY
        response["result"]["maxInputBytes"] = 1048576
        response["result"]["capabilities"] = ["text"]
        response["result"]["determinism"] = "seeded"
        response["result"]["statePolicy"] = "reset-per-case"
        response["result"]["childPid"] = child
    print(json.dumps(response), flush=True)
''',
    }
    return common + endings[mode]


class ApplicationAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp.cleanup()

    def command(self, mode="normal"):
        path = Path(self.temp.name) / f"adapter-{mode}.py"
        path.write_text(textwrap.dedent(child_source(mode)), encoding="utf-8")
        return [sys.executable, "-I", str(path)]

    def test_handshake_and_evaluation(self):
        with ApplicationAdapter(self.command()) as adapter:
            description = adapter.describe(SEED)
            self.assertEqual(description.model_identity, IDENTITY)
            self.assertEqual(description.capabilities, ("text",))
            result = adapter.evaluate(
                case_id="opaque-7f3a",
                input_media_type="application/json",
                input_value={"messages": [{"role": "user", "content": "6 * 7"}]},
                seed="c" * 64,
                timeout_ms=1_000,
            )
            self.assertEqual(result.value, "42")
            self.assertEqual(result.usage.output_tokens, 1)
            work = adapter.working_directory
        self.assertFalse(work.exists())

    def test_handshake_is_required_and_may_not_repeat(self):
        with ApplicationAdapter(self.command()) as adapter:
            with self.assertRaisesRegex(AdapterError, "handshake is required"):
                adapter.evaluate(
                    case_id="case", input_media_type="text/plain", input_value="x",
                    seed=SEED, timeout_ms=100,
                )
        with ApplicationAdapter(self.command()) as adapter:
            adapter.describe(SEED)
            with self.assertRaisesRegex(AdapterError, "only be performed once"):
                adapter.describe(SEED)

    def test_unknown_fields_and_wrong_request_binding_fail_closed(self):
        for mode in ("unknown", "wrong_id"):
            with self.subTest(mode=mode):
                adapter = ApplicationAdapter(self.command(mode))
                pid = adapter.pid
                with self.assertRaises(AdapterError):
                    adapter.describe(SEED)
                self.assertIsNotNone(adapter._process.poll())
                with self.assertRaises(OSError):
                    os.kill(pid, 0)

    def test_timeout_terminates_process_group_and_cleans_directory(self):
        adapter = ApplicationAdapter(self.command("timeout"))
        adapter.describe(SEED)
        pid = adapter.pid
        work = adapter.working_directory
        with self.assertRaises(AdapterTimeout):
            adapter.evaluate(
                case_id="case", input_media_type="text/plain", input_value="x",
                seed=SEED, timeout_ms=20,
            )
        self.assertIsNotNone(adapter._process.poll())
        self.assertFalse(work.exists())
        with self.assertRaises(OSError):
            os.kill(pid, 0)

    def test_child_that_stops_reading_cannot_block_request_write(self):
        script = Path(self.temp.name) / "non-reading-adapter.py"
        script.write_text(textwrap.dedent(f'''\
            import json
            import sys
            import time

            request = json.loads(sys.stdin.readline())
            print(json.dumps({{
                "format": "nir-application-adapter-v1",
                "requestId": request["requestId"],
                "result": {{
                    "capabilities": ["text"],
                    "determinism": "seeded",
                    "maxInputBytes": {MAX_FRAME_BYTES},
                    "modelIdentity": {IDENTITY!r},
                    "statePolicy": "reset-per-case"
                }}
            }}), flush=True)
            time.sleep(30)
            '''), encoding="utf-8")
        adapter = ApplicationAdapter([sys.executable, "-I", str(script)])
        adapter.describe(SEED)
        started = time.monotonic()
        with self.assertRaisesRegex(AdapterTimeout, "write deadline"):
            adapter.evaluate(
                case_id="case", input_media_type="text/plain",
                input_value="x" * (4 * 1024 * 1024), seed=SEED, timeout_ms=20,
            )
        self.assertLess(time.monotonic() - started, 2)
        self.assertIsNotNone(adapter._process.poll())

    def test_oversized_incomplete_frame_fails_closed(self):
        adapter = ApplicationAdapter(self.command("oversize"), startup_timeout_ms=2_000)
        with self.assertRaisesRegex(AdapterError, "exceeds"):
            adapter.describe(SEED)
        self.assertIsNotNone(adapter._process.poll())

    def test_remote_error_is_structured_and_terminal(self):
        adapter = ApplicationAdapter(self.command("remote_error"))
        adapter.describe(SEED)
        with self.assertRaises(AdapterRemoteError) as caught:
            adapter.evaluate(
                case_id="case", input_media_type="text/plain", input_value="x",
                seed=SEED, timeout_ms=1_000,
            )
        self.assertEqual(caught.exception.code, "TIMEOUT")
        self.assertIsNotNone(adapter._process.poll())

    def test_limits_and_schema_are_checked_before_writing(self):
        with self.assertRaises(AdapterError):
            ApplicationAdapter("not-an-argv-vector")
        with ApplicationAdapter(self.command()) as adapter:
            adapter.describe(SEED)
            with self.assertRaises(AdapterError):
                adapter.evaluate(
                    case_id="bad id", input_media_type="text/plain", input_value="x",
                    seed=SEED, timeout_ms=1_000,
                )
        with ApplicationAdapter(self.command()) as adapter:
            adapter.describe(SEED)
            with self.assertRaisesRegex(AdapterError, "declared application limit"):
                adapter.evaluate(
                    case_id="case", input_media_type="text/plain",
                    input_value="x" * 1_048_577, seed=SEED, timeout_ms=1_000,
                )

    def test_environment_rejects_secrets_count_and_total_size(self):
        for name in (
            "PASSWORD", "db_passphrase", "MODEL_PRIVATE_KEY", "client_secret",
            "API_TOKEN", "signing_key", "wallet_mnemonic", "challenge_seed",
        ):
            with self.subTest(name=name):
                with self.assertRaisesRegex(AdapterError, "forbidden"):
                    ApplicationAdapter(self.command(), environment={name: "value"})
        with self.assertRaisesRegex(AdapterError, "count"):
            ApplicationAdapter(
                self.command(), environment={f"SAFE_{index}": "x" for index in range(33)},
            )
        with self.assertRaisesRegex(AdapterError, "size"):
            ApplicationAdapter(
                self.command(), environment={"SAFE_SETTING": "x" * (33 * 1024)},
            )
        with ApplicationAdapter(
            self.command(), environment={"NIR_ADAPTER_MODE": "evaluation"},
        ) as adapter:
            adapter.describe(SEED)

    def test_selector_registration_failure_reaps_started_child(self):
        created = []
        real_popen = __import__("subprocess").Popen

        def record_process(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            created.append(process)
            return process

        class BrokenSelector:
            def register(self, *_args, **_kwargs):
                raise OSError("injected selector failure")

            def close(self):
                pass

        with patch("nir.application_adapter.subprocess.Popen", side_effect=record_process), patch(
            "nir.application_adapter.selectors.DefaultSelector", return_value=BrokenSelector(),
        ):
            with self.assertRaisesRegex(AdapterError, "selector"):
                ApplicationAdapter(self.command("timeout"))
        self.assertEqual(len(created), 1)
        self.assertIsNotNone(created[0].poll())

    def test_argv_is_not_interpreted_by_a_shell(self):
        marker = Path(self.temp.name) / "shell-expanded"
        argument = f"$(touch {marker})"
        script = Path(self.temp.name) / "argv.py"
        script.write_text(
            "import sys\nassert sys.argv[1].startswith('$(touch ')\n",
            encoding="utf-8",
        )
        with ApplicationAdapter([sys.executable, "-I", str(script), argument]):
            pass
        self.assertFalse(marker.exists())

    @unittest.skipUnless(hasattr(os, "fork"), "requires POSIX process groups")
    def test_close_signals_descendants_after_the_leader_exits(self):
        marker = Path(self.temp.name) / "descendant-terminated"
        script = Path(self.temp.name) / "forking-adapter.py"
        script.write_text(textwrap.dedent(f'''\
            import json
            import os
            import signal
            import sys

            marker = {str(marker)!r}
            for line in sys.stdin:
                request = json.loads(line)
                child = os.fork()
                if child == 0:
                    def terminate(_signal, _frame):
                        with open(marker, "w", encoding="utf-8") as output:
                            output.write("terminated")
                        os._exit(0)
                    signal.signal(signal.SIGTERM, terminate)
                    while True:
                        signal.pause()
                response = {{
                    "format": "nir-application-adapter-v1",
                    "requestId": request["requestId"],
                    "result": {{
                        "capabilities": ["text"],
                        "determinism": "seeded",
                        "maxInputBytes": 1024,
                        "modelIdentity": {IDENTITY!r},
                        "statePolicy": "reset-per-case"
                    }}
                }}
                print(json.dumps(response), flush=True)
            '''), encoding="utf-8")
        with ApplicationAdapter([sys.executable, "-I", str(script)]) as adapter:
            adapter.describe(SEED)
        self.assertEqual(marker.read_text(encoding="utf-8"), "terminated")


if __name__ == "__main__":
    unittest.main()

import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import textwrap
import unittest

from nir.adapter_check import CheckConfigurationError, main, parse_arguments


IDENTITY = f"sha256:{'c' * 64}"


def adapter_source(*, delay: float = 0) -> str:
    return textwrap.dedent(f'''\
        import json
        import sys
        import time

        time.sleep({delay!r})
        request = json.loads(sys.stdin.readline())
        print(json.dumps({{
            "format": "nir-application-adapter-v1",
            "requestId": request["requestId"],
            "result": {{
                "capabilities": ["text"],
                "determinism": "seeded",
                "maxInputBytes": 4096,
                "modelIdentity": {IDENTITY!r},
                "statePolicy": "reset-per-case"
            }}
        }}), flush=True)
    ''')


class AdapterCheckTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temporary.cleanup()

    def adapter(self, *, delay: float = 0) -> list[str]:
        path = Path(self.temporary.name) / "adapter.py"
        path.write_text(adapter_source(delay=delay), encoding="utf-8")
        return [sys.executable, "-I", str(path)]

    def run_cli(self, arguments):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = main(arguments)
        return status, stdout.getvalue(), stderr.getvalue()

    def test_exact_argv_must_follow_separator(self):
        with self.assertRaisesRegex(CheckConfigurationError, "after --"):
            parse_arguments([sys.executable])
        with self.assertRaisesRegex(CheckConfigurationError, "must not be empty"):
            parse_arguments(["--"])
        json_mode, timeout, argv = parse_arguments(
            ["--json", "--timeout-ms", "1234", "--", "adapter", "--json", "literal value"]
        )
        self.assertTrue(json_mode)
        self.assertEqual(timeout, 1234)
        self.assertEqual(argv, ["adapter", "--json", "literal value"])

    def test_json_handshake_is_explicitly_non_mining_and_secret_free(self):
        status, stdout, stderr = self.run_cli(["--json", "--", *self.adapter()])
        report = json.loads(stdout)
        self.assertEqual(status, 0)
        self.assertTrue(report["ok"])
        self.assertEqual(report["adapter"]["modelIdentity"], IDENTITY)
        self.assertEqual(report["scope"], "transport-handshake-only")
        self.assertFalse(report["miningClaim"])
        self.assertFalse(report["chainMutation"])
        self.assertNotIn(str(self.adapter()[-1]), stdout)
        self.assertIn("not sandboxed", stderr)

    def test_timeout_fails_closed_without_echoing_argv(self):
        argv = self.adapter(delay=2)
        status, stdout, _stderr = self.run_cli(
            ["--json", "--timeout-ms", "20", "--", *argv]
        )
        report = json.loads(stdout)
        self.assertEqual(status, 2)
        self.assertFalse(report["ok"])
        self.assertEqual(report["error"], "adapter handshake timed out")
        self.assertNotIn(argv[-1], stdout)

    def test_secret_looking_arguments_are_rejected_before_process_start(self):
        marker = Path(self.temporary.name) / "started"
        child = Path(self.temporary.name) / "marker.py"
        child.write_text(f"from pathlib import Path\nPath({str(marker)!r}).write_text('x')\n")
        status, stdout, _stderr = self.run_cli(
            ["--json", "--", sys.executable, str(child), "--api-token=do-not-log"]
        )
        self.assertEqual(status, 2)
        self.assertFalse(marker.exists())
        self.assertNotIn("do-not-log", stdout)
        self.assertIn("secret-looking", json.loads(stdout)["error"])

    def test_shell_metacharacters_remain_literal(self):
        marker = Path(self.temporary.name) / "shell-expanded"
        argv = self.adapter() + [f"$(touch {marker})"]
        status, _stdout, _stderr = self.run_cli(["--", *argv])
        self.assertEqual(status, 0)
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()

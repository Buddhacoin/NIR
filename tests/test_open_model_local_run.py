"""A real runner boundary with injected packages/backends; no network in tests."""

from contextlib import contextmanager
from hashlib import sha256
from importlib.metadata import PackageNotFoundError
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from nir.open_model_fetch import FetchedPackage
from nir.open_model_package import FORMAT, verify_package
from nir.open_model_local_run import (LocalRunError, _mlx_backend, load_replay_record,
                                      make_replay_record, replay_record, run_pinned_qwen, runtime_status,
                                      validate_replay_record)


REPO = "Qwen/Qwen3-0.6B"
REV = "c1899de289a04d12100db370d81485cdf75e47ca"


class LocalRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.weight = self.root / "model.safetensors"
        self.weight.write_bytes(b"model-weights")
        self.manifest = {
            "format": FORMAT, "repository": REPO, "revision": REV,
            "runtimeDigest": "sha256:" + "1" * 64,
            "dependencyDigest": "sha256:" + "2" * 64,
            "files": [{"path": self.weight.name, "size": self.weight.stat().st_size,
                       "sha256": "sha256:" + sha256(self.weight.read_bytes()).hexdigest()}],
        }
        self.identity = verify_package(self.root, self.manifest)
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    @contextmanager
    def package(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        yield FetchedPackage(self.root, self.manifest, self.identity)

    def test_local_answer_is_explicitly_non_reward(self):
        result = run_pinned_qwen("Say NIR", fetch_package=self.package,
                                 backend=lambda path, prompt: "NIR")
        self.assertEqual(result["answer"], "NIR")
        self.assertEqual(result["packageIdentity"], self.identity)
        self.assertEqual(result["record"]["prompt"], "Say NIR")
        self.assertEqual(result["record"]["answer"], "NIR")
        self.assertEqual(result["record"]["scope"], "non-reward-local-replay")
        self.assertRegex(result["record"]["recordHash"], r"^sha256:[0-9a-f]{64}$")
        self.assertFalse(result["rewardEligible"])
        self.assertFalse(result["networkSubmitted"])
        self.assertEqual(self.calls[0][0][:2], (REPO, REV))

    def test_invalid_prompts_fail_before_download(self):
        for prompt in ("", " ", "x" * 257, "a\x00b", "a\nb"):
            with self.subTest(prompt=prompt[:10]), self.assertRaises(LocalRunError):
                run_pinned_qwen(prompt, fetch_package=self.package,
                                backend=lambda path, text: "NIR")
        self.assertEqual(self.calls, [])

    def test_replay_record_reruns_and_never_claims_independent_verification(self):
        original = run_pinned_qwen("Say NIR", fetch_package=self.package,
                                   backend=lambda path, prompt: "NIR")
        checked = validate_replay_record(original["record"])
        self.assertEqual(checked, original["record"])
        replay = replay_record(checked, fetch_package=self.package,
                               backend=lambda path, prompt: "NIR")
        self.assertEqual(replay["status"], "local-replay-matched")
        self.assertEqual(replay["recordHash"], checked["recordHash"])
        self.assertFalse(replay["rewardEligible"])
        self.assertFalse(replay["independentlyVerified"])
        self.assertEqual(len(self.calls), 2)

    def test_cross_language_replay_hash_vector(self):
        record = make_replay_record("Reply with the single word NIR.", "NIR",
                                    "sha256:" + "a" * 64)
        self.assertEqual(record["recordHash"],
                         "sha256:866768567ad82a3bce80ea074f2612215f31f237aa04c9a2ed8cb118453dbe54")
        unicode_record = make_replay_record("Reply with the single word NIR.", "Ответ: ✓",
                                            "sha256:" + "a" * 64)
        self.assertEqual(unicode_record["recordHash"],
                         "sha256:b06751692ce4d1ac5460ed3f6526b0d10b5b0eb8a2d4b2068a211d2ac19252e6")

    def test_replay_rejects_mutation_and_mismatched_execution(self):
        record = run_pinned_qwen("Say NIR", fetch_package=self.package,
                                 backend=lambda path, prompt: "NIR")["record"]
        for field, value in (("answer", "FAKE"), ("prompt", "Different prompt"),
                             ("rewardEligible", True), ("rewardEligible", 0),
                             ("independentlyVerified", True),
                             ("packageIdentity", "sha256:" + "0" * 64)):
            with self.subTest(field=field, value=value), self.assertRaises(LocalRunError):
                validate_replay_record({**record, field: value})
        with self.assertRaises(LocalRunError):
            validate_replay_record({**record, "extra": "ignored?"})
        with self.assertRaises(LocalRunError):
            replay_record(record, fetch_package=self.package,
                          backend=lambda path, prompt: "DIFFERENT")

    def test_replay_file_rejects_links_duplicate_keys_fifo_and_oversize(self):
        record = run_pinned_qwen("Say NIR", fetch_package=self.package,
                                 backend=lambda path, prompt: "NIR")["record"]
        path = self.root / "record.json"
        path.write_text(json.dumps(record), encoding="utf-8")
        self.assertEqual(load_replay_record(path), record)
        link = self.root / "record-link.json"
        link.symlink_to(path)
        with self.assertRaises(OSError):
            load_replay_record(link)
        path.write_text('{"format":"a","format":"b"}', encoding="utf-8")
        with self.assertRaises(LocalRunError):
            load_replay_record(path)
        path.write_bytes(b"x" * 16_385)
        with self.assertRaises(LocalRunError):
            load_replay_record(path)
        fifo = self.root / "record.fifo"
        import os
        os.mkfifo(fifo)
        with self.assertRaises(LocalRunError):
            load_replay_record(fifo)

    def test_modified_package_rejected_before_or_after_execution(self):
        self.weight.write_bytes(b"changed-weights")
        with self.assertRaises(LocalRunError):
            run_pinned_qwen("Say NIR", fetch_package=self.package,
                            backend=lambda path, prompt: "NIR")
        self.weight.write_bytes(b"model-weights")
        def mutate(path, prompt):
            self.weight.write_bytes(b"changed-weights")
            return "NIR"
        with self.assertRaises(LocalRunError):
            run_pinned_qwen("Say NIR", fetch_package=self.package, backend=mutate)

    def test_missing_runtime_rejected_before_download(self):
        with patch("nir.open_model_local_run.version", side_effect=PackageNotFoundError("mlx")):
            with self.assertRaises(LocalRunError):
                run_pinned_qwen("Say NIR", fetch_package=self.package, backend=_mlx_backend)
        self.assertEqual(self.calls, [])

    def test_runtime_preflight_is_read_only_and_reports_actionable_reason(self):
        with patch("nir.open_model_local_run.platform.system", return_value="Darwin"), \
             patch("nir.open_model_local_run.platform.machine", return_value="arm64"), \
             patch("nir.open_model_local_run.sys.version_info", (3, 13)), \
             patch("nir.open_model_local_run.version", side_effect=PackageNotFoundError("mlx")):
            self.assertEqual(runtime_status(), {"status": "missing-runtime", "package": "mlx"})
        self.assertEqual(self.calls, [])

    def test_runtime_preflight_rejects_unsupported_host_and_version(self):
        with patch("nir.open_model_local_run.platform.system", return_value="Linux"):
            self.assertEqual(runtime_status()["status"], "unsupported-machine")
        with patch("nir.open_model_local_run.platform.system", return_value="Darwin"), \
             patch("nir.open_model_local_run.platform.machine", return_value="arm64"), \
             patch("nir.open_model_local_run.sys.version_info", (3, 14)):
            self.assertEqual(runtime_status()["status"], "python-3.13-required")


if __name__ == "__main__":
    unittest.main()

"""A real runner boundary with injected packages/backends; no network in tests."""

from contextlib import contextmanager
from hashlib import sha256
from importlib.metadata import PackageNotFoundError
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from nir.open_model_fetch import FetchedPackage
from nir.open_model_package import FORMAT, verify_package
from nir.open_model_local_run import LocalRunError, _mlx_backend, run_pinned_qwen, runtime_status


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
        self.assertFalse(result["rewardEligible"])
        self.assertFalse(result["networkSubmitted"])
        self.assertEqual(self.calls[0][0][:2], (REPO, REV))

    def test_invalid_prompts_fail_before_download(self):
        for prompt in ("", " ", "x" * 257, "a\x00b", "a\nb"):
            with self.subTest(prompt=prompt[:10]), self.assertRaises(LocalRunError):
                run_pinned_qwen(prompt, fetch_package=self.package,
                                backend=lambda path, text: "NIR")
        self.assertEqual(self.calls, [])

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

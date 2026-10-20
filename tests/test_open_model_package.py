from hashlib import sha256
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from nir.open_model_package import PackageError, verify_package
from nir import open_model_package


def digest(data: bytes) -> str:
    return f"sha256:{sha256(data).hexdigest()}"


class OpenModelPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        # macOS /var is a symlink to /private/var; the verifier requires an
        # actual absolute path with no symlink in any directory component.
        self.root = Path(self.temporary.name).resolve() / "model"
        (self.root / "weights").mkdir(parents=True)
        (self.root / "weights" / "model.safetensors").write_bytes(b"weights-v1")
        (self.root / "tokenizer.json").write_bytes(b'{"tokens":[]}')
        (self.root / "config.json").write_bytes(b'{"hidden_size":16}')
        self.manifest = {
            "format": "nir-open-model-package-v2",
            "repository": "Qwen/Qwen3-0.6B",
            "revision": "a" * 40,
            "runtimeDigest": digest(b"runtime-image"),
            "dependencyDigest": digest(b"dependency-lock"),
            "files": [
                {"path": path, "size": (self.root / path).stat().st_size,
                 "sha256": digest((self.root / path).read_bytes())}
                for path in ("config.json", "tokenizer.json", "weights/model.safetensors")
            ],
        }

    def tearDown(self):
        self.temporary.cleanup()

    def test_valid_package_binds_file_and_runtime_identity(self):
        first = verify_package(self.root, self.manifest)
        self.assertRegex(first, r"^sha256:[0-9a-f]{64}$")
        changed = {**self.manifest, "runtimeDigest": digest(b"different-runtime")}
        self.assertNotEqual(first, verify_package(self.root, changed))
        changed = {**self.manifest, "revision": "b" * 40}
        self.assertNotEqual(first, verify_package(self.root, changed))

    def test_changed_weights_or_tokenizer_fails_closed(self):
        for name in ("weights/model.safetensors", "tokenizer.json", "config.json"):
            path = self.root / name
            original = path.read_bytes()
            path.write_bytes(b"x" * len(original))
            with self.subTest(name=name), self.assertRaises(PackageError):
                verify_package(self.root, self.manifest)
            path.write_bytes(original)

    def test_extra_file_added_during_measurement_fails_closed(self):
        original_measure = open_model_package._measure
        injected = False

        def measure_then_add(root, name, size):
            nonlocal injected
            measured = original_measure(root, name, size)
            if not injected:
                injected = True
                (self.root / "evil.bin").write_bytes(b"late")
            return measured

        with patch("nir.open_model_package._measure", side_effect=measure_then_add):
            with self.assertRaises(PackageError):
                verify_package(self.root, self.manifest)

    def test_extra_missing_or_size_mismatch_fails_closed(self):
        (self.root / "empty-extra-directory").mkdir()
        with self.assertRaises(PackageError):
            verify_package(self.root, self.manifest)
        (self.root / "empty-extra-directory").rmdir()
        extra = self.root / "unexpected.bin"
        extra.write_bytes(b"x")
        with self.assertRaises(PackageError):
            verify_package(self.root, self.manifest)
        extra.unlink()
        (self.root / "config.json").unlink()
        with self.assertRaises(PackageError):
            verify_package(self.root, self.manifest)
        (self.root / "config.json").write_bytes(b'{"hidden_size":16}')
        bad = {**self.manifest, "files": [dict(item) for item in self.manifest["files"]]}
        bad["files"][0]["size"] += 1
        with self.assertRaises(PackageError):
            verify_package(self.root, bad)

    def test_deep_paths_and_hosts_without_nofollow_fail_closed(self):
        bad = {**self.manifest, "files": [dict(item) for item in self.manifest["files"]]}
        bad["files"][0]["path"] = "a/" * 32 + "file"
        with self.assertRaises(PackageError):
            verify_package(self.root, bad)
        with patch("nir.open_model_package.os.O_NOFOLLOW", 0):
            with self.assertRaises(PackageError):
                verify_package(self.root, self.manifest)
        try:
            bad_name = os.fsencode(self.root) + b"/\xff"
            descriptor = os.open(bad_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except (OSError, TypeError):
            pass  # Some hosts cannot create undecodable path bytes.
        else:
            os.close(descriptor)
            with self.assertRaises(PackageError):
                verify_package(self.root, self.manifest)
            os.unlink(bad_name)

    def test_traversal_duplicate_and_unordered_manifest_fails_closed(self):
        for path in ("../escape", "/tmp/escape", "weights/../config.json", "weights//x", "./config.json"):
            bad = {**self.manifest, "files": [dict(item) for item in self.manifest["files"]]}
            bad["files"][0]["path"] = path
            with self.subTest(path=path), self.assertRaises(PackageError):
                verify_package(self.root, bad)
        bad = {**self.manifest, "files": self.manifest["files"] * 2}
        with self.assertRaises(PackageError):
            verify_package(self.root, bad)
        bad = {**self.manifest, "files": list(reversed(self.manifest["files"]))}
        with self.assertRaises(PackageError):
            verify_package(self.root, bad)

    def test_symlinked_file_directory_and_root_fail_closed(self):
        target = self.root / "config.json"
        target.unlink()
        target.symlink_to("tokenizer.json")
        with self.assertRaises(PackageError):
            verify_package(self.root, self.manifest)
        target.unlink()
        target.write_bytes(b'{"hidden_size":16}')
        alias = self.root.parent / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(PackageError):
            verify_package(alias, self.manifest)
        (self.root / "weights" / "model.safetensors").unlink()
        (self.root / "weights").rmdir()
        (self.root / "weights").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(PackageError):
            verify_package(self.root, self.manifest)

    def test_hardlink_and_invalid_metadata_fail_closed(self):
        other = self.root.parent / "other"
        os.link(self.root / "tokenizer.json", other)
        with self.assertRaises(PackageError):
            verify_package(self.root, self.manifest)
        other.unlink()
        for field, value in (("revision", "main"), ("runtimeDigest", "not-a-digest"),
                             ("repository", "../../bad")):
            with self.subTest(field=field), self.assertRaises(PackageError):
                verify_package(self.root, {**self.manifest, field: value})


if __name__ == "__main__":
    unittest.main()

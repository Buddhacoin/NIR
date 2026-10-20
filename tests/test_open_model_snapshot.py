"""Byte-preserving local snapshots, not sandbox or reward-eligible execution."""

from hashlib import sha256
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from nir.open_model_package import verify_package
from nir.open_model_snapshot import SnapshotError, verified_snapshot


REVISION = "a" * 40
REQUIRED = {
    "config.json": b'{"model_type":"qwen3"}',
    "generation_config.json": b"{}",
    "LICENSE": b"Apache-2.0",
    "merges.txt": b"#version: 0.2\n",
    "model.safetensors": b"model-weights-A",
    "tokenizer.json": b"{}",
    "tokenizer_config.json": b"{}",
    "vocab.json": b"{}",
}


def digest(data):
    return "sha256:" + sha256(data).hexdigest()


class OpenModelSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / "source"
        self.root.mkdir()
        for name, data in REQUIRED.items():
            (self.root / name).write_bytes(data)
        self.manifest = {
            "format": "nir-open-model-package-v2",
            "repository": "Qwen/Qwen3-0.6B",
            "revision": REVISION,
            "runtimeDigest": digest(b"declared runtime"),
            "dependencyDigest": digest(b"declared dependencies"),
            "files": [
                {"path": name, "size": len(data), "sha256": digest(data)}
                for name, data in sorted(REQUIRED.items())
            ],
        }

    def test_preflight_path_swap_is_not_bound_but_snapshot_is(self):
        identity = verify_package(self.root, self.manifest)
        (self.root / "model.safetensors").write_bytes(b"model-weights-B")
        self.assertEqual((self.root / "model.safetensors").read_bytes(), b"model-weights-B")
        with self.assertRaises(SnapshotError):
            with verified_snapshot(self.root, self.manifest):
                pass
        (self.root / "model.safetensors").write_bytes(REQUIRED["model.safetensors"])
        with verified_snapshot(self.root, self.manifest) as snapshot:
            self.assertEqual(snapshot.identity, identity)
            self.assertEqual(verify_package(snapshot.path, self.manifest), identity)
            (self.root / "model.safetensors").write_bytes(b"model-weights-B")
            self.assertEqual((snapshot.path / "model.safetensors").read_bytes(),
                             REQUIRED["model.safetensors"])
            held = snapshot.path
        self.assertFalse(held.exists())

    def test_rejects_incomplete_extra_and_symlink_package(self):
        missing = self.root / "vocab.json"
        missing.unlink()
        with self.assertRaises(SnapshotError):
            with verified_snapshot(self.root, self.manifest):
                pass
        missing.write_bytes(REQUIRED["vocab.json"])
        extra = self.root / "extra.txt"
        extra.write_text("surprise")
        with self.assertRaises(SnapshotError):
            with verified_snapshot(self.root, self.manifest):
                pass
        extra.unlink()
        target = self.root / "vocab.json"
        target.unlink()
        target.symlink_to("tokenizer.json")
        with self.assertRaises(SnapshotError):
            with verified_snapshot(self.root, self.manifest):
                pass

    def test_rejects_source_mutation_during_copy_and_cleans_up(self):
        import nir.open_model_snapshot as module
        original = module._copy_file

        def mutate_after_copy(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[2] == "model.safetensors":
                (self.root / "model.safetensors").write_bytes(b"model-weights-B")
            return result

        with patch.object(module, "_copy_file", side_effect=mutate_after_copy):
            with self.assertRaises(SnapshotError):
                with verified_snapshot(self.root, self.manifest):
                    pass
        self.assertEqual(list(Path(self.temp.name).resolve().iterdir()), [self.root])

    def test_rejects_midstream_same_size_mutation(self):
        import nir.open_model_snapshot as module
        original_copy = module._copy_file
        original_read = module.os.read
        data = b"A" * ((1 << 20) + 16)
        (self.root / "model.safetensors").write_bytes(data)
        item = next(x for x in self.manifest["files"] if x["path"] == "model.safetensors")
        item.update(size=len(data), sha256=digest(data))
        changed = False

        def tampering_read(fd, size):
            nonlocal changed
            chunk = original_read(fd, size)
            if chunk and not changed:
                changed = True
                (self.root / "model.safetensors").write_bytes(b"B" * len(data))
            return chunk

        def copy_with_mutation(*args):
            if args[2] == "model.safetensors":
                with patch.object(module.os, "read", side_effect=tampering_read):
                    return original_copy(*args)
            return original_copy(*args)

        with patch.object(module, "_copy_file", side_effect=copy_with_mutation):
            with self.assertRaises(SnapshotError):
                with verified_snapshot(self.root, self.manifest):
                    pass
        self.assertTrue(changed)

    def test_rejects_manifest_without_complete_core_files(self):
        self.manifest["files"] = [item for item in self.manifest["files"]
                                  if item["path"] != "tokenizer.json"]
        (self.root / "tokenizer.json").unlink()
        with self.assertRaises(SnapshotError):
            with verified_snapshot(self.root, self.manifest):
                pass

    def test_rejects_oversized_manifest_before_source_or_disk_access(self):
        next(item for item in self.manifest["files"]
             if item["path"] == "model.safetensors")["size"] = 4 * (1 << 30) + 1
        with patch("nir.open_model_snapshot.verify_package",
                   side_effect=AssertionError("should not inspect source")):
            with self.assertRaisesRegex(SnapshotError, "size limit"):
                with verified_snapshot(self.root, self.manifest):
                    pass

    def test_tinyllama_core_file_set_is_accepted(self):
        for file in self.root.iterdir():
            file.unlink()
        names = {
            "config.json", "generation_config.json", "model.safetensors",
            "special_tokens_map.json", "tokenizer.json", "tokenizer.model",
            "tokenizer_config.json",
        }
        for name in names:
            (self.root / name).write_bytes(name.encode())
        self.manifest["repository"] = "TinyLlama/TinyLlama-1.1B-Chat-v1.0"
        self.manifest["files"] = [
            {"path": name, "size": len(name.encode()), "sha256": digest(name.encode())}
            for name in sorted(names)
        ]
        with verified_snapshot(self.root, self.manifest) as snapshot:
            self.assertEqual(verify_package(snapshot.path, self.manifest), snapshot.identity)


if __name__ == "__main__":
    unittest.main()

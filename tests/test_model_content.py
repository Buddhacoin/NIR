import io
import json
import os
from pathlib import Path
import stat
import tarfile
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from nir.memory import CapabilityMemory, CapabilitySnapshot
from nir.model import ProtocolError
import nir.model_content as model_content
from nir.model_content import canonical_model_content_commitment


def digest(character: str) -> str:
    return f"sha256:{character * 64}"


def manifest(files, **extra):
    return json.dumps({
        "files": files,
        "format": "nir-model-content-v1",
        **extra,
    }, separators=(",", ":")).encode()


def add_tar_file(archive, name, content, *, executable=False, mtime=0):
    info = tarfile.TarInfo(name)
    info.size = len(content)
    info.mode = 0o755 if executable else 0o644
    info.mtime = mtime
    info.uid = mtime + 1
    info.gid = mtime + 2
    archive.addfile(info, io.BytesIO(content))


class ModelContentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def directory(self, name="model", content=b"weights-v1"):
        root = self.root / name
        root.mkdir()
        (root / "weights.bin").write_bytes(content)
        script = root / "runner.sh"
        script.write_bytes(b"#!/bin/sh\nexit 0\n")
        script.chmod(0o755)
        (root / "nir-model-content.json").write_bytes(manifest([
            {"executable": True, "path": "runner.sh"},
            {"executable": False, "path": "weights.bin"},
        ]))
        return root

    def archive(self, name, wrapper, *, compressed, reverse, mtime):
        path = self.root / name
        mode = "w:gz" if compressed else "w"
        entries = [
            ("weights.bin", b"weights-v1", False),
            ("runner.sh", b"#!/bin/sh\nexit 0\n", True),
            ("nir-model-content.json", manifest([
                {"path": "weights.bin", "executable": False},
                {"path": "runner.sh", "executable": True},
            ]), False),
        ]
        if reverse:
            entries.reverse()
        with tarfile.open(path, mode) as archive:
            for relative, content, executable in entries:
                add_tar_file(
                    archive, f"{wrapper}/{relative}", content,
                    executable=executable, mtime=mtime,
                )
        return path

    def test_archive_order_compression_timestamps_and_wrapper_do_not_change_commitment(self):
        directory = self.directory()
        first = self.archive("first.tar", "wrapper-a", compressed=False, reverse=False, mtime=1)
        second = self.archive("second.tar.gz", "renamed-wrapper", compressed=True, reverse=True, mtime=99)
        expected = canonical_model_content_commitment(directory)
        self.assertEqual(
            expected,
            "sha256:f4fb511d9a34c273c54f6df9ba9089ccdee69449c97ad55f137cf74675c7f075",
        )
        self.assertEqual(canonical_model_content_commitment(first), expected)
        self.assertEqual(canonical_model_content_commitment(second), expected)

        memory = CapabilityMemory()
        memory.seed_reference(
            artifact_hash=digest("a"), behavior_commitment="1" * 64,
            scores_bps={"reasoning-v1": 7_000},
        )
        memory.seal_world_snapshot()
        first_snapshot = CapabilitySnapshot(
            artifact_hash=digest("b"), content_hash=expected,
            parents=(digest("a"),), committed_epoch=1, challenge_epoch=2,
            challenge_seed="2" * 64, behavior_commitment="3" * 64,
            scores_bps={"reasoning-v1": 7_200},
        )
        memory.accept(first_snapshot)
        repackaged = CapabilitySnapshot(
            artifact_hash=digest("c"), content_hash=canonical_model_content_commitment(second),
            parents=(digest("a"),), committed_epoch=3, challenge_epoch=4,
            challenge_seed="4" * 64, behavior_commitment="5" * 64,
            scores_bps={"reasoning-v1": 7_400},
        )
        with self.assertRaisesRegex(ProtocolError, "canonical content"):
            memory.accept(repackaged)

    def test_content_byte_and_executable_bit_change_commitment(self):
        original = self.directory("original")
        changed = self.directory("changed", b"weights-v2")
        executable = self.directory("executable")
        (executable / "weights.bin").chmod(0o755)
        (executable / "nir-model-content.json").write_bytes(manifest([
            {"executable": True, "path": "runner.sh"},
            {"executable": True, "path": "weights.bin"},
        ]))
        original_hash = canonical_model_content_commitment(original)
        self.assertNotEqual(canonical_model_content_commitment(changed), original_hash)
        self.assertNotEqual(canonical_model_content_commitment(executable), original_hash)

    def test_paths_and_manifest_are_strict_and_bounded(self):
        for label, files, extra, pattern in [
            ("duplicate", [
                {"executable": False, "path": "weights.bin"},
                {"executable": False, "path": "weights.bin"},
            ], {}, "duplicated"),
            ("case", [
                {"executable": False, "path": "weights.bin"},
                {"executable": False, "path": "WEIGHTS.BIN"},
            ], {}, "case-colliding"),
            ("unicode", [{"executable": False, "path": "wéights.bin"}], {}, "ASCII"),
            ("traversal", [{"executable": False, "path": "../weights.bin"}], {}, "canonical"),
            ("unknown", [{"executable": False, "path": "weights.bin"}], {"note": "ignored?"}, "schema"),
            ("depth", [{"executable": False, "path": "/".join(["a"] * 17)}], {}, "limits"),
        ]:
            with self.subTest(label=label):
                root = self.root / label
                root.mkdir()
                (root / "weights.bin").write_bytes(b"x")
                (root / "nir-model-content.json").write_bytes(manifest(files, **extra))
                with self.assertRaisesRegex(ProtocolError, pattern):
                    canonical_model_content_commitment(root)

        too_many = self.root / "too-many"
        too_many.mkdir()
        (too_many / "nir-model-content.json").write_bytes(manifest([
            {"executable": False, "path": f"f{index}"} for index in range(257)
        ]))
        with self.assertRaisesRegex(ProtocolError, "file count"):
            canonical_model_content_commitment(too_many)

        duplicate_field = self.root / "duplicate-field"
        duplicate_field.mkdir()
        (duplicate_field / "weights.bin").write_bytes(b"x")
        (duplicate_field / "nir-model-content.json").write_bytes(
            b'{"format":"nir-model-content-v1","format":"nir-model-content-v1","files":[]}'
        )
        with self.assertRaisesRegex(ProtocolError, "duplicate field"):
            canonical_model_content_commitment(duplicate_field)

        oversized = self.directory("oversized")
        with patch("nir.model_content.MAX_TOTAL_BYTES", 2):
            with self.assertRaisesRegex(ProtocolError, "total size"):
                canonical_model_content_commitment(oversized)

    def test_symlink_hardlink_device_and_toctou_are_rejected(self):
        symlink = self.directory("symlink")
        (symlink / "weights.bin").unlink()
        (symlink / "weights.bin").symlink_to(self.root / "outside")
        with self.assertRaisesRegex(ProtocolError, "symbolic"):
            canonical_model_content_commitment(symlink)

        hardlink = self.directory("hardlink")
        os.link(hardlink / "weights.bin", self.root / "second-link")
        with self.assertRaisesRegex(ProtocolError, "hard links"):
            canonical_model_content_commitment(hardlink)

        special = self.directory("special")
        os.mkfifo(special / "unexpected-fifo")
        with self.assertRaisesRegex(ProtocolError, "special"):
            canonical_model_content_commitment(special)

        changing = self.directory("changing")
        real_fstat = os.fstat
        calls = 0

        def unstable(descriptor):
            nonlocal calls
            value = real_fstat(descriptor)
            if stat.S_ISREG(value.st_mode) and value.st_size == len(b"weights-v1"):
                calls += 1
                if calls == 2:
                    fields = {
                        name: getattr(value, name) for name in (
                            "st_dev", "st_ino", "st_mode", "st_nlink", "st_size",
                            "st_mtime_ns", "st_ctime_ns",
                        )
                    }
                    fields["st_mtime_ns"] += 1
                    return SimpleNamespace(**fields)
            return value

        with patch("nir.model_content.os.fstat", side_effect=unstable):
            with self.assertRaisesRegex(ProtocolError, "changed"):
                canonical_model_content_commitment(changing)

    def test_root_and_intermediate_directory_swap_are_rejected(self):
        root = self.directory("root-swap")
        attacker = self.directory("root-attacker", b"attacker")
        parked = self.root / "parked-root"
        real_inventory = model_content._directory_entries

        def swap_root(descriptor):
            entries = real_inventory(descriptor)
            root.rename(parked)
            root.symlink_to(attacker, target_is_directory=True)
            return entries

        with patch("nir.model_content._directory_entries", side_effect=swap_root):
            with self.assertRaisesRegex(ProtocolError, "root changed"):
                canonical_model_content_commitment(root)

        nested = self.root / "nested"
        (nested / "payload").mkdir(parents=True)
        (nested / "payload" / "weights.bin").write_bytes(b"weights")
        (nested / "nir-model-content.json").write_bytes(manifest([
            {"executable": False, "path": "payload/weights.bin"},
        ]))
        replacement = self.root / "replacement"
        replacement.mkdir()
        (replacement / "weights.bin").write_bytes(b"attacker")
        parked_payload = nested / "parked-payload"

        def swap_intermediate(descriptor):
            entries = real_inventory(descriptor)
            (nested / "payload").rename(parked_payload)
            (nested / "payload").symlink_to(replacement, target_is_directory=True)
            return entries

        with patch("nir.model_content._directory_entries", side_effect=swap_intermediate):
            with self.assertRaisesRegex(ProtocolError, "changed|safely"):
                canonical_model_content_commitment(nested)

    def test_outer_archive_size_is_bounded_before_tar_parsing(self):
        archive = self.archive("bounded.tar", "wrapper", compressed=False, reverse=False, mtime=0)
        with patch("nir.model_content.MAX_ARCHIVE_BYTES", 10):
            with self.assertRaisesRegex(ProtocolError, "archive size"):
                canonical_model_content_commitment(archive)

    def test_platform_without_secure_open_primitives_fails_closed(self):
        root = self.directory("unsupported-platform")
        with patch("nir.model_content.os.O_NOFOLLOW", 0):
            with self.assertRaisesRegex(ProtocolError, "secure descriptor-relative"):
                canonical_model_content_commitment(root)
        without_openat = set(os.supports_dir_fd) - {os.open}
        with patch("nir.model_content.os.supports_dir_fd", without_openat):
            with self.assertRaisesRegex(ProtocolError, "secure descriptor-relative"):
                canonical_model_content_commitment(root)


if __name__ == "__main__":
    unittest.main()

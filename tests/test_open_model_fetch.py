"""Pinned Hub download tests; all network and downloader calls are injected."""

from hashlib import sha1, sha256
import json
from pathlib import Path
import tempfile
import unittest

from nir.open_model_fetch import FetchError, fetched_curated_model
from nir.open_model_snapshot import REQUIRED_FILES


REPO = "Qwen/Qwen3-0.6B"
REVISION = "c1899de289a04d12100db370d81485cdf75e47ca"


def digest(data):
    return "sha256:" + sha256(data).hexdigest()


def blob(data):
    return sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.files = {name: ("data:" + name).encode() for name in REQUIRED_FILES[REPO]}
        self.metadata = {"id": REPO, "sha": REVISION, "private": False, "gated": False}
        self.tree = []
        for name, data in sorted(self.files.items()):
            item = {"type": "file", "path": name, "size": len(data), "oid": blob(data)}
            if name == "model.safetensors":
                item["lfs"] = {"oid": sha256(data).hexdigest(), "size": len(data)}
            self.tree.append(item)
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def fetch(self, url):
        result = self.metadata if "/revision/" in url else self.tree
        return 200, {"content-type": "application/json"}, json.dumps(result).encode()

    def download(self, *, repo_id, filename, revision, token, local_dir, endpoint):
        self.calls.append((repo_id, filename, revision, token, endpoint))
        path = Path(local_dir) / filename
        path.write_bytes(self.files[filename])
        return str(path)

    def package(self, **kwargs):
        return fetched_curated_model(
            REPO, REVISION, digest(b"declared-runtime"), digest(b"declared-deps"),
            fetch=self.fetch, downloader=self.download, parent=self.root, **kwargs,
        )

    def test_success_pins_every_file_and_cleans_up(self):
        with self.package() as package:
            self.assertEqual({p.name for p in package.path.iterdir()}, set(self.files))
            self.assertEqual({x[1] for x in self.calls}, set(self.files))
            self.assertTrue(all(x[2] == REVISION and x[3] is False for x in self.calls))
            self.assertEqual(package.manifest["revision"], REVISION)
            self.assertRegex(package.identity, r"^sha256:[a-f0-9]{64}$")
            path = package.path
        self.assertFalse(path.exists())

    def test_wrong_bytes_truncation_and_symlink_clean_up(self):
        original = self.download
        def corrupt(**kwargs):
            result = Path(original(**kwargs))
            if kwargs["filename"] == "model.safetensors":
                result.write_bytes(b"X" * len(self.files["model.safetensors"]))
            return str(result)
        self.download = corrupt
        with self.assertRaises(FetchError):
            with self.package():
                pass
        self.assertEqual(list(self.root.iterdir()), [])
        def truncated(**kwargs):
            result = Path(original(**kwargs))
            if kwargs["filename"] == "config.json":
                result.write_bytes(b"X")
            return str(result)
        self.download = truncated
        with self.assertRaises(FetchError):
            with self.package():
                pass
        self.assertEqual(list(self.root.iterdir()), [])
        def symlink(**kwargs):
            result = Path(original(**kwargs))
            if kwargs["filename"] == "config.json":
                result.unlink()
                result.symlink_to("/etc/hosts")
            return str(result)
        self.download = symlink
        with self.assertRaises(FetchError):
            with self.package():
                pass
        self.assertEqual(list(self.root.iterdir()), [])

    def test_missing_extra_and_malicious_return_path_fail(self):
        original_tree = self.tree[:]
        self.tree = self.tree[:-1]
        with self.assertRaises(FetchError):
            with self.package():
                pass
        self.assertEqual(self.calls, [])
        self.tree = original_tree[:]
        self.tree.append({"type": "file", "path": "../config.json", "size": 1,
                          "oid": "a" * 40})
        with self.assertRaises(FetchError):
            with self.package():
                pass
        self.assertEqual(self.calls, [])
        self.tree = original_tree
        original = self.download
        def redirect(**kwargs):
            original(**kwargs)
            return "/etc/hosts"
        self.download = redirect
        with self.assertRaises(FetchError):
            with self.package():
                pass
        self.assertEqual(list(self.root.iterdir()), [])

    def test_revision_access_and_interrupt_fail_closed(self):
        for rev in ("main", "a" * 39, "A" * 40, "a" * 40):
            with self.subTest(rev=rev), self.assertRaises(FetchError):
                with fetched_curated_model(REPO, rev, digest(b"r"), digest(b"d"),
                                          fetch=self.fetch, downloader=self.download,
                                          parent=self.root):
                    pass
        for field, value in (("sha", "b" * 40), ("private", True), ("gated", "auto")):
            original = self.metadata[field]
            self.metadata[field] = value
            with self.subTest(field=field), self.assertRaises(FetchError):
                with self.package():
                    pass
            self.metadata[field] = original
        self.assertEqual(self.calls, [])
        def interrupted(**kwargs):
            if kwargs["filename"] == "model.safetensors":
                raise RuntimeError("network interrupted")
            return self.download_original(**kwargs)
        self.download_original = self.download
        self.download = interrupted
        with self.assertRaises(FetchError):
            with self.package():
                pass
        self.assertEqual(list(self.root.iterdir()), [])

    def test_oversized_reported_core_is_rejected_before_download(self):
        entry = next(item for item in self.tree if item["path"] == "model.safetensors")
        entry["size"] = 4 * (1 << 30) + 1
        entry["lfs"]["size"] = entry["size"]
        with self.assertRaises(FetchError):
            with self.package():
                pass
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()

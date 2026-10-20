"""Fail-closed Hub provenance checks; no network or model execution in tests."""

from hashlib import sha1, sha256
import json
from pathlib import Path
import tempfile
import unittest

from nir.open_model_source import SourceError, verify_hub_source


SHA = "a" * 40
REPO = "Qwen/Qwen3-0.6B"


def raw_digest(data):
    return "sha256:" + sha256(data).hexdigest()


def git_blob(data):
    return sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


class OpenModelSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve() / "model"
        self.root.mkdir()
        self.files = {"config.json": b'{"model_type":"qwen3"}',
                      "model.safetensors": b"safe-weights"}
        for name, data in self.files.items():
            (self.root / name).write_bytes(data)
        self.manifest = {
            "format": "nir-open-model-package-v2", "repository": REPO,
            "revision": SHA, "runtimeDigest": raw_digest(b"runtime"),
            "dependencyDigest": raw_digest(b"dependencies"),
            "files": [{"path": name, "size": len(data), "sha256": raw_digest(data)}
                      for name, data in sorted(self.files.items())],
        }
        self.metadata = {"id": REPO, "sha": SHA, "private": False, "gated": False}
        self.tree = [
            {"type": "file", "path": "config.json", "size": len(self.files["config.json"]),
             "oid": git_blob(self.files["config.json"])},
            {"type": "file", "path": "model.safetensors", "size": len(self.files["model.safetensors"]),
             "oid": git_blob(b"version https://git-lfs.github.com/spec/v1\n"),
             "lfs": {"oid": sha256(self.files["model.safetensors"]).hexdigest(),
                     "size": len(self.files["model.safetensors"])}}
        ]

    def tearDown(self):
        self.temp.cleanup()

    def fetcher(self, url):
        if "/revision/" in url:
            return 200, {"content-type": "application/json"}, json.dumps(self.metadata).encode()
        return 200, {"content-type": "application/json"}, json.dumps(self.tree).encode()

    def test_exact_source_and_local_bytes(self):
        self.assertRegex(verify_hub_source(self.root, self.manifest, fetch=self.fetcher),
                         r"^sha256:[0-9a-f]{64}$")

    def test_wrong_repo_revision_and_access_fail(self):
        for change in ({"id": "attacker/Qwen3-0.6B"}, {"sha": "b" * 40},
                       {"private": True}, {"gated": "auto"}):
            with self.subTest(change=change):
                self.metadata.update(change)
                with self.assertRaises(SourceError):
                    verify_hub_source(self.root, self.manifest, fetch=self.fetcher)
                self.metadata = {"id": REPO, "sha": SHA, "private": False, "gated": False}
        self.manifest["repository"] = "attacker/model"
        with self.assertRaises(SourceError):
            verify_hub_source(self.root, self.manifest, fetch=self.fetcher)

    def test_mutated_lfs_or_git_blob_fail(self):
        self.tree[1]["lfs"]["oid"] = "0" * 64
        with self.assertRaises(SourceError):
            verify_hub_source(self.root, self.manifest, fetch=self.fetcher)
        self.tree[1]["lfs"]["oid"] = sha256(self.files["model.safetensors"]).hexdigest()
        self.tree[0]["oid"] = git_blob(b"same-size-mutated-bytes")
        with self.assertRaises(SourceError):
            verify_hub_source(self.root, self.manifest, fetch=self.fetcher)

    def test_redirect_pagination_missing_and_duplicate_tree_fail(self):
        original = self.fetcher
        for fetch in (
            lambda url: (302, {"location": "https://evil.invalid/model"}, b""),
            lambda url: (200, {"content-type": "application/json", "link": "<next>; rel=next"}, b"[]"),
            lambda url: (200, {"content-type": "text/html"}, b"<html/>"),
        ):
            with self.subTest(fetch=fetch), self.assertRaises(SourceError):
                verify_hub_source(self.root, self.manifest, fetch=fetch)
        self.tree = self.tree[:-1]
        with self.assertRaises(SourceError):
            verify_hub_source(self.root, self.manifest, fetch=original)
        self.tree = [
            {"type": "file", "path": "config.json", "size": len(self.files["config.json"]),
             "oid": git_blob(self.files["config.json"])},
            {"type": "file", "path": "model.safetensors", "size": len(self.files["model.safetensors"]),
             "oid": "a" * 40, "lfs": {"oid": sha256(self.files["model.safetensors"]).hexdigest(),
                                        "size": len(self.files["model.safetensors"])}}]
        self.tree.append(dict(self.tree[0]))
        with self.assertRaises(SourceError):
            verify_hub_source(self.root, self.manifest, fetch=original)

    def test_unselected_hub_file_is_allowed_but_not_local_extra(self):
        self.tree.append({"type": "file", "path": "README.md", "size": 3,
                          "oid": git_blob(b"doc")})
        verify_hub_source(self.root, self.manifest, fetch=self.fetcher)
        (self.root / "README.md").write_bytes(b"doc")
        with self.assertRaises(SourceError):
            verify_hub_source(self.root, self.manifest, fetch=self.fetcher)

    def test_local_mutation_and_non_lfs_unproved_fail(self):
        (self.root / "config.json").write_bytes(b"wrong")
        with self.assertRaises(SourceError):
            verify_hub_source(self.root, self.manifest, fetch=self.fetcher)
        (self.root / "config.json").write_bytes(self.files["config.json"])
        del self.tree[0]["oid"]
        with self.assertRaises(SourceError):
            verify_hub_source(self.root, self.manifest, fetch=self.fetcher)


if __name__ == "__main__":
    unittest.main()

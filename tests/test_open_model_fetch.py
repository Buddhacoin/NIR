"""Pinned Hub download tests; all network and downloader calls are injected."""

from hashlib import sha1, sha256
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
import tempfile
import threading
from time import monotonic, sleep
import unittest

from nir.open_model_fetch import FetchError, _HubRedirect, _download_hub, fetched_curated_model
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

    def download(self, *, repo_id, filename, revision, token, local_dir, endpoint,
                 expected_size, deadline):
        self.calls.append((repo_id, filename, revision, token, endpoint, expected_size))
        self.assertGreater(deadline, 0)
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
            self.assertTrue(all(x[5] == len(self.files[x[1]]) for x in self.calls))
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

    def test_streaming_download_stops_at_pinned_size_before_extra_disk_write(self):
        class Response(BytesIO):
            status = 200
            headers = {}

        folder = self.root / "download"
        folder.mkdir()
        name = "config.json"
        expected = len(self.files[name])

        def stream(body, headers=None):
            def open_response(request, timeout):
                self.assertIn(f"/resolve/{REVISION}/{name}", request.full_url)
                self.assertEqual(timeout, 15)
                response = Response(body)
                response.headers = {"Content-Length": str(expected)} if headers is None else headers
                return response
            return open_response

        def run(body, headers=None):
            return _download_hub(repo_id=REPO, filename=name, revision=REVISION,
                                 token=False, local_dir=str(folder),
                                 endpoint="https://huggingface.co",
                                 expected_size=expected,
                                 open_response=stream(body, headers))

        with self.assertRaisesRegex(FetchError, "exceeded pinned byte limit"):
            run(b"A" * (expected + 1000))
        self.assertLessEqual((folder / name).stat().st_size, expected)
        (folder / name).unlink()
        with self.assertRaisesRegex(FetchError, "length differs"):
            run(b"A" * expected, {"Content-Length": str(expected + 1)})
        self.assertEqual((folder / name).stat().st_size, 0)
        (folder / name).unlink()
        with self.assertRaisesRegex(FetchError, "length differs"):
            run(b"A" * expected, {})
        (folder / name).unlink()
        with self.assertRaisesRegex(FetchError, "compressed"):
            run(b"A" * expected, {"Content-Length": str(expected),
                                   "Content-Encoding": "gzip"})
        (folder / name).unlink()
        with self.assertRaisesRegex(FetchError, "ended before"):
            run(b"A" * (expected - 1))
        (folder / name).unlink()
        path = run(b"A" * expected, {"Content-Length": str(expected)})
        self.assertEqual(Path(path).read_bytes(), b"A" * expected)

    def test_streaming_download_rejects_untrusted_redirects_and_symlink(self):
        handler = _HubRedirect()
        for url in ("http://huggingface.co/file", "https://evil.example/file",
                    "https://huggingface.co.evil.example/file", "https://127.0.0.1/file"):
            with self.subTest(url=url), self.assertRaises(FetchError):
                handler.redirect_request(None, None, 302, "Found", {}, url)
        folder = self.root / "download"
        folder.mkdir()
        (folder / "config.json").symlink_to(self.root / "victim")
        with self.assertRaises(FetchError):
            _download_hub(repo_id=REPO, filename="config.json", revision=REVISION,
                          token=False, local_dir=str(folder),
                          endpoint="https://huggingface.co", expected_size=1,
                          open_response=lambda *_args, **_kwargs: self.fail("network must not start"))

    def test_slow_trickle_exceeds_overall_deadline_before_more_writes(self):
        class SlowResponse:
            status = 200
            headers = {"Content-Length": "1000000"}
            reads = 0

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                self.reads += 1
                return b"A"

            read1 = read

        folder = self.root / "slow"
        folder.mkdir()
        response = SlowResponse()
        ticks = iter((0, 0, 1, 20))
        with self.assertRaisesRegex(FetchError, "time limit"):
            _download_hub(repo_id=REPO, filename="config.json", revision=REVISION,
                          token=False, local_dir=str(folder), endpoint="https://huggingface.co",
                          expected_size=1_000_000,
                          open_response=lambda *_args, **_kwargs: response,
                          clock=lambda: next(ticks), deadline=20)
        self.assertLessEqual((folder / "config.json").stat().st_size, 1)
        self.assertLessEqual(response.reads, 2)

    def test_real_http_response_slow_trickle_obeys_deadline(self):
        class Trickle(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", "1000000")
                self.end_headers()
                for _ in range(100):
                    try:
                        self.wfile.write(b"A")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        return
                    sleep(0.05)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Trickle)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        folder = self.root / "real-slow"
        folder.mkdir()
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)

        def open_response(_request, timeout):
            connection.request("GET", "/model")
            return connection.getresponse()

        start = monotonic()
        try:
            with self.assertRaisesRegex(FetchError, "time limit"):
                _download_hub(repo_id=REPO, filename="config.json", revision=REVISION,
                              token=False, local_dir=str(folder), endpoint="https://huggingface.co",
                              expected_size=1_000_000, open_response=open_response,
                              deadline=start + 0.25)
            self.assertLess(monotonic() - start, 1.0)
            self.assertLess((folder / "config.json").stat().st_size, 100)
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_real_chunked_response_is_rejected_without_waiting_for_body(self):
        class ChunkedTrickle(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                try:
                    self.wfile.write(b"1\r\nA\r\n")
                    self.wfile.flush()
                    sleep(1)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), ChunkedTrickle)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        folder = self.root / "chunked"
        folder.mkdir()
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)

        def open_response(_request, timeout):
            connection.request("GET", "/model")
            return connection.getresponse()

        start = monotonic()
        try:
            with self.assertRaisesRegex(FetchError, "chunked"):
                _download_hub(repo_id=REPO, filename="config.json", revision=REVISION,
                              token=False, local_dir=str(folder), endpoint="https://huggingface.co",
                              expected_size=1_000_000, open_response=open_response,
                              deadline=start + 0.1)
            self.assertLess(monotonic() - start, 0.8)
            self.assertEqual((folder / "config.json").stat().st_size, 0)
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()

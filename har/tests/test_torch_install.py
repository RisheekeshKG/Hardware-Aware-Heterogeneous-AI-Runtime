"""PyTorch install: parallel ranged downloads, resume, hash checks, and the uv hand-off."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from har.runtime import torch_install
from har.runtime.torch_install import DownloadError, download, install

PAYLOAD = os.urandom(3 * 1024 * 1024 + 12345)  # not a multiple of the chunk size
PAYLOAD_SHA = hashlib.sha256(PAYLOAD).hexdigest()
CHUNK = 256 * 1024


class Server:
    """Serves PAYLOAD at /file.whl. Counts ranged requests; can refuse ranges or fail after N."""

    def __init__(self, *, ranges: bool = True, fail_after: int | None = None) -> None:
        self.ranges, self.fail_after = ranges, fail_after
        self.ranged_requests = 0
        self.lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # keep test output quiet
                pass

            def do_GET(self):
                header = self.headers.get("Range")
                if header and outer.ranges:
                    start, end = (int(x) for x in header.removeprefix("bytes=").split("-"))
                    with outer.lock:
                        outer.ranged_requests += 1
                        count = outer.ranged_requests
                    # The 1-byte size probe is request 1; fail data pieces after `fail_after`.
                    if outer.fail_after is not None and end > 0 and count > outer.fail_after + 1:
                        self.send_response(503)
                        self.end_headers()
                        return
                    body = PAYLOAD[start:end + 1]
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{len(PAYLOAD)}")
                else:
                    body = PAYLOAD
                    self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/torch-2.11.0%2Bcu128-cp312-cp312-win_amd64.whl"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def server():
    created = []

    def make(**kwargs):
        instance = Server(**kwargs)
        created.append(instance)
        return instance

    yield make
    for instance in created:
        instance.close()


@pytest.fixture(autouse=True)
def fast_retries(monkeypatch):
    monkeypatch.setattr(torch_install.time, "sleep", lambda seconds: None)


def test_parallel_pieces_reassemble_to_the_exact_file(server, tmp_path):
    srv = server()
    dest = download(srv.url, tmp_path / "torch.whl", sha256=PAYLOAD_SHA, connections=4, chunk_bytes=CHUNK, log=lambda line: None)
    assert dest.read_bytes() == PAYLOAD
    pieces = -(-len(PAYLOAD) // CHUNK)
    assert srv.ranged_requests == pieces + 1  # one size probe plus one request per piece
    assert not (tmp_path / "torch.whl.part").exists()
    assert not (tmp_path / "torch.whl.part.json").exists()


def test_interrupted_download_resumes_without_refetching(server, tmp_path, monkeypatch):
    monkeypatch.setattr(torch_install, "CHUNK_ATTEMPTS", 1)
    broken = server(fail_after=5)
    with pytest.raises(DownloadError, match="try again to continue"):
        download(broken.url, tmp_path / "torch.whl", sha256=PAYLOAD_SHA, connections=1, chunk_bytes=CHUNK, log=lambda line: None)
    state = json.loads((tmp_path / "torch.whl.part.json").read_text())
    assert len(state["done"]) == 5

    # Resuming needs the same URL, so the same server comes back healthy.
    lines = []
    broken.fail_after = None
    broken.ranged_requests = 0
    download(broken.url, tmp_path / "torch.whl", sha256=PAYLOAD_SHA, connections=2, chunk_bytes=CHUNK, log=lines.append)
    pieces = -(-len(PAYLOAD) // CHUNK)
    assert broken.ranged_requests == (pieces - 5) + 1
    assert any(line.startswith("Resuming") for line in lines)
    assert (tmp_path / "torch.whl").read_bytes() == PAYLOAD


def test_server_without_ranges_falls_back_to_one_stream(server, tmp_path):
    srv = server(ranges=False)
    dest = download(srv.url, tmp_path / "torch.whl", sha256=PAYLOAD_SHA, chunk_bytes=CHUNK, log=lambda line: None)
    assert dest.read_bytes() == PAYLOAD


def test_checksum_mismatch_is_rejected_and_cleaned_up(server, tmp_path):
    srv = server()
    with pytest.raises(DownloadError, match="checksum"):
        download(srv.url, tmp_path / "torch.whl", sha256="0" * 64, connections=2, chunk_bytes=CHUNK, log=lambda line: None)
    assert list(tmp_path.iterdir()) == []


def test_wheel_already_in_the_cache_needs_no_network(server, tmp_path):
    srv = server()
    cached = tmp_path / "torch.whl"
    cached.write_bytes(PAYLOAD)  # e.g. copied over from another computer
    lines = []
    download(srv.url, cached, sha256=PAYLOAD_SHA, log=lines.append)
    assert srv.ranged_requests == 0
    assert "from the download cache" in lines[0]


FAKE_UV = r'''
import json, pathlib, sys
args = sys.argv[1:]
log = pathlib.Path(sys.argv[0]).with_suffix(".calls.json")
calls = json.loads(log.read_text()) if log.exists() else []
calls.append(args)
log.write_text(json.dumps(calls))
if args[:2] == ["pip", "compile"]:
    out = pathlib.Path(args[args.index("-o") + 1])
    out.write_text("""lock-version = "1.0"
[[packages]]
name = "torch"
version = "2.11.0+cu128"
wheels = [{ url = "TORCH_URL", hashes = { sha256 = "TORCH_SHA" } }]
[[packages]]
name = "numpy"
version = "2.5.5"
wheels = [{ url = "https://files.pythonhosted.org/numpy-2.5.5-cp312-cp312-win_amd64.whl", size = 12600000, hashes = { sha256 = "ab" } }]
""")
elif args[:2] == ["pip", "install"]:
    print("Installed 2 packages")
'''


def test_install_downloads_torch_itself_and_hands_uv_the_local_file(server, tmp_path):
    srv = server()
    fake = tmp_path / "fake_uv.py"
    fake.write_text(FAKE_UV.replace("TORCH_URL", srv.url).replace("TORCH_SHA", PAYLOAD_SHA))
    lines = []
    code = install(tmp_path / "target", [sys.executable, str(fake)], tmp_path / "cache", "3.12", log=lines.append, connections=3)
    assert code == 0
    wheel = tmp_path / "cache" / "torch-2.11.0+cu128-cp312-cp312-win_amd64.whl"
    assert wheel.read_bytes() == PAYLOAD

    compile_call, install_call = json.loads((tmp_path / "fake_uv.calls.json").read_text())
    assert compile_call[:2] == ["pip", "compile"] and "--torch-backend" in compile_call
    assert install_call[:2] == ["pip", "install"]
    assert "--no-deps" in install_call
    assert str(wheel) in install_call and "numpy==2.5.5" in install_call
    assert install_call[install_call.index("--target") + 1] == str(tmp_path / "target")
    assert "Installed 2 packages" in lines

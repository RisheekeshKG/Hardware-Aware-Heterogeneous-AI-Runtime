"""Install PyTorch for the desktop app, fetching the big wheel in parallel pieces.

uv downloads each file over one connection and starts over if it drops. That is fine for
everything except PyTorch's CUDA build: one 2.5-3 GB wheel from download.pytorch.org, which
some networks throttle per connection (hours instead of minutes). So:

1. uv resolves what this computer needs (`--torch-backend auto` picks the CPU, MPS or CUDA
   build) into a lock file with exact URLs and hashes.
2. Wheels of 64 MB or more are downloaded here: several ranged requests at once, resumable
   after a cancel or a dropped connection, and checked against the published sha256. They go
   into a cache folder that survives reinstalls. A .whl copied into that folder from another
   computer is used as-is (after the hash check), so a second PC can skip the download.
3. uv installs exactly the locked set, taking the big wheels from the cache and the small
   ones from PyPI.

Progress is printed one line at a time; the desktop app shows the latest line.
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlsplit

import httpx

BIG_WHEEL_BYTES = 64 * 1024 * 1024
CHUNK_BYTES = 16 * 1024 * 1024
CONNECTIONS = 8
CHUNK_ATTEMPTS = 6
REQUIREMENTS = ("torch", "numpy")

Log = Callable[[str], None]


def _print(line: str) -> None:
    print(line, flush=True)


@dataclass
class LockedWheel:
    name: str
    version: str
    url: str
    sha256: str | None
    size: int | None

    @property
    def filename(self) -> str:
        # download.pytorch.org URLs encode the "+" of local versions ("2.11.0%2Bcu128").
        return unquote(urlsplit(self.url).path.rsplit("/", 1)[-1])


class DownloadError(RuntimeError):
    pass


# --- resolve ---------------------------------------------------------------------------

def resolve(uv: list[str], python_version: str, env: dict[str, str], log: Log = _print) -> list[LockedWheel]:
    """Ask uv which wheels this computer needs, as a pylock.toml with URLs and hashes."""

    log("Resolving PyTorch for this computer…")
    with tempfile.TemporaryDirectory(prefix="har-resolve-") as folder:
        lock = Path(folder) / "pylock.toml"
        result = subprocess.run(
            [*uv, "pip", "compile", "-", "--torch-backend", "auto", "--python-version", python_version,
             "--format", "pylock.toml", "--quiet", "-o", str(lock)],
            input="\n".join(REQUIREMENTS) + "\n",
            capture_output=True,
            text=True,
            env=env,
            **_no_window(),
        )
        if result.returncode != 0:
            for line in (result.stderr or result.stdout).strip().splitlines()[-12:]:
                log(line)
            raise RuntimeError("uv could not resolve PyTorch for this computer")
        data = tomllib.loads(lock.read_text(encoding="utf-8"))
    wheels = []
    for package in data.get("packages", []):
        candidates = package.get("wheels") or []
        if not candidates:
            raise RuntimeError(f"{package['name']} has no prebuilt wheel for this computer")
        wheel = candidates[0]
        wheels.append(LockedWheel(
            name=package["name"],
            version=package["version"],
            url=wheel["url"],
            sha256=(wheel.get("hashes") or {}).get("sha256"),
            size=wheel.get("size"),
        ))
    return wheels


# --- download --------------------------------------------------------------------------

def _human(num: float) -> str:
    if num < 1024 * 1024:
        return f"{num / 1024:.0f} KB"
    if num < 1024 ** 3:
        return f"{num / 1024 ** 2:.1f} MB"
    return f"{num / 1024 ** 3:.2f} GB"


def _eta(seconds: float) -> str:
    if seconds < 90:
        return f"about {max(1, round(seconds))} s left"
    if seconds < 5400:
        return f"about {round(seconds / 60)} min left"
    return f"about {seconds / 3600:.1f} h left"


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _probe(client: httpx.Client, url: str) -> tuple[int | None, bool]:
    """(size, supports byte ranges). Asks for one byte, since some CDNs ignore HEAD details."""

    # Streamed and closed unread: a server that ignores Range would otherwise send the whole file.
    with client.stream("GET", url, headers={"Range": "bytes=0-0"}) as response:
        if response.status_code == 206:
            total = response.headers.get("content-range", "").rsplit("/", 1)[-1]
            return (int(total) if total.isdigit() else None), True
        response.raise_for_status()
        length = response.headers.get("content-length")
        return (int(length) if length and length.isdigit() else None), False


class _Progress:
    """Prints one line a second: done / total, speed, time left."""

    def __init__(self, label: str, total: int, already: int, log: Log) -> None:
        self.label, self.total, self.log = label, total, log
        self.done = already
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def add(self, count: int) -> None:
        with self.lock:
            self.done += count

    def _run(self) -> None:
        last_done, last_time, speed = self.done, time.monotonic(), 0.0
        while not self.stop.wait(1.0):
            now = time.monotonic()
            with self.lock:
                done = self.done
            rate = (done - last_done) / max(now - last_time, 1e-6)
            speed = rate if speed == 0 else 0.7 * speed + 0.3 * rate
            last_done, last_time = done, now
            left = (self.total - done) / speed if speed > 0 else None
            self.log(
                f"Downloading {self.label}: {_human(done)} of {_human(self.total)} ({done * 100 // max(self.total, 1)}%)"
                f" · {_human(speed)}/s" + (f" · {_eta(left)}" if left is not None else "")
            )

    def __enter__(self) -> "_Progress":
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop.set()
        self.thread.join(timeout=2)


def download(
    url: str,
    dest: Path,
    *,
    sha256: str | None = None,
    label: str | None = None,
    connections: int = CONNECTIONS,
    chunk_bytes: int = CHUNK_BYTES,
    log: Log = _print,
    client: httpx.Client | None = None,
) -> Path:
    """Download `url` to `dest` with `connections` ranged requests in parallel.

    Progress survives interruption: finished pieces are recorded next to `<dest>.part`, so the
    next call fetches only what is missing. A complete file whose hash matches is reused
    without any network request.
    """

    label = label or dest.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        if sha256 is None or sha256_of(dest) == sha256:
            log(f"Using {dest.name} from the download cache")
            return dest
        log(f"{dest.name} in the cache is damaged; downloading it again")
        dest.unlink()

    part = dest.with_name(dest.name + ".part")
    state_path = dest.with_name(dest.name + ".part.json")
    own_client = client is None
    client = client or httpx.Client(timeout=httpx.Timeout(30.0, read=60.0), follow_redirects=True,
                                    limits=httpx.Limits(max_connections=connections + 2))
    try:
        size, ranged = _probe(client, url)
        if not ranged or not size:
            _download_single(client, url, part, label, log)
        else:
            _download_ranged(client, url, part, state_path, size, label, connections, chunk_bytes, log)
    finally:
        if own_client:
            client.close()

    if sha256:
        log(f"Checking {label}…")
        actual = sha256_of(part)
        if actual != sha256:
            part.unlink(missing_ok=True)
            state_path.unlink(missing_ok=True)
            raise DownloadError(f"{label} came down damaged (checksum mismatch). Try again; it starts over.")
    os.replace(part, dest)
    state_path.unlink(missing_ok=True)
    return dest


def _download_ranged(client, url, part, state_path, size, label, connections, chunk_bytes, log) -> None:
    count = (size + chunk_bytes - 1) // chunk_bytes
    done: set[int] = set()
    if part.exists() and state_path.exists():
        try:
            state = json.loads(state_path.read_text())
            if state.get("url") == url and state.get("size") == size and state.get("chunk") == chunk_bytes:
                done = {int(i) for i in state.get("done", [])}
        except (OSError, ValueError):
            done = set()
    if not done or not part.exists() or part.stat().st_size != size:
        done = set()
        with part.open("wb") as handle:
            handle.truncate(size)
    already = sum(min(chunk_bytes, size - i * chunk_bytes) for i in done)
    if already:
        log(f"Resuming {label}: {_human(already)} of {_human(size)} already downloaded")

    todo: queue.Queue[int] = queue.Queue()
    for index in range(count):
        if index not in done:
            todo.put(index)
    state_lock = threading.Lock()
    failures: list[BaseException] = []

    def save_state() -> None:
        tmp = state_path.with_name(state_path.name + ".tmp")
        tmp.write_text(json.dumps({"url": url, "size": size, "chunk": chunk_bytes, "done": sorted(done)}))
        os.replace(tmp, state_path)

    def worker(progress: _Progress) -> None:
        with part.open("r+b") as handle:
            while not failures:
                try:
                    index = todo.get_nowait()
                except queue.Empty:
                    return
                start = index * chunk_bytes
                end = min(start + chunk_bytes, size) - 1
                for attempt in range(CHUNK_ATTEMPTS):
                    written = 0
                    try:
                        with client.stream("GET", url, headers={"Range": f"bytes={start}-{end}"}) as response:
                            if response.status_code != 206:
                                raise DownloadError(f"server answered {response.status_code} to a ranged request")
                            handle.seek(start)
                            for block in response.iter_bytes(1024 * 1024):
                                handle.write(block)
                                written += len(block)
                                progress.add(len(block))
                        if written != end - start + 1:
                            raise DownloadError("piece ended early")
                        break
                    except (httpx.HTTPError, DownloadError, OSError) as error:
                        progress.add(-written)
                        if attempt == CHUNK_ATTEMPTS - 1:
                            failures.append(error)
                            return
                        time.sleep(min(2 ** attempt, 30))
                handle.flush()
                with state_lock:
                    done.add(index)
                    save_state()

    with _Progress(label, size, already, log) as progress:
        threads = [threading.Thread(target=worker, args=(progress,), daemon=True) for _ in range(max(1, connections))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    if failures:
        raise DownloadError(f"Downloading {label} failed: {failures[0]}. What finished is kept; try again to continue.")
    if len(done) != count:
        raise DownloadError(f"Downloading {label} stopped early. What finished is kept; try again to continue.")


def _download_single(client, url, part, label, log) -> None:
    """Servers without byte ranges: one stream, from the start."""

    with client.stream("GET", url) as response:
        response.raise_for_status()
        total = int(response.headers.get("content-length") or 0)
        with part.open("wb") as handle, _Progress(label, total or 1, 0, log) as progress:
            for block in response.iter_bytes(1024 * 1024):
                handle.write(block)
                progress.add(len(block))


# --- install ---------------------------------------------------------------------------

def _no_window() -> dict:
    return {"creationflags": 0x08000000} if os.name == "nt" else {}  # CREATE_NO_WINDOW


def install(
    target: Path,
    uv: list[str],
    cache: Path,
    python_version: str,
    *,
    log: Log = _print,
    connections: int = CONNECTIONS,
) -> int:
    """Resolve, download the big wheels in parallel, then let uv install the locked set."""

    env = {**os.environ, "UV_PYTHON_DOWNLOADS": "automatic", "UV_NO_CONFIG": "1", "NO_COLOR": "1"}
    wheels = resolve(uv, python_version, env, log)
    log(f"Resolved {len(wheels)} packages")

    local: dict[str, Path] = {}
    with httpx.Client(timeout=httpx.Timeout(30.0, read=60.0), follow_redirects=True,
                      limits=httpx.Limits(max_connections=connections + 2)) as client:
        for wheel in wheels:
            size = wheel.size
            if size is None and wheel.name != "torch":
                continue  # small packages without a listed size: leave them to uv
            if wheel.name == "torch" or (size or 0) >= BIG_WHEEL_BYTES:
                label = f"{wheel.name} {wheel.version}"
                local[wheel.name] = download(wheel.url, cache / wheel.filename, sha256=wheel.sha256, label=label,
                                             connections=connections, log=log, client=client)

    specs = [str(local[w.name]) if w.name in local else f"{w.name}=={w.version}" for w in wheels]
    log("Installing…")
    process = subprocess.Popen(
        [*uv, "pip", "install", "--target", str(target), "--python", python_version, "--no-deps", *specs],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        **_no_window(),
    )
    assert process.stdout is not None
    for line in process.stdout:
        if line.strip():
            log(line.rstrip())
    return process.wait()

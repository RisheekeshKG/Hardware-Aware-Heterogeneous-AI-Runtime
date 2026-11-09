"""Run a user Python script in an isolated child process with a timeout.

Replacing the previous `runpy.run_path`-in-a-thread model fixes three problems the
critique called out at once:

- The script can't crash or hang the server process any more; the OS kills it.
- A hung script is actually killable, because we spawn it in its own process group
  (POSIX `setsid` / Windows `CREATE_NEW_PROCESS_GROUP`) and tear the whole tree
  down with psutil on timeout.
- Durations come from `time.monotonic()` on the side that ran the work, so wall-clock
  skew between host and worker can't poison the reported `execute_seconds`.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import psutil


DEFAULT_SCRIPT_TIMEOUT_SECONDS = 600  # 10 minutes; override per-request via ScriptRunRequest.timeout_seconds.
_OUTPUT_TAIL_BYTES = 100_000


def run_script_in_subprocess(
    *,
    filename: str,
    content: str,
    args: list[str],
    cwd: Path,
    timeout_seconds: float = DEFAULT_SCRIPT_TIMEOUT_SECONDS,
    extra_env: dict[str, str] | None = None,
    on_chunk: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """Run `content` as `cwd/filename` in a fresh Python subprocess.

    If `on_chunk(stream, text)` is given, it's invoked as each line (or bounded chunk) of
    stdout/stderr arrives — this is what lets the UI stream output live instead of the
    user staring at a blank panel for two minutes while a training script produces output
    that only gets flushed at exit.

    Returns `{stdout, stderr, exit_code, timed_out, execute_seconds}` where `execute_seconds`
    is measured with `time.monotonic()`. On timeout the process group is killed and
    `timed_out=True`.
    """

    script_path = cwd / filename
    script_path.write_text(content, encoding="utf-8")

    # Frozen vs dev: in a PyInstaller build, `sys.executable` is the har-runtime-server
    # bootloader, so re-invoking ourselves with `run-script <path>` reuses the bundled
    # Python without needing a separately-installed interpreter. In a plain pip install,
    # `sys.executable` is a regular python and we just hand it the script directly.
    if getattr(sys, "frozen", False):
        cmd = [sys.executable, "run-script", str(script_path), *args]
    else:
        cmd = [sys.executable, str(script_path), *args]

    env = {**os.environ, **(extra_env or {})}
    # PYTHONUNBUFFERED forces the child's stdout/stderr to flush per line. Without it,
    # Python buffers heavily when writing to a pipe (not a TTY), so streaming would see
    # nothing until the process exits — defeating the whole point.
    env["PYTHONUNBUFFERED"] = "1"

    popen_kwargs: dict[str, Any] = dict(
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    # Isolate the child in its own process group so SIGTERM/kill-tree reaches
    # anything it spawned (otherwise a bash-launched grandchild would survive).
    if os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_kwargs["start_new_session"] = True

    start = time.monotonic()
    try:
        proc = subprocess.Popen(cmd, **popen_kwargs)
    except OSError as error:
        return {
            "stdout": "",
            "stderr": f"Could not start subprocess: {error}",
            "exit_code": None,
            "timed_out": False,
            "execute_seconds": 0.0,
        }

    # One background reader per pipe, so a slow stderr can't backpressure stdout
    # and vice versa. Each reader appends to its own buffer AND fires on_chunk.
    stdout_buf: list[str] = []
    stderr_buf: list[str] = []

    def _reader(stream, name: str, buf: list[str]) -> None:
        try:
            for raw in iter(stream.readline, b""):
                text = raw.decode("utf-8", errors="replace")
                buf.append(text)
                if on_chunk is not None:
                    try:
                        on_chunk(name, text)
                    except Exception:
                        pass  # a buggy sink must not kill the reader
        finally:
            try:
                stream.close()
            except OSError:
                pass

    threads = [
        threading.Thread(target=_reader, args=(proc.stdout, "stdout", stdout_buf), daemon=True, name="har-stdout"),
        threading.Thread(target=_reader, args=(proc.stderr, "stderr", stderr_buf), daemon=True, name="har-stderr"),
    ]
    for t in threads:
        t.start()

    timed_out = False
    try:
        proc.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_process_tree(proc.pid)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass

    for t in threads:
        t.join(timeout=3)
    elapsed = time.monotonic() - start

    stdout = "".join(stdout_buf)[-_OUTPUT_TAIL_BYTES:]
    stderr = "".join(stderr_buf)[-_OUTPUT_TAIL_BYTES:]
    if timed_out:
        if stderr and not stderr.endswith("\n"):
            stderr += "\n"
        timeout_note = f"[har] Script exceeded {timeout_seconds:g}s and was terminated.\n"
        stderr += timeout_note
        if on_chunk is not None:
            try:
                on_chunk("stderr", timeout_note)
            except Exception:
                pass

    return {
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": proc.returncode,
        "timed_out": timed_out,
        "execute_seconds": elapsed,
    }


def _kill_process_tree(pid: int) -> None:
    """Kill `pid` and every descendant atomically — not best-effort.

    Walking `psutil.children(recursive=True)` has a race: a grandchild being spawned
    while we iterate escapes the kill list and is reparented to init. We avoid that by
    signalling the entire process group on POSIX (which `start_new_session=True` set up
    at Popen time) and by using `taskkill /F /T` on Windows, both of which the OS
    guarantees to deliver to every descendant atomically.
    """

    if os.name == "nt":
        # `/F` = force, `/T` = tree. Guaranteed descendant kill by the OS.
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            pass
        return

    # POSIX: Popen was started with start_new_session=True, so pid is a process-group
    # leader. SIGKILL on the group reaches every descendant whether they were spawned
    # before or after we started iterating.
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        return
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass

    # Belt-and-braces: wait briefly, then re-sweep via psutil in case a grandchild
    # managed to escape the group (shouldn't happen with setsid, but doesn't hurt).
    try:
        parent = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return
    try:
        descendants = parent.children(recursive=True)
    except psutil.NoSuchProcess:
        descendants = []
    psutil.wait_procs([parent, *descendants], timeout=3)
    for proc in [parent, *descendants]:
        try:
            if proc.is_running():
                proc.kill()
        except psutil.NoSuchProcess:
            pass

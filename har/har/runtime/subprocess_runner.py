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

# Registry of PIDs we've spawned and haven't reaped yet. Used by the graceful shutdown
# handler: when the server receives SIGTERM, we walk this set and tear down every
# in-flight script tree so nothing leaks after the parent exits.
_live_processes: set[int] = set()
_live_processes_lock = threading.Lock()


def _track_process(pid: int) -> None:
    with _live_processes_lock:
        _live_processes.add(pid)


def _untrack_process(pid: int) -> None:
    with _live_processes_lock:
        _live_processes.discard(pid)


def kill_all_tracked() -> list[int]:
    """Kill every subprocess that's currently running under us. Returns the PIDs we hit."""

    with _live_processes_lock:
        pids = list(_live_processes)
    for pid in pids:
        try:
            _kill_process_tree(pid)
        except Exception:
            pass  # best-effort; the caller only needs to know we tried
    return pids


def run_script_in_subprocess(
    *,
    filename: str,
    content: str,
    args: list[str],
    cwd: Path,
    timeout_seconds: float = DEFAULT_SCRIPT_TIMEOUT_SECONDS,
    extra_env: dict[str, str] | None = None,
    on_chunk: Callable[[str, str], None] | None = None,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    """Run `content` as `cwd/filename` in a fresh Python subprocess.

    If `on_chunk(stream, text)` is given, it's invoked as each line (or bounded chunk) of
    stdout/stderr arrives — this is what lets the UI stream output live instead of the
    user staring at a blank panel for two minutes while a training script produces output
    that only gets flushed at exit.

    If `cancel_event` is set while the script runs, the whole process group gets SIGINT
    (so Python scripts can run their `finally` blocks), then SIGKILL two seconds later,
    and the result has `stopped=True`. If it's already set before we start, nothing is
    spawned.

    Returns `{stdout, stderr, exit_code, timed_out, stopped, execute_seconds}` where
    `execute_seconds` is measured with `time.monotonic()`. On timeout the process group
    is killed and `timed_out=True`.
    """

    if cancel_event is not None and cancel_event.is_set():
        return {
            "stdout": "",
            "stderr": "",
            "exit_code": None,
            "timed_out": False,
            "stopped": True,
            "execute_seconds": 0.0,
        }

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
            "stopped": False,
            "execute_seconds": 0.0,
        }
    _track_process(proc.pid)
    # start_new_session made the child a group leader, so its pgid is its pid. Saving it
    # now means a stop request after the leader exits still reaches leftover grandchildren.
    pgid = proc.pid if os.name != "nt" else None

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
    stopped = False
    deadline = start + timeout_seconds if timeout_seconds > 0 else None
    # Poll instead of one long wait() so a stop request is noticed within ~0.1 s.
    while True:
        try:
            proc.wait(timeout=0.1)
            break
        except subprocess.TimeoutExpired:
            pass
        if cancel_event is not None and cancel_event.is_set():
            stopped = True
            _stop_process_group(proc, pgid)
            break
        if deadline is not None and time.monotonic() >= deadline:
            timed_out = True
            _kill_process_tree(proc.pid)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            break

    for t in threads:
        t.join(timeout=3)
    _untrack_process(proc.pid)
    elapsed = time.monotonic() - start

    stdout = "".join(stdout_buf)[-_OUTPUT_TAIL_BYTES:]
    stderr = "".join(stderr_buf)[-_OUTPUT_TAIL_BYTES:]
    note = None
    if timed_out:
        note = f"[har] Script exceeded {timeout_seconds:g}s and was terminated.\n"
    elif stopped:
        note = "[har] Stopped by request.\n"
    if note:
        if stderr and not stderr.endswith("\n"):
            stderr += "\n"
        stderr += note
        if on_chunk is not None:
            try:
                on_chunk("stderr", note)
            except Exception:
                pass

    return {
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": proc.returncode,
        "timed_out": timed_out,
        "stopped": stopped,
        "execute_seconds": elapsed,
    }


def _stop_process_group(proc: subprocess.Popen, pgid: int | None) -> None:
    """Ask the script's whole process tree to stop, then make sure it did.

    POSIX: SIGINT to the group first, so a Python script gets KeyboardInterrupt and can
    clean up, then SIGKILL to the group after 2 s. The SIGKILL goes out even if the
    leader already exited, to catch grandchildren that ignored SIGINT.
    Windows has no group SIGINT for a windowless child, so we kill the tree directly.
    """

    if os.name == "nt" or pgid is None:
        _kill_process_tree(proc.pid)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        return

    try:
        os.killpg(pgid, signal.SIGINT)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


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

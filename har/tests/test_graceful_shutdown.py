"""Tests for the SIGTERM-triggered cleanup path."""

import threading

from har.runtime import graceful_shutdown, subprocess_runner


def test_on_shutdown_callback_registration():
    marker: list[str] = []
    graceful_shutdown.on_shutdown(lambda: marker.append("ran"))
    # Fire by calling the registered callbacks ourselves (we don't want to install a FastAPI
    # app purely for this unit test; the install path is exercised by the API tests below).
    for cb in graceful_shutdown._on_shutdown_callbacks:
        cb()
    assert "ran" in marker


def test_kill_all_tracked_is_safe_when_empty():
    with subprocess_runner._live_processes_lock:
        subprocess_runner._live_processes.clear()
    killed = subprocess_runner.kill_all_tracked()
    assert killed == []


def test_kill_all_tracked_returns_registered_pids(monkeypatch):
    # Register a fake PID without actually spawning anything, and stub _kill_process_tree
    # so the test doesn't blow up on a signal to a random pid.
    called_with: list[int] = []
    monkeypatch.setattr(subprocess_runner, "_kill_process_tree", lambda pid: called_with.append(pid))
    with subprocess_runner._live_processes_lock:
        subprocess_runner._live_processes.clear()
        subprocess_runner._live_processes.update({42, 43})

    killed = subprocess_runner.kill_all_tracked()
    assert set(killed) == {42, 43}
    assert set(called_with) == {42, 43}

"""Clean SIGTERM handling: kill in-flight subprocesses + fail in-flight records + let uvicorn drain.

The idle watchdog I added sends SIGTERM to the process after N minutes of inactivity.
Without this module, uvicorn's default handler would stop accepting connections and exit
immediately — leaking any script subprocess that happens to be mid-wait and leaving its
ScriptRecord stuck in `"running"` forever. That shows up as orphan python processes on
the user's machine plus "scripts stuck running" entries in the UI history.

What we do here:
1. On FastAPI's shutdown lifespan event (triggered by SIGTERM), fire the registered
   shutdown callbacks — these walk `_script_runs` / `_runs` on both host and worker
   and mark anything still `"queued"` / `"running"` as failed with a clear reason.
2. Kill every subprocess the runner has tracked so their pipe-reader threads unblock
   immediately and we don't hold the process table open.
3. Return control to uvicorn so it can finish draining sockets normally.

We intentionally do NOT install a signal.signal() handler — uvicorn owns the signal
handling in its own main loop, and racing it leads to deadlocks. The FastAPI shutdown
event is the sanctioned extension point for this exact scenario.
"""

from __future__ import annotations

import logging
from collections.abc import Callable


_logger = logging.getLogger("har.shutdown")
_on_shutdown_callbacks: list[Callable[[], None]] = []
_installed_apps: set[int] = set()


def on_shutdown(callback: Callable[[], None]) -> None:
    """Register a callback to run during graceful shutdown. Order of registration is the order of execution."""

    _on_shutdown_callbacks.append(callback)


def install(app) -> None:
    """Wire the shutdown hook to a FastAPI app's lifespan.

    Idempotent — calling it twice on the same app has no effect. Each app gets exactly
    one shutdown handler registered that runs every callback in `_on_shutdown_callbacks`.
    """

    app_id = id(app)
    if app_id in _installed_apps:
        return
    _installed_apps.add(app_id)

    @app.on_event("shutdown")
    async def _graceful() -> None:
        _logger.warning("graceful shutdown: running %d cleanup callbacks", len(_on_shutdown_callbacks))
        for cb in _on_shutdown_callbacks:
            try:
                cb()
            except Exception as exc:
                _logger.exception("shutdown callback raised: %s", exc)

        # Kill any still-running subprocesses so their pipe-reader threads unblock
        # immediately. Without this, `proc.wait()` on an infinite-loop script would
        # hang uvicorn's shutdown indefinitely.
        try:
            from .subprocess_runner import kill_all_tracked
            killed = kill_all_tracked()
            if killed:
                _logger.warning("killed %d in-flight subprocess tree(s) during shutdown: %s", len(killed), killed)
        except Exception:
            _logger.exception("failed to tear down tracked subprocesses")

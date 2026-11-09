"""Idle watchdog: exits the server if there's no HTTP activity for a configurable window.

Prevents orphaned har-runtime-server processes from pinning ports 8000/9000 forever when
the Tauri window gets closed abruptly, when someone starts the service by hand for a quick
test, or when a crash loop leaves a zombie Python interpreter alive.

Behaviour:
- Reads `HAR_IDLE_TIMEOUT_SECONDS` from the environment; default 3600 (one hour).
- Zero or negative disables the watchdog entirely — useful for tests and long-running
  workers where the operator wants manual control.
- Health checks (`/api/health`, `/worker/health`) DO NOT count as activity. A load
  balancer or UI poller hitting /health every 3 s would otherwise keep a truly-idle
  server alive forever.
- If any job is `queued` or `running`, the watchdog refuses to shut down and resets
  its own clock. Long-running training scripts aren't killed under the user.
- Exit is a SIGTERM to the current PID so uvicorn can shut down cleanly (close sockets,
  flush logs, release resources), not an abrupt `os._exit`.
"""

from __future__ import annotations

import logging
import os
import signal
import threading
import time
from collections.abc import Callable


DEFAULT_IDLE_TIMEOUT_SECONDS = 3600.0  # one hour
_HEALTH_PATH_SUFFIXES = ("/health",)

_logger = logging.getLogger("har.idle")


class IdleWatchdog:
    """Tracks last HTTP activity and shuts the process down when idle too long."""

    def __init__(
        self,
        *,
        timeout_seconds: float = DEFAULT_IDLE_TIMEOUT_SECONDS,
        has_active_work: Callable[[], bool] | None = None,
        exit_fn: Callable[[], None] | None = None,
    ) -> None:
        self.timeout_seconds = float(timeout_seconds)
        self.has_active_work = has_active_work or (lambda: False)
        self._exit_fn = exit_fn or self._default_exit
        self._lock = threading.Lock()
        self._last_activity_monotonic = time.monotonic()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    @property
    def enabled(self) -> bool:
        return self.timeout_seconds > 0

    def touch(self) -> None:
        """Mark the server as busy right now."""

        with self._lock:
            self._last_activity_monotonic = time.monotonic()

    def idle_for(self) -> float:
        """Seconds since the last recorded activity."""

        with self._lock:
            return time.monotonic() - self._last_activity_monotonic

    def start(self) -> None:
        if not self.enabled:
            _logger.info("idle watchdog disabled (HAR_IDLE_TIMEOUT_SECONDS=%s)", self.timeout_seconds)
            return
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, daemon=True, name="har-idle-watchdog")
        self._thread.start()
        _logger.info("idle watchdog started; threshold=%.0fs", self.timeout_seconds)

    def stop(self) -> None:
        self._stop.set()

    def _default_exit(self) -> None:
        # SIGTERM gives uvicorn a chance to drain + close sockets cleanly; os._exit would skip that.
        os.kill(os.getpid(), signal.SIGTERM)

    def _run(self) -> None:
        # Tick more often than the full timeout so we react within a minute or so of going idle.
        # Floor at 50 ms so tests with sub-second timeouts can still exercise this path; cap at
        # 60 s so a long-idle 1-hour watchdog isn't burning CPU polling every second.
        tick = min(60.0, max(0.05, self.timeout_seconds / 10))
        while not self._stop.wait(tick):
            idle = self.idle_for()
            if idle < self.timeout_seconds:
                continue
            if self.has_active_work():
                self.touch()  # jobs still in flight — reset the clock, come back next tick
                continue
            _logger.warning(
                "no HTTP activity for %.0fs (threshold=%.0fs); shutting down to free the port",
                idle,
                self.timeout_seconds,
            )
            self._exit_fn()
            return


def _read_timeout_from_env() -> float:
    try:
        return float(os.getenv("HAR_IDLE_TIMEOUT_SECONDS", DEFAULT_IDLE_TIMEOUT_SECONDS))
    except (TypeError, ValueError):
        return DEFAULT_IDLE_TIMEOUT_SECONDS


def install(app, *, has_active_work: Callable[[], bool] | None = None) -> IdleWatchdog:
    """Attach the watchdog middleware to `app` and start the background thread."""

    watchdog = IdleWatchdog(timeout_seconds=_read_timeout_from_env(), has_active_work=has_active_work)

    @app.middleware("http")
    async def _idle_middleware(request, call_next):
        path = request.url.path
        # Health checks don't count as activity — see module docstring.
        if not any(path.endswith(suffix) for suffix in _HEALTH_PATH_SUFFIXES):
            watchdog.touch()
        return await call_next(request)

    watchdog.start()
    return watchdog

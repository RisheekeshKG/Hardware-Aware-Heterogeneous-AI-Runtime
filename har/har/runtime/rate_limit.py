"""Per-IP rate limiter for job submission endpoints.

Prevents a buggy loop or a malicious actor on the LAN from spamming `POST /api/scripts`
(or `POST /worker/scripts`) to OOM the host. Writes stay fast — one dict access, one
timestamp append, one trim — but refuse requests over the cap with a clean 429.

Configuration:
- `HAR_RATE_LIMIT_PER_MIN`     default 10  (0 disables; -1 keeps the default)
- `HAR_RATE_LIMIT_WINDOW_SECONDS` default 60

Only `POST` requests on explicitly-registered paths are limited; GET/polling traffic is
untouched because the UI polls `/api/scripts` every 3 s and we don't want to 429 that.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import deque
from collections.abc import Iterable


_logger = logging.getLogger("har.rate_limit")

_DEFAULT_PER_MIN = 10
_DEFAULT_WINDOW_SECONDS = 60.0


def _read_env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _read_env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


class RateLimiter:
    """Sliding-window counter: last `window_seconds` of timestamps per client IP."""

    def __init__(
        self,
        *,
        limit: int = _DEFAULT_PER_MIN,
        window_seconds: float = _DEFAULT_WINDOW_SECONDS,
    ) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._lock = threading.Lock()
        self._buckets: dict[str, deque[float]] = {}

    @property
    def enabled(self) -> bool:
        return self.limit > 0

    def take(self, client: str) -> tuple[bool, int, float]:
        """Record an attempt from `client`. Returns (allowed, remaining, retry_after_seconds)."""

        if not self.enabled:
            return True, -1, 0.0
        now = time.monotonic()
        with self._lock:
            bucket = self._buckets.setdefault(client, deque())
            # Drop timestamps older than the window.
            threshold = now - self.window_seconds
            while bucket and bucket[0] < threshold:
                bucket.popleft()
            if len(bucket) >= self.limit:
                # Oldest timestamp decides when the first slot frees up.
                retry_after = max(0.0, (bucket[0] + self.window_seconds) - now)
                return False, 0, retry_after
            bucket.append(now)
            remaining = self.limit - len(bucket)
            return True, remaining, 0.0


def install(app, *, limited_paths: Iterable[str], methods: Iterable[str] = ("POST",)) -> RateLimiter:
    """Attach a rate-limiting middleware to `app`.

    Only requests matching `methods` on paths in `limited_paths` are counted. Everything
    else passes through unmetered — polling / health checks / status reads stay cheap.
    """

    limiter = RateLimiter(
        limit=_read_env_int("HAR_RATE_LIMIT_PER_MIN", _DEFAULT_PER_MIN),
        window_seconds=_read_env_float("HAR_RATE_LIMIT_WINDOW_SECONDS", _DEFAULT_WINDOW_SECONDS),
    )
    if not limiter.enabled:
        _logger.info("rate limiter disabled (HAR_RATE_LIMIT_PER_MIN=%d)", limiter.limit)
        return limiter

    paths = {path.rstrip("/") for path in limited_paths}
    methods_upper = {m.upper() for m in methods}
    _logger.info(
        "rate limiter: %d requests / %.0fs on %s %s",
        limiter.limit, limiter.window_seconds, sorted(methods_upper), sorted(paths),
    )

    from fastapi.responses import JSONResponse

    @app.middleware("http")
    async def _limit_middleware(request, call_next):
        if request.method not in methods_upper:
            return await call_next(request)
        normalised_path = request.url.path.rstrip("/")
        if normalised_path not in paths:
            return await call_next(request)
        client = request.client.host if request.client else "unknown"
        allowed, remaining, retry_after = limiter.take(client)
        if not allowed:
            headers = {
                "Retry-After": str(int(retry_after) + 1),
                "X-RateLimit-Limit": str(limiter.limit),
                "X-RateLimit-Remaining": "0",
            }
            return JSONResponse(
                status_code=429,
                content={
                    "detail": f"Too many requests. Try again in {int(retry_after) + 1}s.",
                    "limit_per_window": limiter.limit,
                    "window_seconds": int(limiter.window_seconds),
                },
                headers=headers,
            )
        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(limiter.limit)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        return response

    return limiter

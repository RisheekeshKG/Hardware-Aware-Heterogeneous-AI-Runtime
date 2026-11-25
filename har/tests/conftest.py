"""Shared fixtures."""

import pytest


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    """Each test starts with empty rate-limit buckets.

    All TestClient requests come from the same "testclient" address, so without this the
    suite as a whole trips the 10-scripts-per-minute limit once enough tests submit scripts.
    """

    from har.runtime import worker
    from har.runtime.api import core

    for limiter in (core._rate_limiter, worker._rate_limiter):
        with limiter._lock:
            limiter._buckets.clear()
    yield

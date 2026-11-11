"""Tests for the per-IP rate limiter."""

from har.runtime.rate_limit import RateLimiter


def test_rate_limiter_disabled_when_limit_zero():
    limiter = RateLimiter(limit=0, window_seconds=60)
    assert limiter.enabled is False
    allowed, remaining, retry_after = limiter.take("1.2.3.4")
    assert allowed is True
    assert remaining == -1
    assert retry_after == 0.0


def test_rate_limiter_counts_per_ip():
    limiter = RateLimiter(limit=3, window_seconds=60)
    for i in range(3):
        allowed, remaining, retry = limiter.take("10.0.0.1")
        assert allowed is True
        assert remaining == 2 - i
    allowed, remaining, retry = limiter.take("10.0.0.1")
    assert allowed is False
    assert remaining == 0
    assert retry > 0


def test_rate_limiter_isolates_ips():
    limiter = RateLimiter(limit=1, window_seconds=60)
    allowed, _, _ = limiter.take("10.0.0.1")
    assert allowed is True
    allowed, _, _ = limiter.take("10.0.0.1")
    assert allowed is False
    # A different IP has its own bucket.
    allowed, _, _ = limiter.take("10.0.0.2")
    assert allowed is True


def test_rate_limiter_window_expiry_releases_slots(monkeypatch):
    """Simulated time: after the window passes, old timestamps are dropped."""

    import har.runtime.rate_limit as mod

    now = [1000.0]
    monkeypatch.setattr(mod.time, "monotonic", lambda: now[0])

    limiter = mod.RateLimiter(limit=2, window_seconds=5.0)
    assert limiter.take("x")[0] is True
    assert limiter.take("x")[0] is True
    assert limiter.take("x")[0] is False  # full

    now[0] += 6.0  # jump past the window
    assert limiter.take("x")[0] is True, "oldest timestamp should have fallen out of the window"

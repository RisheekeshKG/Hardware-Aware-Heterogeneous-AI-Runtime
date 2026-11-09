"""Tests for the idle watchdog that auto-exits an unused server."""

import time

from har.runtime.idle_shutdown import IdleWatchdog


def test_watchdog_disabled_when_timeout_is_zero():
    watchdog = IdleWatchdog(timeout_seconds=0)
    assert watchdog.enabled is False


def test_touch_resets_idle_clock():
    watchdog = IdleWatchdog(timeout_seconds=3600)
    time.sleep(0.05)
    assert watchdog.idle_for() >= 0.05
    watchdog.touch()
    assert watchdog.idle_for() < 0.01


def test_watchdog_fires_exit_on_timeout_when_no_active_work():
    fired: list[bool] = []
    watchdog = IdleWatchdog(
        timeout_seconds=0.05,              # tiny so the loop trips quickly
        has_active_work=lambda: False,
        exit_fn=lambda: fired.append(True),
    )
    watchdog.start()
    for _ in range(50):                    # wait up to ~2.5 s
        if fired:
            break
        time.sleep(0.05)
    watchdog.stop()
    assert fired, "watchdog should have fired exit after exceeding the idle window"


def test_watchdog_refuses_to_shut_down_while_work_is_running():
    fired: list[bool] = []
    watchdog = IdleWatchdog(
        timeout_seconds=0.05,
        has_active_work=lambda: True,      # pretend a job is forever running
        exit_fn=lambda: fired.append(True),
    )
    watchdog.start()
    time.sleep(0.5)
    watchdog.stop()
    assert not fired, "watchdog must NOT shut down while a job is active, even if idle time elapsed"

"""Tests for the HAR SDK router + calibration cache."""

import tempfile
from pathlib import Path

import pytest

from har.calibration import CalibrationCache
from har.inventory import SdkDevice
from har.router import Router, shape_key


@pytest.fixture
def cache(tmp_path):
    return CalibrationCache(path=tmp_path / "cal.db")


def test_calibration_ewma_blends_successive_samples(cache):
    cache.record("key", "cpu", 1.0)
    assert cache.get("key", "cpu") == pytest.approx(1.0)
    cache.record("key", "cpu", 0.0)
    # EWMA with alpha=0.5: new = 0.5*old + 0.5*sample.
    assert cache.get("key", "cpu") == pytest.approx(0.5)


def test_calibration_keys_are_isolated(cache):
    cache.record("a", "cpu", 1.0)
    cache.record("b", "cpu", 2.0)
    assert cache.get("a", "cpu") == pytest.approx(1.0)
    assert cache.get("b", "cpu") == pytest.approx(2.0)


def test_shape_key_differs_by_argument_shape():
    def fn(x):
        return x

    import torch

    tensor_small = torch.zeros(4, 4)
    tensor_large = torch.zeros(1024, 1024)
    assert shape_key(fn, (tensor_small,), {}) != shape_key(fn, (tensor_large,), {})


def test_router_sticks_on_cold_cache(monkeypatch, cache):
    # Pretend only CPU and MPS exist so the "single available backend" early-return doesn't fire.
    router = Router(cache=cache)
    router._devices = [
        SdkDevice(backend="mps", torch_device="mps", name="Apple MPS", available=True),
        SdkDevice(backend="cpu", torch_device="cpu", name="CPU", available=True),
    ]

    def fn(x):
        return x

    import torch

    decision = router.choose(fn, (torch.zeros(8),), {}, current_backend="cpu")
    # Cold cache → router must stay on the current backend so first call doesn't move data for nothing.
    assert decision.device.backend == "cpu"
    assert "cold" in decision.reason.lower()

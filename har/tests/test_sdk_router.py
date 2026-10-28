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
    router = Router(cache=cache, auto_measure=False)
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


def test_bandwidth_cache_round_trip(cache):
    assert cache.get_bandwidth("cuda") is None
    cache.record_bandwidth("cuda", 15_000_000_000, bytes_sampled=64 * 1024 * 1024)
    assert cache.get_bandwidth("cuda") == pytest.approx(15_000_000_000)


def test_bandwidth_lookup_returns_none_without_measurement(cache):
    """No fallback guesses: `_bandwidth_for` returns None for an unmeasured non-CPU backend."""

    router = Router(cache=cache, auto_measure=False)
    router._devices = [SdkDevice(backend="cpu", torch_device="cpu", name="CPU", available=True)]
    assert router._bandwidth_for("cuda") is None, "unmeasured backend must return None, not a guess"
    assert router._bandwidth_for("cpu") == float("inf"), "CPU is always zero-cost by definition"
    cache.record_bandwidth("cuda", 15_000_000_000, bytes_sampled=64 * 1024 * 1024)
    assert router._bandwidth_for("cuda") == pytest.approx(15_000_000_000)


def test_router_explicit_device_gpu_picks_accelerator(cache):
    """`@offload(device="gpu")` must route to any available accelerator, ignoring the cost model."""

    router = Router(cache=cache, auto_measure=False)
    router._devices = [
        SdkDevice(backend="cuda", torch_device="cuda:0", name="NVIDIA RTX 3050", available=True),
        SdkDevice(backend="cpu", torch_device="cpu", name="CPU", available=True),
    ]

    def fn(x):
        return x

    import torch

    decision = router.choose(fn, (torch.zeros(8),), {}, current_backend="cpu", prefer="gpu")
    assert decision.device.backend == "cuda"
    assert "prefer=gpu" in decision.reason


def test_router_explicit_device_cpu_pins_cpu(cache):
    """`@offload(device="cpu")` must always run on CPU even when a GPU looks cheaper."""

    router = Router(cache=cache, auto_measure=False)
    router._devices = [
        SdkDevice(backend="mps", torch_device="mps", name="Apple MPS", available=True),
        SdkDevice(backend="cpu", torch_device="cpu", name="CPU", available=True),
    ]

    def fn(x):
        return x

    import torch

    key = shape_key(fn, (torch.zeros(2048, 2048),), {})
    cache.record(key, "mps", 0.025)
    cache.record(key, "cpu", 0.180)

    decision = router.choose(fn, (torch.zeros(2048, 2048),), {}, current_backend="cpu", prefer="cpu")
    assert decision.device.backend == "cpu", "device=cpu must pin CPU even when MPS wins the cost model"


def test_router_no_measured_bandwidth_falls_back_to_cpu(cache):
    """Without a bandwidth measurement for the cheaper device, the router must NOT guess —
    it should route to CPU, which has a known zero transfer cost."""

    router = Router(cache=cache, auto_measure=False)
    router._devices = [
        SdkDevice(backend="mps", torch_device="mps", name="Apple MPS", available=True),
        SdkDevice(backend="cpu", torch_device="cpu", name="CPU", available=True),
    ]

    def fn(x):
        return x

    import torch

    key = shape_key(fn, (torch.zeros(2048, 2048),), {})
    # MPS looks cheaper on compute, but we have no measured bandwidth for it.
    cache.record(key, "mps", 0.025)
    cache.record(key, "cpu", 0.180)

    decision = router.choose(fn, (torch.zeros(2048, 2048),), {}, current_backend="cpu")
    assert decision.device.backend == "cpu", "no bandwidth measurement → stay on CPU, don't guess"


def test_router_init_measures_once_and_caches(monkeypatch, cache):
    """`auto_measure=True` must measure every non-CPU available backend exactly once; subsequent Routers
    built against the same cache must NOT re-measure (the cache has it)."""

    calls: list[str] = []

    def fake_measure(device, mb=64):
        calls.append(device.backend)
        return 7_777_777_777.0

    monkeypatch.setattr("har.router.measure_bandwidth", fake_measure)

    class FakeInv:
        value = [
            SdkDevice(backend="mps", torch_device="mps", name="Apple MPS", available=True),
            SdkDevice(backend="cpu", torch_device="cpu", name="CPU", available=True),
        ]

    monkeypatch.setattr("har.router.list_devices", lambda: FakeInv.value)

    first = Router(cache=cache)
    assert calls == ["mps"], "first Router init should measure once per non-CPU device"
    assert cache.get_bandwidth("mps") == pytest.approx(7_777_777_777.0)
    assert cache.get_bandwidth("cpu") is None, "cpu is not measured — bandwidth is infinite by definition"

    calls.clear()
    _ = Router(cache=cache)
    assert calls == [], "second Router with same cache must NOT re-measure"

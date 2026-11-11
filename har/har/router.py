"""Picks which device runs a given call. v1: measured latency with a transfer-cost adjustment."""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Any, Callable

import torch

from .calibration import CalibrationCache
from .inventory import SdkDevice, devices as list_devices


# Devices that count as a GPU-class accelerator for `@har.offload(device="gpu")`. CPU is
# never in this set — the preference "gpu" explicitly means "any accelerator, else CPU."
_GPU_BACKENDS = {"cuda", "mps", "directml", "xpu", "rocm"}


def _sync(torch_device) -> None:
    """Backend-aware barrier so bandwidth timing isn't short-circuited by asynchronous queueing."""

    import torch

    if torch_device.type == "cuda":
        torch.cuda.synchronize()
    elif torch_device.type == "mps":
        torch.mps.synchronize()


def measure_bandwidth(device: SdkDevice, mb: int = 64) -> float:
    """Return actual host↔device bytes/sec for `device`, measured on this machine.

    Moves an `mb`-megabyte float32 tensor to the device repeatedly after a warm-up and times it.
    Called once per machine per backend; the result is cached in `calibration.db`'s `bandwidth`
    table so subsequent process starts don't re-pay the measurement.
    """

    import torch

    if device.backend == "cpu":
        return float("inf")

    torch_device = torch.device(device.torch_device)
    numel = (mb * 1024 * 1024) // 4   # float32
    source = torch.zeros(numel, dtype=torch.float32)
    bytes_per_move = source.element_size() * source.numel()

    # Warm-up: first copy pays for CUDA context init, Metal kernel JIT, driver page-table setup, etc.
    for _ in range(3):
        moved = source.to(torch_device, non_blocking=False)
        _sync(torch_device)
        del moved

    iterations = 5
    start = time.perf_counter()
    for _ in range(iterations):
        moved = source.to(torch_device, non_blocking=False)
        _sync(torch_device)
        del moved
    elapsed = time.perf_counter() - start
    return (iterations * bytes_per_move) / elapsed if elapsed > 0 else float("inf")


@dataclass
class RouteDecision:
    device: SdkDevice
    reason: str
    estimated_seconds: float | None
    transfer_bytes: int


def _tensor_bytes(obj: Any) -> int:
    if isinstance(obj, torch.Tensor):
        return obj.element_size() * obj.numel()
    if isinstance(obj, (list, tuple)):
        return sum(_tensor_bytes(item) for item in obj)
    if isinstance(obj, dict):
        return sum(_tensor_bytes(value) for value in obj.values())
    return 0


def _shape_fingerprint(obj: Any) -> str:
    if isinstance(obj, torch.Tensor):
        return f"T({tuple(obj.shape)},{obj.dtype})"
    if isinstance(obj, (list, tuple)):
        inner = ",".join(_shape_fingerprint(item) for item in obj[:8])
        return f"L[{inner}]{len(obj)}"
    if isinstance(obj, dict):
        inner = ",".join(f"{k}:{_shape_fingerprint(v)}" for k, v in list(obj.items())[:8])
        return f"D{{{inner}}}"
    return type(obj).__name__


def shape_key(fn: Callable[..., Any], args: tuple[Any, ...], kwargs: dict[str, Any]) -> str:
    payload = "|".join(
        [
            f"{fn.__module__}.{fn.__qualname__}",
            ",".join(_shape_fingerprint(arg) for arg in args),
            ",".join(f"{k}={_shape_fingerprint(v)}" for k, v in sorted(kwargs.items())),
        ]
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


class Router:
    """Decides which device executes a call based on past measurements plus a transfer-cost term.

    When no measurement exists for a backend, the router proposes it anyway so the executor measures
    once and records a sample. Over a few calls per shape, the cache fills in and the choice stabilizes.
    """

    def __init__(self, cache: CalibrationCache | None = None, hysteresis: float = 0.10, auto_measure: bool = True) -> None:
        self.cache = cache or CalibrationCache()
        self.hysteresis = hysteresis
        self._devices = list_devices()
        if auto_measure:
            self._ensure_bandwidths()

    def _ensure_bandwidths(self) -> None:
        """Measure every available non-CPU backend once; skip if we already have a cached value."""

        for device in self._devices:
            if not device.available or device.backend == "cpu":
                continue
            if self.cache.get_bandwidth(device.backend) is not None:
                continue
            try:
                bps = measure_bandwidth(device)
                self.cache.record_bandwidth(device.backend, bps, bytes_sampled=64 * 1024 * 1024)
            except Exception:
                # Hardware unreachable mid-measurement or torch misbehaving on this backend —
                # don't crash the router; the fallback dict will cover this backend.
                pass

    def _bandwidth_for(self, backend: str) -> float | None:
        """Measured bytes/sec for this backend on this machine, or None if we have no measurement.

        No fallback guesses — "I don't know" is a legitimate answer. The caller treats a `None` as
        "don't route cold cost comparisons here" so CPU stays the safe default when we're unsure.
        """

        if backend == "cpu":
            return float("inf")  # data already lives in CPU RAM; transfer is zero
        measured = self.cache.get_bandwidth(backend)
        if measured is not None and measured > 0:
            return measured
        return None

    def _cpu_device(self, candidates: list[SdkDevice]) -> SdkDevice:
        return next((d for d in candidates if d.backend == "cpu"), candidates[-1])

    def _pick_preferred(self, prefer: str, candidates: list[SdkDevice]) -> SdkDevice | None:
        """Return a device matching the explicit user preference, or None if it isn't available."""

        prefer = prefer.lower()
        if prefer in {"auto", ""}:
            return None  # fall through to the cost model
        if prefer == "cpu":
            return self._cpu_device(candidates)
        if prefer == "gpu":
            return next((d for d in candidates if d.backend in _GPU_BACKENDS), None)
        # Explicit backend name — must match exactly.
        return next((d for d in candidates if d.backend == prefer), None)

    @property
    def available(self) -> list[SdkDevice]:
        return [device for device in self._devices if device.available]

    def choose(
        self,
        fn: Callable[..., Any],
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
        current_backend: str = "cpu",
        prefer: str | None = None,
    ) -> RouteDecision:
        key = shape_key(fn, args, kwargs)
        bytes_moved = _tensor_bytes(args) + _tensor_bytes(kwargs)
        candidates = self.available

        # No accelerators present → CPU, no question.
        if len(candidates) == 1:
            return RouteDecision(candidates[0], "only backend available", None, 0)

        # Explicit user preference overrides everything else — this is `@offload(device="gpu")`
        # style directive from the caller, and the router should honour it instead of guessing.
        if prefer:
            picked = self._pick_preferred(prefer, candidates)
            if picked is not None:
                moved = bytes_moved if picked.backend != current_backend else 0
                return RouteDecision(picked, f"user prefer={prefer}", None, moved)
            # Preference didn't match any available backend. Explicit miss, caller probably has a
            # typo or the hardware changed; fall through to the cost model as a soft fallback.

        measured = self.cache.all_for(key)
        if not measured:
            # Cold shape: default to the current device so we don't move data for nothing on the first
            # call. Executor will record a sample; next call sees the measurement and may switch.
            cold = next((device for device in candidates if device.backend == current_backend), candidates[-1])
            return RouteDecision(cold, "cold cache; measuring on current device", None, 0)

        # Score each candidate: measured compute + estimated transfer if we'd move data to it.
        best: tuple[SdkDevice, float] | None = None
        for device in candidates:
            compute = measured.get(device.backend)
            if compute is None:
                # Backend never measured for this shape — propose it so the executor measures once.
                return RouteDecision(device, f"never measured on {device.backend}; sampling", None, bytes_moved if device.backend != current_backend else 0)
            transfer = 0.0
            if device.backend != current_backend:
                bandwidth = self._bandwidth_for(device.backend)
                if bandwidth is None:
                    # Honest "I don't know." Rather than guessing with a hardcoded number that
                    # happens to be wrong on half the hardware, we exclude this device from the
                    # cost comparison. CPU stays as the backstop; the executor will measure
                    # this backend's bandwidth on the next call via `_ensure_bandwidths`.
                    continue
                transfer = bytes_moved / bandwidth
            total = compute + transfer
            if best is None or total < best[1]:
                best = (device, total)

        if best is None:
            # No measured bandwidth AND no device matching current_backend had compute — degrade
            # to CPU rather than guess.
            return RouteDecision(self._cpu_device(candidates), "no measured bandwidth; defaulting to CPU", None, 0)

        chosen, chosen_cost = best
        # Hysteresis: if we're already on another device, only switch when the win is big enough.
        if chosen.backend != current_backend:
            current_compute = measured.get(current_backend)
            if current_compute is not None and chosen_cost > current_compute * (1 - self.hysteresis):
                keep = next((device for device in candidates if device.backend == current_backend), chosen)
                return RouteDecision(keep, "staying put; win below hysteresis", current_compute, 0)

        return RouteDecision(chosen, "cheapest measured option", chosen_cost, bytes_moved if chosen.backend != current_backend else 0)

    def record(self, shape_key_: str, backend: str, seconds: float) -> None:
        self.cache.record(shape_key_, backend, seconds)

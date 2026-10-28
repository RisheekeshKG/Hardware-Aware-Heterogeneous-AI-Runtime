"""Picks which device runs a given call. v1: measured latency with a transfer-cost adjustment."""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Any, Callable

import torch

from .calibration import CalibrationCache
from .inventory import SdkDevice, devices as list_devices


# Rough one-way host<->device transfer bandwidth, in bytes/sec. Local PCIe/UMA is fast enough that we
# treat it as free compared to compute for most workloads, so we use conservative-but-not-zero numbers.
_LOCAL_TRANSFER_BPS = {
    "cuda": 12_000_000_000,  # ~12 GB/s PCIe 3/4 effective
    "mps":  40_000_000_000,  # ~40 GB/s unified memory
    "cpu":  float("inf"),
}


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

    def __init__(self, cache: CalibrationCache | None = None, hysteresis: float = 0.10) -> None:
        self.cache = cache or CalibrationCache()
        self.hysteresis = hysteresis
        self._devices = list_devices()

    @property
    def available(self) -> list[SdkDevice]:
        return [device for device in self._devices if device.available]

    def choose(
        self,
        fn: Callable[..., Any],
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
        current_backend: str = "cpu",
    ) -> RouteDecision:
        key = shape_key(fn, args, kwargs)
        bytes_moved = _tensor_bytes(args) + _tensor_bytes(kwargs)
        candidates = self.available

        # No accelerators present → CPU, no question.
        if len(candidates) == 1:
            return RouteDecision(candidates[0], "only backend available", None, 0)

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
                bandwidth = _LOCAL_TRANSFER_BPS.get(device.backend, 1_000_000_000)
                transfer = bytes_moved / bandwidth if bandwidth else 0.0
            total = compute + transfer
            if best is None or total < best[1]:
                best = (device, total)

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

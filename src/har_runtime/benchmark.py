"""Repeatable matrix multiplication benchmark."""

from __future__ import annotations

import statistics
import time
from collections.abc import Callable

import torch

from .devices import get_device_info, synchronize
from .models import BenchmarkResult


def _summary(samples: list[float]) -> dict[str, float]:
    return {
        "mean": statistics.mean(samples),
        "median": statistics.median(samples),
        "min": min(samples),
        "max": max(samples),
        "stdev": statistics.stdev(samples) if len(samples) > 1 else 0.0,
    }


def _throughput(size: int, seconds: float) -> float:
    # A one-sample run has a zero standard deviation; preserve that statistic
    # while keeping the derived throughput finite.
    return (2.0 * size**3 / max(seconds, 1e-9)) / 1e12


def run_matmul(
    *,
    size: int,
    backend: str,
    warmup_iterations: int = 3,
    measured_iterations: int = 10,
    seed: int = 42,
    dtype: torch.dtype = torch.float32,
    atol: float = 1e-3,
    rtol: float = 1e-3,
    progress_callback: Callable[[int, int, float], None] | None = None,
) -> BenchmarkResult:
    """Run a square matmul and return measured samples plus device metadata."""

    if size <= 0:
        raise ValueError("size must be greater than zero")
    if warmup_iterations < 0 or measured_iterations <= 0:
        raise ValueError("warmup_iterations must be non-negative and measured_iterations must be positive")

    device_info = get_device_info(backend)
    device = torch.device(device_info.torch_device)
    generator = torch.Generator(device="cpu")
    generator.manual_seed(seed)
    left_cpu = torch.randn((size, size), generator=generator, dtype=dtype)
    right_cpu = torch.randn((size, size), generator=generator, dtype=dtype)
    left = left_cpu.to(device)
    right = right_cpu.to(device)

    for _ in range(warmup_iterations):
        torch.mm(left, right)
    synchronize(backend)

    samples: list[float] = []
    for iteration in range(measured_iterations):
        synchronize(backend)
        start = time.perf_counter_ns()
        result = torch.mm(left, right)
        synchronize(backend)
        elapsed_ns = max(time.perf_counter_ns() - start, 1)
        elapsed_seconds = elapsed_ns / 1e9
        samples.append(elapsed_seconds)
        if progress_callback:
            progress_callback(iteration + 1, measured_iterations, elapsed_seconds)

    expected = torch.mm(left_cpu, right_cpu)
    actual = result.detach().to("cpu")
    correctness_passed = bool(torch.allclose(actual, expected, atol=atol, rtol=rtol))
    if not correctness_passed:
        max_error = (actual - expected).abs().max().item()
        raise RuntimeError(f"Matmul correctness validation failed; max absolute error: {max_error}")

    latency = _summary(samples)
    throughput = {name: _throughput(size, seconds) for name, seconds in latency.items()}
    return BenchmarkResult(
        benchmark="matmul",
        backend=backend,
        device=device_info,
        size=size,
        dtype=str(dtype).replace("torch.", ""),
        warmup_iterations=warmup_iterations,
        measured_iterations=measured_iterations,
        seed=seed,
        correctness_passed=correctness_passed,
        tolerance={"atol": atol, "rtol": rtol},
        latency_seconds=latency,
        throughput_tflops=throughput,
        samples_seconds=samples,
    )

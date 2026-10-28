"""Repeatable matrix multiplication benchmark."""

from __future__ import annotations

import statistics
import time
from collections.abc import Callable

import torch
from torch import nn

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
        workload_config={"size": size},
        metrics={"median_tflops": throughput["median"]},
    )


class _DeterministicImageModel(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(3, 8, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.Conv2d(8, 16, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d((1, 1)),
        )
        self.classifier = nn.Linear(16, 10)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        return self.classifier(self.features(inputs).flatten(1))


def run_image_inference(
    *,
    backend: str,
    batch_size: int = 8,
    image_size: int = 32,
    warmup_iterations: int = 3,
    measured_iterations: int = 10,
    seed: int = 42,
    progress_callback: Callable[[int, int, float], None] | None = None,
) -> BenchmarkResult:
    """Run a deterministic, built-in CNN over generated image tensors."""

    if batch_size <= 0 or image_size <= 0:
        raise ValueError("batch_size and image_size must be greater than zero")
    device_info = get_device_info(backend)
    device = torch.device(device_info.torch_device)
    generator = torch.Generator(device="cpu")
    generator.manual_seed(seed)
    inputs_cpu = torch.randn((batch_size, 3, image_size, image_size), generator=generator)
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(seed)
        model_cpu = _DeterministicImageModel().eval()
    model = _DeterministicImageModel().eval()
    model.load_state_dict(model_cpu.state_dict())
    model.to(device)
    inputs = inputs_cpu.to(device)

    with torch.inference_mode():
        for _ in range(warmup_iterations):
            model(inputs)
        synchronize(backend)
        samples: list[float] = []
        for iteration in range(measured_iterations):
            synchronize(backend)
            start = time.perf_counter_ns()
            output = model(inputs)
            synchronize(backend)
            elapsed = max(time.perf_counter_ns() - start, 1) / 1e9
            samples.append(elapsed)
            if progress_callback:
                progress_callback(iteration + 1, measured_iterations, elapsed)
        expected = model_cpu(inputs_cpu)
    actual = output.detach().to("cpu")
    if not torch.allclose(actual, expected, atol=1e-5, rtol=1e-5):
        raise RuntimeError("Image inference correctness validation failed")
    latency = _summary(samples)
    images_per_second = {name: batch_size / max(seconds, 1e-9) for name, seconds in latency.items()}
    parameter_count = float(sum(parameter.numel() for parameter in model_cpu.parameters()))
    return BenchmarkResult(
        benchmark="image",
        backend=backend,
        device=device_info,
        size=image_size,
        dtype="float32",
        warmup_iterations=warmup_iterations,
        measured_iterations=measured_iterations,
        seed=seed,
        correctness_passed=True,
        tolerance={"atol": 1e-5, "rtol": 1e-5},
        latency_seconds=latency,
        throughput_tflops={},
        samples_seconds=samples,
        workload_config={"batch_size": batch_size, "image_size": image_size, "parameter_count": int(parameter_count)},
        metrics={"median_images_per_second": images_per_second["median"], "parameter_count": parameter_count},
    )


def run_tree_traversal(
    *,
    backend: str,
    depth: int = 12,
    traversal_count: int = 4096,
    warmup_iterations: int = 3,
    measured_iterations: int = 10,
    seed: int = 42,
    progress_callback: Callable[[int, int, float], None] | None = None,
) -> BenchmarkResult:
    """Traverse a deterministic tensor-backed binary tree on the selected device."""

    if depth <= 0 or depth > 20 or traversal_count <= 0:
        raise ValueError("depth must be 1..20 and traversal_count must be greater than zero")
    device_info = get_device_info(backend)
    device = torch.device(device_info.torch_device)
    generator = torch.Generator(device="cpu")
    generator.manual_seed(seed)
    paths_cpu = torch.randint(0, 2, (traversal_count, depth), generator=generator, dtype=torch.int64)
    node_count = 2**(depth + 1) - 1
    values_cpu = torch.linspace(-1.0, 1.0, node_count, dtype=torch.float32)
    paths = paths_cpu.to(device)
    values = values_cpu.to(device)

    def traverse(path_tensor: torch.Tensor, value_tensor: torch.Tensor) -> torch.Tensor:
        indices = torch.zeros(path_tensor.shape[0], dtype=torch.int64, device=path_tensor.device)
        for level in range(depth):
            indices = indices * 2 + path_tensor[:, level] + 1
        return value_tensor[indices].sum()

    for _ in range(warmup_iterations):
        traverse(paths, values)
    synchronize(backend)
    samples: list[float] = []
    for iteration in range(measured_iterations):
        synchronize(backend)
        start = time.perf_counter_ns()
        result = traverse(paths, values)
        synchronize(backend)
        elapsed = max(time.perf_counter_ns() - start, 1) / 1e9
        samples.append(elapsed)
        if progress_callback:
            progress_callback(iteration + 1, measured_iterations, elapsed)
    expected = traverse(paths_cpu, values_cpu)
    if not torch.allclose(result.detach().to("cpu"), expected, atol=1e-5, rtol=1e-5):
        raise RuntimeError("Tree traversal correctness validation failed")
    latency = _summary(samples)
    traversals_per_second = {name: traversal_count / max(seconds, 1e-9) for name, seconds in latency.items()}
    return BenchmarkResult(
        benchmark="tree",
        backend=backend,
        device=device_info,
        size=depth,
        dtype="float32",
        warmup_iterations=warmup_iterations,
        measured_iterations=measured_iterations,
        seed=seed,
        correctness_passed=True,
        tolerance={"atol": 1e-5, "rtol": 1e-5},
        latency_seconds=latency,
        throughput_tflops={},
        samples_seconds=samples,
        workload_config={"depth": depth, "traversal_count": traversal_count, "node_count": node_count},
        metrics={"median_traversals_per_second": traversals_per_second["median"], "node_count": float(node_count)},
    )


def run_workload(
    *,
    workload: str,
    backend: str,
    size: int = 1024,
    batch_size: int = 8,
    image_size: int = 32,
    depth: int = 12,
    traversal_count: int = 4096,
    warmup_iterations: int = 3,
    measured_iterations: int = 10,
    seed: int = 42,
    progress_callback: Callable[[int, int, float], None] | None = None,
) -> BenchmarkResult:
    if workload == "matmul":
        return run_matmul(size=size, backend=backend, warmup_iterations=warmup_iterations, measured_iterations=measured_iterations, seed=seed, progress_callback=progress_callback)
    if workload == "image":
        return run_image_inference(backend=backend, batch_size=batch_size, image_size=image_size, warmup_iterations=warmup_iterations, measured_iterations=measured_iterations, seed=seed, progress_callback=progress_callback)
    if workload == "tree":
        return run_tree_traversal(backend=backend, depth=depth, traversal_count=traversal_count, warmup_iterations=warmup_iterations, measured_iterations=measured_iterations, seed=seed, progress_callback=progress_callback)
    raise ValueError(f"Unknown workload '{workload}'. Choose from: matmul, image, tree")

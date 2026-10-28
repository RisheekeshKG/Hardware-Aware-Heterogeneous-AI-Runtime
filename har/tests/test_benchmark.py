import pytest
import torch

from har.runtime.benchmark import run_matmul, run_workload
from har.runtime.devices import backend_available


def test_matmul_cpu_is_correct_and_repeatable():
    result = run_matmul(size=8, backend="cpu", warmup_iterations=1, measured_iterations=3)
    assert result.correctness_passed
    assert len(result.samples_seconds) == 3
    assert result.latency_seconds["median"] > 0
    assert result.throughput_tflops["median"] > 0


@pytest.mark.parametrize("backend", ["mps", "cuda"])
def test_available_accelerator_smoke(backend):
    if not backend_available(backend):
        pytest.skip(f"{backend} is unavailable on this test host")
    result = run_matmul(size=8, backend=backend, warmup_iterations=1, measured_iterations=2)
    assert result.correctness_passed


def test_unknown_backend_is_rejected():
    with pytest.raises(ValueError, match="Unknown backend"):
        run_matmul(size=8, backend="tpu")


@pytest.mark.parametrize("workload", ["image", "tree"])
def test_deterministic_workloads_are_correct(workload):
    result = run_workload(
        workload=workload,
        backend="cpu",
        batch_size=2,
        image_size=8,
        depth=4,
        traversal_count=16,
        warmup_iterations=1,
        measured_iterations=2,
        seed=42,
    )
    assert result.benchmark == workload
    assert result.correctness_passed
    assert len(result.samples_seconds) == 2
    assert result.metrics

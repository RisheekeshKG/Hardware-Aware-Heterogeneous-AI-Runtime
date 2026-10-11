"""JSON and CSV result export."""

import csv
import json
from pathlib import Path
from typing import Any

from .models import BenchmarkResult


def write_json(result: BenchmarkResult, path: str | Path) -> Path:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result.to_dict(), indent=2) + "\n", encoding="utf-8")
    return output


def _csv_row(result: BenchmarkResult) -> dict[str, Any]:
    row: dict[str, Any] = {
        "benchmark": result.benchmark,
        "backend": result.backend,
        "device_name": result.device.device_name,
        "torch_device": result.device.torch_device,
        "size": result.size,
        "dtype": result.dtype,
        "warmup_iterations": result.warmup_iterations,
        "measured_iterations": result.measured_iterations,
        "seed": result.seed,
        "correctness_passed": result.correctness_passed,
        "memory_available_bytes": result.device.memory.available_bytes,
        "memory_total_bytes": result.device.memory.total_bytes,
        "memory_source": result.device.memory.source,
        "memory_measured": result.device.memory.measured,
        "memory_estimated": result.device.memory.estimated,
    }
    for name, value in result.latency_seconds.items():
        row[f"latency_{name}_seconds"] = value
    for name, value in result.throughput_tflops.items():
        row[f"throughput_{name}_tflops"] = value
    return row


def write_csv(result: BenchmarkResult, path: str | Path) -> Path:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    row = _csv_row(result)
    with output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(row))
        writer.writeheader()
        writer.writerow(row)
    return output

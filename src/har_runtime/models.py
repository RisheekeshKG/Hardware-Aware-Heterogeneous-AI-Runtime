"""Data models shared by discovery, benchmarking, and result exporters."""

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class MemoryMeasurement:
    """A memory value with provenance, so estimates are not confused with measurements."""

    available_bytes: int | None
    total_bytes: int | None
    source: str
    measured: bool
    estimated: bool
    unavailable_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class DeviceInfo:
    backend: str
    available: bool
    device_name: str
    torch_device: str
    torch_version: str
    details: dict[str, Any]
    memory: MemoryMeasurement
    unavailable_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "backend": self.backend,
            "available": self.available,
            "device_name": self.device_name,
            "torch_device": self.torch_device,
            "torch_version": self.torch_version,
            "details": self.details,
            "memory": self.memory.to_dict(),
            "unavailable_reason": self.unavailable_reason,
        }


@dataclass(frozen=True)
class BenchmarkResult:
    benchmark: str
    backend: str
    device: DeviceInfo
    size: int
    dtype: str
    warmup_iterations: int
    measured_iterations: int
    seed: int
    correctness_passed: bool
    tolerance: dict[str, float]
    latency_seconds: dict[str, float]
    throughput_tflops: dict[str, float]
    samples_seconds: list[float]
    workload_config: dict[str, Any] = field(default_factory=dict)
    metrics: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

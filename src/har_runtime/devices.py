"""Hardware detection and backend-specific synchronization utilities."""

from __future__ import annotations

import platform
import sys
from collections.abc import Callable

import psutil
import torch

from .models import DeviceInfo, MemoryMeasurement

BACKENDS = ("cpu", "mps", "cuda")


def _system_memory() -> MemoryMeasurement:
    memory = psutil.virtual_memory()
    return MemoryMeasurement(
        available_bytes=memory.available,
        total_bytes=memory.total,
        source="psutil.virtual_memory",
        measured=True,
        estimated=False,
    )


def _cuda_memory() -> MemoryMeasurement:
    if not torch.cuda.is_available():
        return MemoryMeasurement(None, None, "unavailable", False, False, "CUDA is not available")
    try:
        free, total = torch.cuda.mem_get_info()
        return MemoryMeasurement(free, total, "torch.cuda.mem_get_info", True, False)
    except RuntimeError as error:
        return MemoryMeasurement(None, None, "torch.cuda.mem_get_info", False, False, str(error))


def _mps_memory() -> MemoryMeasurement:
    if not torch.backends.mps.is_available():
        return MemoryMeasurement(None, None, "unavailable", False, False, "MPS is not available")
    # MPS exposes an allocator estimate, not a direct free-memory measurement.
    try:
        current = int(torch.mps.current_allocated_memory())
        total = int(torch.mps.recommended_max_memory())
        return MemoryMeasurement(
            available_bytes=max(total - current, 0),
            total_bytes=total,
            source="torch.mps.recommended_max_memory minus current allocation",
            measured=False,
            estimated=True,
        )
    except (AttributeError, RuntimeError) as error:
        return MemoryMeasurement(None, None, "torch.mps", False, False, str(error))


def _unavailable_memory(reason: str) -> MemoryMeasurement:
    return MemoryMeasurement(None, None, "unavailable", False, False, reason)


def _cpu_info() -> DeviceInfo:
    return DeviceInfo(
        backend="cpu",
        available=True,
        device_name=platform.processor() or platform.machine() or "CPU",
        torch_device="cpu",
        torch_version=torch.__version__,
        details={
            "platform": platform.platform(),
            "python_version": sys.version.split()[0],
            "logical_cpu_count": psutil.cpu_count(logical=True),
            "physical_cpu_count": psutil.cpu_count(logical=False),
        },
        memory=_system_memory(),
    )


def _mps_info() -> DeviceInfo:
    available = bool(torch.backends.mps.is_available())
    reason = None if available else "PyTorch MPS backend is unavailable on this host"
    return DeviceInfo(
        backend="mps",
        available=available,
        device_name="Apple Metal Performance Shaders",
        torch_device="mps",
        torch_version=torch.__version__,
        details={"built": bool(torch.backends.mps.is_built())},
        memory=_mps_memory(),
        unavailable_reason=reason,
    )


def _cuda_info() -> DeviceInfo:
    available = bool(torch.cuda.is_available())
    reason = None if available else "PyTorch CUDA backend is unavailable on this host"
    details: dict[str, object] = {"device_count": torch.cuda.device_count()}
    device_name = "NVIDIA CUDA"
    if available:
        details.update(
            {
                "device_index": 0,
                "cuda_version": torch.version.cuda,
                "capability": list(torch.cuda.get_device_capability(0)),
            }
        )
        device_name = torch.cuda.get_device_name(0)
    return DeviceInfo(
        backend="cuda",
        available=available,
        device_name=device_name,
        torch_device="cuda:0",
        torch_version=torch.__version__,
        details=details,
        memory=_cuda_memory(),
        unavailable_reason=reason,
    )


def discover_devices() -> list[DeviceInfo]:
    """Return all known backends, including unavailable ones with an explanation."""

    return [_cpu_info(), _mps_info(), _cuda_info()]


def get_device_info(backend: str) -> DeviceInfo:
    if backend not in BACKENDS:
        raise ValueError(f"Unknown backend '{backend}'. Choose from: {', '.join(BACKENDS)}")
    info = {device.backend: device for device in discover_devices()}[backend]
    if not info.available:
        raise RuntimeError(f"Requested backend '{backend}' is unavailable: {info.unavailable_reason}")
    return info


def torch_device(backend: str) -> torch.device:
    return torch.device(get_device_info(backend).torch_device)


def synchronize(backend: str) -> None:
    """Complete queued work before a timing boundary."""

    if backend == "cuda":
        torch.cuda.synchronize()
    elif backend == "mps":
        torch.mps.synchronize()


def backend_available(backend: str) -> bool:
    return any(device.backend == backend and device.available for device in discover_devices())

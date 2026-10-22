"""Drive CPU and an available accelerator while reporting resource usage."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import threading
import time

import psutil
import torch


class CudaUtilization:
    """Reads NVIDIA GPU utilization via NVML, with an nvidia-smi fallback."""

    def __init__(self) -> None:
        self._handle = None
        self._nvml = None
        try:
            import pynvml

            pynvml.nvmlInit()
            self._handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            self._nvml = pynvml
        except Exception:
            self._nvml = None
        self._smi = shutil.which("nvidia-smi") if self._nvml is None else None

    def sample(self) -> str:
        if self._nvml is not None and self._handle is not None:
            try:
                rates = self._nvml.nvmlDeviceGetUtilizationRates(self._handle)
                return f"GPU {rates.gpu:3d}% / mem-bw {rates.memory:3d}%"
            except Exception:
                pass
        if self._smi:
            try:
                output = subprocess.run(
                    [self._smi, "--query-gpu=utilization.gpu,utilization.memory",
                     "--format=csv,noheader,nounits", "--id=0"],
                    capture_output=True, text=True, timeout=1, check=False,
                )
                parts = [item.strip() for item in output.stdout.strip().split(",")]
                if len(parts) == 2:
                    return f"GPU {int(parts[0]):3d}% / mem-bw {int(parts[1]):3d}%"
            except Exception:
                pass
        return "GPU utilization unavailable"

    def shutdown(self) -> None:
        if self._nvml is not None:
            try:
                self._nvml.nvmlShutdown()
            except Exception:
                pass


def accelerator_device() -> torch.device | None:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return None


def synchronize(device: torch.device) -> None:
    if device.type == "cuda":
        torch.cuda.synchronize()
    elif device.type == "mps":
        torch.mps.synchronize()


def run_cpu(stop: threading.Event, size: int) -> None:
    left = torch.randn((size, size), device="cpu")
    right = torch.randn((size, size), device="cpu")
    while not stop.is_set():
        torch.mm(left, right)


def run_accelerator(stop: threading.Event, device: torch.device, size: int) -> None:
    left = torch.randn((size, size), device=device)
    right = torch.randn((size, size), device=device)
    while not stop.is_set():
        torch.mm(left, right)
        synchronize(device)


def accelerator_memory(device: torch.device) -> str:
    if device.type == "cuda":
        allocated = torch.cuda.memory_allocated() / 1024**2
        reserved = torch.cuda.memory_reserved() / 1024**2
        return f"{allocated:.0f} MB allocated / {reserved:.0f} MB reserved"
    if device.type == "mps":
        allocated = torch.mps.current_allocated_memory() / 1024**2
        return f"{allocated:.0f} MB allocated"
    return "unavailable"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=20)
    parser.add_argument("--size", type=int, default=1024)
    args = parser.parse_args()

    torch.set_num_threads(max(1, min(8, os.cpu_count() or 1)))
    device = accelerator_device()
    stop = threading.Event()
    threads = [threading.Thread(target=run_cpu, args=(stop, args.size), daemon=True)]

    print(f"CPU worker: active ({torch.get_num_threads()} PyTorch threads)")
    cuda_util = None
    if device is None:
        print("Accelerator: unavailable; running CPU-only probe")
    else:
        print(f"Accelerator: {device} ({torch.cuda.get_device_name(0) if device.type == 'cuda' else 'Apple MPS'})")
        threads.append(threading.Thread(target=run_accelerator, args=(stop, device, args.size), daemon=True))
        if device.type == "cuda":
            cuda_util = CudaUtilization()

    for thread in threads:
        thread.start()

    print(f"Sampling resources for {args.seconds}s with {args.size}x{args.size} matmul")
    try:
        for second in range(1, args.seconds + 1):
            time.sleep(1)
            memory = psutil.virtual_memory()
            accelerator = accelerator_memory(device) if device else "unavailable"
            utilization = cuda_util.sample() if cuda_util else (
                "GPU utilization unavailable (MPS)" if device and device.type == "mps" else ""
            )
            line = (
                f"{second:02d}s | CPU {psutil.cpu_percent(interval=None):5.1f}% | "
                f"RAM {memory.percent:5.1f}% | VRAM {accelerator}"
            )
            if utilization:
                line += f" | {utilization}"
            print(line)
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=5)
        if device:
            synchronize(device)
        if cuda_util:
            cuda_util.shutdown()
        print("Probe complete")


if __name__ == "__main__":
    main()

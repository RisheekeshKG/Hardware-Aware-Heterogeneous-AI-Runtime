"""Demo: run a couple of @har.offload functions and let the router pick devices.

Run with:

    har execute scripts/offload_demo.py

HAR times each function on each device the first time it sees that call shape, caches the
measurement, and uses the cache (plus a transfer-cost estimate) to pick a device on later calls.
"""

from __future__ import annotations

import torch

import har


@har.offload
def big_matmul(size: int) -> torch.Tensor:
    left = torch.randn(size, size)
    right = torch.randn(size, size)
    return left @ right


@har.offload
def tiny_add(x: torch.Tensor, y: torch.Tensor) -> torch.Tensor:
    return x + y


def main() -> None:
    print("HAR sees these devices:")
    for device in har.devices():
        print(f"  - {device.backend}: {device.name}")

    small = torch.randn(16)
    other = torch.randn(16)

    # Hit each shape a couple of times so the router has measurements and can switch.
    for _ in range(3):
        big_matmul(2048)
    for _ in range(3):
        tiny_add(small, other)

    print("\nLast routing decisions:")
    for name in ("__main__.big_matmul", "__main__.tiny_add"):
        decision = har.where_did_it_run(name)
        if decision:
            print(f"  {name}: {decision.backend} / {decision.device_name} / {decision.elapsed_seconds * 1000:.2f} ms")


if __name__ == "__main__":
    main()

"""Discover which devices HAR can route work to in this process."""

from __future__ import annotations

from dataclasses import dataclass

import torch


@dataclass(frozen=True)
class SdkDevice:
    backend: str
    torch_device: str
    name: str
    available: bool

    def __repr__(self) -> str:
        state = "ready" if self.available else "unavailable"
        return f"<har device backend={self.backend} name={self.name!r} {state}>"


def devices() -> list[SdkDevice]:
    """Return the devices this process can dispatch to, best-first (CPU last).

    v1 is local-only: discovers CPU plus any CUDA or MPS backend torch exposes.
    Remote nodes come in a later slice once the SDK is wired to the host API.
    """

    found: list[SdkDevice] = []
    if torch.cuda.is_available():
        try:
            name = torch.cuda.get_device_name(0)
        except RuntimeError:
            name = "CUDA device"
        found.append(SdkDevice(backend="cuda", torch_device="cuda:0", name=name, available=True))
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        found.append(SdkDevice(backend="mps", torch_device="mps", name="Apple MPS", available=True))
    found.append(SdkDevice(backend="cpu", torch_device="cpu", name="CPU", available=True))
    return found

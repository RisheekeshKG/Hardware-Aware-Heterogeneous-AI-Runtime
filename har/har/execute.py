"""Runs the user's function on the device the router picked, moving tensors in and out."""

from __future__ import annotations

import time
from typing import Any, Callable

import torch

from .inventory import SdkDevice


def _move(obj: Any, device: torch.device) -> Any:
    if isinstance(obj, torch.Tensor):
        return obj if obj.device == device else obj.to(device)
    if isinstance(obj, list):
        return [_move(item, device) for item in obj]
    if isinstance(obj, tuple):
        return tuple(_move(item, device) for item in obj)
    if isinstance(obj, dict):
        return {key: _move(value, device) for key, value in obj.items()}
    return obj


def _synchronize(device: torch.device) -> None:
    if device.type == "cuda":
        torch.cuda.synchronize()
    elif device.type == "mps":
        torch.mps.synchronize()


def run_on(
    fn: Callable[..., Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    sdk_device: SdkDevice,
) -> tuple[Any, float]:
    """Run `fn(*args, **kwargs)` on `sdk_device`, return (result, elapsed_seconds).

    Elapsed covers compute + sync but excludes the move back to CPU, which is accounted for by the
    router's transfer-cost model instead.
    """

    torch_device = torch.device(sdk_device.torch_device)
    moved_args = tuple(_move(arg, torch_device) for arg in args)
    moved_kwargs = {key: _move(value, torch_device) for key, value in kwargs.items()}

    _synchronize(torch_device)
    start = time.perf_counter()
    result = fn(*moved_args, **moved_kwargs)
    _synchronize(torch_device)
    elapsed = time.perf_counter() - start

    # Pull any tensor outputs back to CPU so the user never sees surprise MPS/CUDA tensors.
    result = _move(result, torch.device("cpu"))
    return result, elapsed

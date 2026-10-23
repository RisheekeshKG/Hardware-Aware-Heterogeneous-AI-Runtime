"""The user-facing `@har.offload` decorator and the per-call dispatch record."""

from __future__ import annotations

import functools
import threading
from dataclasses import dataclass
from typing import Any, Callable, Iterable

from .execute import run_on
from .router import Router, shape_key


@dataclass
class OffloadDecision:
    """What the router did for one call. Readable via `har.where_did_it_run(fn)`."""

    function: str
    backend: str
    device_name: str
    reason: str
    elapsed_seconds: float
    transfer_bytes: int


_router: Router | None = None
_router_lock = threading.Lock()
_last_decisions: dict[str, OffloadDecision] = {}


def _get_router() -> Router:
    global _router
    with _router_lock:
        if _router is None:
            _router = Router()
        return _router


def offload(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Mark a function as routable: HAR picks the device, runs it, returns the result.

    Usage:

        import har

        @har.offload
        def embed(x):
            ...

    First call for a given argument shape measures on the current device and caches the result.
    Later calls consult the calibration cache and may switch devices, factoring in transfer cost.
    """

    current_backend = {"backend": "cpu"}

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        router = _get_router()
        decision = router.choose(fn, args, kwargs, current_backend["backend"])
        result, elapsed = run_on(fn, args, kwargs, decision.device)
        router.record(shape_key(fn, args, kwargs), decision.device.backend, elapsed)
        current_backend["backend"] = decision.device.backend
        _last_decisions[f"{fn.__module__}.{fn.__qualname__}"] = OffloadDecision(
            function=f"{fn.__module__}.{fn.__qualname__}",
            backend=decision.device.backend,
            device_name=decision.device.name,
            reason=decision.reason,
            elapsed_seconds=elapsed,
            transfer_bytes=decision.transfer_bytes,
        )
        return result

    wrapper.__har_offload__ = True  # type: ignore[attr-defined]
    return wrapper


def map(fn: Callable[[Any], Any], items: Iterable[Any]) -> list[Any]:
    """Run `fn` on each item, routing per item. Serial in v1; parallel in a later slice."""

    wrapped = fn if getattr(fn, "__har_offload__", False) else offload(fn)
    return [wrapped(item) for item in items]


def where_did_it_run(fn: Callable[..., Any] | str) -> OffloadDecision | None:
    """Last routing decision for `fn` (or qualified-name string). None if never called."""

    name = fn if isinstance(fn, str) else f"{fn.__module__}.{fn.__qualname__}"
    return _last_decisions.get(name)

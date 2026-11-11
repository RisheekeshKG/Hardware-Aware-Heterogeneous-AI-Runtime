"""Single place that imports torch so the rest of the package can treat it as optional.

End-user desktops install torch via the first-run setup flow (see `har.runtime.cli
install-deps`). The server itself must import and start before that runs, so every
torch-using module imports from here and either checks TORCH_AVAILABLE or calls
require_torch() at the point of actual use.
"""

from __future__ import annotations

try:
    import torch as _torch_module
    TORCH_AVAILABLE = True
    torch = _torch_module
except ImportError:  # pragma: no cover - exercised by the first-launch setup path, not in CI
    TORCH_AVAILABLE = False
    torch = None  # type: ignore[assignment]


class TorchNotInstalled(RuntimeError):
    """Raised when a code path needs torch but the runtime hasn't installed it yet.

    The desktop shell catches this at startup and triggers the setup wizard; the SDK
    surfaces it to the user with install instructions when @offload is called cold.
    """


def require_torch():
    """Return the torch module or raise a clear error. Use at the top of any function
    that genuinely cannot continue without torch."""

    if not TORCH_AVAILABLE:
        raise TorchNotInstalled(
            "PyTorch isn't installed in this runtime. Open HAR and run the first-time "
            "setup, or install it manually with: pip install torch"
        )
    return torch

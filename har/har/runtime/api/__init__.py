"""Public API package — thin stitcher that imports every endpoint module in the right order.

The package used to be a single 1200-line `api.py`. The name is kept so existing imports
(`from har.runtime.api import app, MatmulRunRequest, ...`) keep working.
"""

from __future__ import annotations

from .core import (
    _session,
    app,
    configure_host_url,
    configure_role,
    start_discovery,
)
from .auth import _normalize_worker_url
from .schemas import (
    DiscoveryConnectRequest,
    MatmulRunRequest,
    NodeConnectRequest,
    NodeHeartbeat,
    NodeRegistration,
    NodeRenameRequest,
    RunRecord,
    ScriptRecord,
    ScriptRunRequest,
)

# Importing these modules registers their routes on `app` as a side effect.
# Keep the order stable — matches the original file's route declaration order so
# anything that enumerates `app.routes` (OpenAPI, tests) sees the same shape.
from . import nodes as _nodes_routes  # noqa: F401
from . import info as _info_routes  # noqa: F401
from . import trust as _trust_routes  # noqa: F401
from . import scripts as _scripts_routes  # noqa: F401
from . import benchmarks as _benchmarks_routes  # noqa: F401
from . import workspace as _workspace_routes  # noqa: F401


__all__ = [
    "app",
    "configure_host_url",
    "configure_role",
    "start_discovery",
    "DiscoveryConnectRequest",
    "MatmulRunRequest",
    "NodeConnectRequest",
    "NodeHeartbeat",
    "NodeRegistration",
    "NodeRenameRequest",
    "RunRecord",
    "ScriptRecord",
    "ScriptRunRequest",
]

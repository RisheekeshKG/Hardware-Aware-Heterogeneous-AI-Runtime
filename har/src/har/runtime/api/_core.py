"""App, middleware, and process-wide state shared by every endpoint module.

Kept deliberately thin — no routes live here, so sub-modules that register endpoints
can import this without pulling in sibling modules and creating import cycles.
"""

from __future__ import annotations

import os
import socket
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit, urlunsplit

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ..discovery import DiscoveryRegistry
from ..graceful_shutdown import install as _install_graceful_shutdown, on_shutdown as _on_shutdown
from ..idle_shutdown import install as _install_idle_watchdog
from ..rate_limit import install as _install_rate_limiter

if TYPE_CHECKING:
    from .models import RunRecord, ScriptRecord


app = FastAPI(title="Hardware-Aware AI Runtime API", version="0.2.0")

# Only the desktop app (Vite dev server or the Tauri webview on macOS/Windows)
# may call this API from a browser context. A wildcard would let any website
# open in a browser start Python files on this computer.
DEFAULT_CORS_ORIGINS = (
    "http://localhost:5173,http://127.0.0.1:5173,"
    "tauri://localhost,http://tauri.localhost,https://tauri.localhost"
)
_cors_origins = [
    origin.strip()
    for origin in os.getenv("HAR_CORS_ORIGINS", DEFAULT_CORS_ORIGINS).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

LOOPBACK_CLIENTS = {"127.0.0.1", "::1", "localhost", "testclient"}
# Other computers only need to register and report heartbeats; everything else
# (running code, connecting devices, reading results) stays local to this computer.
REMOTE_ALLOWED_PATHS = {"/api/health", "/api/nodes/register", "/api/nodes/heartbeat"}


@app.middleware("http")
async def restrict_remote_clients(request, call_next):
    client = request.client.host if request.client else ""
    if client not in LOOPBACK_CLIENTS and request.url.path not in REMOTE_ALLOWED_PATHS:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=403, content={"detail": "Only available on this computer"})
    return await call_next(request)


_runs: dict[str, "RunRecord"] = {}
_nodes: dict[str, dict[str, Any]] = {}
# Per-worker HMAC secret, received from the worker's /worker/join response. In memory only;
# if the host restarts it re-pairs on the next connect and gets a fresh secret from the worker.
_node_secrets: dict[str, str] = {}
# Workers removed with Disconnect. Their registrations get 410 Gone, which tells
# the worker to stop, until the user adds the device again.
_disconnected_nodes: set[str] = set()
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="har-benchmark")
_script_runs: dict[str, "ScriptRecord"] = {}


def _host_has_active_work() -> bool:
    """Any queued/running benchmark or script = the server is still useful. Block idle shutdown."""

    for run in _runs.values():
        if run.status in {"queued", "running"}:
            return True
    for script in _script_runs.values():
        if script.status in {"queued", "running"}:
            return True
    return False


_idle_watchdog = _install_idle_watchdog(app, has_active_work=_host_has_active_work)
_rate_limiter = _install_rate_limiter(app, limited_paths=["/api/scripts", "/api/runs"])


def _mark_host_inflight_failed() -> None:
    """Flip every queued/running record to failed when the server is shutting down.

    Without this, the UI's history would show scripts stuck in `running` forever after a
    SIGTERM — the subprocess is long gone but the status was never updated.
    """

    now = datetime.now(timezone.utc).isoformat()
    for run in _runs.values():
        if run.status in {"queued", "running"}:
            run.status = "failed"
            run.error = "Server received a shutdown signal while this run was in flight"
            run.updated_at = now
    for script in _script_runs.values():
        if script.status in {"queued", "running"}:
            script.status = "failed"
            script.error = "Server received a shutdown signal while this script was in flight"
            script.updated_at = now
            if script.finished_at is None:
                script.finished_at = now


_on_shutdown(_mark_host_inflight_failed)
_install_graceful_shutdown(app)


_discovery: DiscoveryRegistry | None = None
_discovery_lock = threading.Lock()


def _discovery_registry() -> DiscoveryRegistry:
    """Start the LAN listener on first use, so only the API process binds its UDP port."""

    global _discovery
    with _discovery_lock:
        if _discovery is None:
            _discovery = DiscoveryRegistry()
        return _discovery


_session = {
    "session_id": uuid.uuid4().hex[:10],
    "role": os.getenv("HAR_RUNTIME_ROLE", "host"),
    "host_url": os.getenv("HAR_HOST_URL"),
    "created_at": datetime.now(timezone.utc).isoformat(),
}


def configure_role(role: str) -> None:
    _session["role"] = role


def start_discovery() -> None:
    _discovery_registry()


def configure_host_url(url: str | None) -> None:
    if url:
        parsed = urlsplit(url.rstrip("/"))
        host = parsed.hostname
        if host in {"0.0.0.0", "127.0.0.1", "localhost"}:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                try:
                    probe.connect(("8.8.8.8", 80))
                    host = probe.getsockname()[0]
                except OSError:
                    host = socket.gethostbyname(socket.gethostname())
            if parsed.port:
                host = f"{host}:{parsed.port}"
            url = urlunsplit((parsed.scheme or "http", host, parsed.path, parsed.query, parsed.fragment))
        _session["host_url"] = url.rstrip("/")

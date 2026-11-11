"""Health, env-hash, devices, system, session, runtime snapshot, and role endpoints."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from ..devices import discover_devices, system_info
from .core import _nodes, _runs, _session, app
from .auth import _signed_headers_for


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "hardware-aware-ai-runtime"}


@app.get("/api/env-hash")
def host_env_hash() -> dict[str, object]:
    """This host's Python + key-package fingerprint."""

    from ..env_hash import env_fingerprint

    return env_fingerprint()


@app.get("/api/nodes/{node_id}/env-hash")
def node_env_hash(node_id: str) -> dict[str, Any]:
    """Fetch a remote worker's fingerprint and flag any mismatch against this host's.

    Returns `{host, worker, mismatches: [...], compatible: bool}` so the UI can show
    "Your worker is missing pynvml and has torch 2.1 vs. your 2.3" instead of letting
    the job crash later with a stack trace.
    """

    import httpx

    node = _nodes.get(node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    base_url = node.get("base_url", "").rstrip("/")
    env_url = f"{base_url}/worker/env-hash"
    try:
        response = httpx.get(env_url, headers=_signed_headers_for(node_id, "GET", env_url), timeout=5.0)
        response.raise_for_status()
        worker = response.json()
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"Could not reach worker: {error}") from error

    from ..env_hash import env_fingerprint

    host = env_fingerprint()
    mismatches: list[str] = []
    if host["python"] != worker["python"]:
        mismatches.append(f"python {host['python']} vs {worker['python']}")
    for name, host_version in host["packages"].items():
        worker_version = worker["packages"].get(name, "absent")
        if host_version != worker_version:
            mismatches.append(f"{name}: {host_version} / worker {worker_version}")
    return {"host": host, "worker": worker, "mismatches": mismatches, "compatible": not mismatches}


@app.get("/api/devices")
def devices() -> list[dict[str, Any]]:
    return [device.to_dict() for device in discover_devices()]


@app.get("/api/system")
def system() -> dict[str, Any]:
    return {"host": system_info(), "devices": devices()}


@app.get("/api/session")
def session() -> dict[str, Any]:
    return {**_session, "connected_workers": len(_nodes)}


@app.get("/api/runtime/role")
def runtime_role() -> dict[str, str]:
    return {"role": _session["role"]}


@app.get("/api/runtime")
def runtime_snapshot() -> dict[str, Any]:
    """Return the live state needed by the desktop runtime console."""

    # Local import avoids a cycle with api.nodes (which imports from app).
    from .nodes import nodes as _list_nodes

    visible_nodes = _list_nodes()
    if _session["role"] == "host":
        # A host already exposes its own local devices. Do not show a stale
        # worker registration from an older host launch as a second computer.
        visible_nodes = [node for node in visible_nodes if node.get("name") != "This device"]
    return {
        "devices": [device.to_dict() for device in discover_devices()],
        "nodes": visible_nodes,
        "runs": [record.snapshot() for record in reversed(list(_runs.values()))],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

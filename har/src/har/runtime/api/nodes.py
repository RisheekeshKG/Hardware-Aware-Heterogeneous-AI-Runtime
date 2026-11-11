"""Node registration, heartbeat, listing, disconnect, connect, rename, and LAN discovery."""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from ._core import (
    _disconnected_nodes,
    _discovery_registry,
    _node_secrets,
    _nodes,
    _runs,
    _script_runs,
    _session,
    app,
)
from ._helpers import CONNECT_APPROVAL_TIMEOUT_SECONDS, _normalize_worker_url
from .models import DiscoveryConnectRequest, NodeConnectRequest, NodeHeartbeat, NodeRegistration, NodeRenameRequest


@app.post("/api/nodes/register")
def register_node(registration: NodeRegistration) -> dict[str, Any]:
    if registration.node_id in _disconnected_nodes:
        raise HTTPException(status_code=410, detail="This host disconnected you")
    now = datetime.now(timezone.utc).isoformat()
    node = _nodes.get(registration.node_id, {})
    node.update(
        {
            "node_id": registration.node_id,
            "name": registration.name,
            "base_url": registration.base_url.rstrip("/"),
            "capabilities": registration.capabilities,
            "host": registration.host,
            "status": "online",
            "last_seen": now,
            "active_job": node.get("active_job"),
            "role": "worker",
            "session_id": _session["session_id"],
        }
    )
    _nodes[registration.node_id] = node
    return node


@app.post("/api/nodes/heartbeat")
def heartbeat(heartbeat_data: NodeHeartbeat) -> dict[str, Any]:
    node = _nodes.get(heartbeat_data.node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node is not registered")
    node["status"] = "online"
    node["last_seen"] = datetime.now(timezone.utc).isoformat()
    node["active_job"] = heartbeat_data.active_job
    return node


@app.get("/api/nodes")
def nodes() -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    for node in _nodes.values():
        try:
            last_seen = datetime.fromisoformat(node["last_seen"])
            if (now - last_seen).total_seconds() > 15:
                node["status"] = "offline"
        except (KeyError, ValueError):
            node["status"] = "offline"
    return list(_nodes.values())


@app.delete("/api/nodes/{node_id}")
def disconnect_node(node_id: str) -> dict[str, Any]:
    """Remove a node from this host's roster and fail anything still running against it.

    Workers are not told; their trust state belongs to the worker's own pairing flow.
    After this call, the UI stops offering the node as a target until it registers again.
    """

    removed = _nodes.pop(node_id, None)
    if removed is None:
        raise HTTPException(status_code=404, detail="Node is not registered")
    _disconnected_nodes.add(node_id)
    # Forget the HMAC secret so a re-pair starts from scratch (the worker will mint a new one anyway).
    _node_secrets.pop(node_id, None)

    now = datetime.now(timezone.utc).isoformat()
    aborted_runs: list[str] = []
    for run in _runs.values():
        if run.node_id == node_id and run.status in {"queued", "running"}:
            run.status = "failed"
            run.error = "Remote device was disconnected while this run was in flight"
            run.updated_at = now
            aborted_runs.append(run.id)
    aborted_scripts: list[str] = []
    for script in _script_runs.values():
        if script.request.target_node == node_id and script.status in {"queued", "running"}:
            script.status = "failed"
            script.error = "Remote device was disconnected while this script was running"
            script.updated_at = now
            if script.finished_at is None:
                script.finished_at = now
            aborted_scripts.append(script.id)
    return {
        "status": "disconnected",
        "node_id": node_id,
        "aborted_runs": aborted_runs,
        "aborted_scripts": aborted_scripts,
    }


@app.post("/api/nodes/connect")
def connect_node(request: NodeConnectRequest) -> dict[str, Any]:
    """Ask a worker to join this host and wait until it is accepted there.

    The worker answers 202 while the person at that computer has not yet
    accepted the request, 200 once accepted, and 403 if they declined.
    """

    import httpx

    worker_url = _normalize_worker_url(request.worker_url)
    coordinator_url = _session.get("host_url") or os.getenv("HAR_HOST_URL")
    if not coordinator_url:
        raise HTTPException(status_code=400, detail="Host URL is not configured; start har serve with --advertise-url")
    try:
        deadline = time.monotonic() + CONNECT_APPROVAL_TIMEOUT_SECONDS
        last_error: httpx.RequestError | None = None
        waiting_for_approval = False
        with httpx.Client(timeout=httpx.Timeout(5.0, connect=3.0)) as client:
            while time.monotonic() < deadline:
                try:
                    response = client.post(
                        f"{worker_url}/worker/join",
                        json={
                            "coordinator": coordinator_url,
                            "name": request.name or "",
                            "node_id": request.node_id,
                        },
                    )
                    if response.status_code == 202:
                        waiting_for_approval = True
                        time.sleep(1.0)
                        continue
                    response.raise_for_status()
                    joined = response.json()
                    node_id = joined.get("node_id", "")
                    _disconnected_nodes.discard(node_id)
                    # Stash the HMAC secret the worker handed us so later host→worker calls
                    # can prove their identity cryptographically instead of relying on IP.
                    secret = joined.get("shared_secret")
                    if node_id and isinstance(secret, str) and secret:
                        _node_secrets[node_id] = secret
                    return joined
                except httpx.RequestError as error:
                    last_error = error
                    time.sleep(1.0)
        if waiting_for_approval:
            raise HTTPException(
                status_code=504,
                detail="Nobody accepted the request on that computer. Click Accept in HAR there, then try again.",
            )
        raise HTTPException(
            status_code=504,
            detail=(
                f"Could not reach {worker_url}. Check that HAR on that computer is set to Worker, "
                f"both computers are on the same network, and the firewall allows port 9000. ({last_error})"
            ),
        )
    except httpx.HTTPStatusError as error:
        try:
            detail = error.response.json().get("detail") or error.response.text
        except ValueError:
            detail = error.response.text or str(error)
        raise HTTPException(status_code=400, detail=f"Worker rejected connection: {detail}") from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"Worker is unreachable: {error}") from error


@app.get("/api/discovery")
def discovery() -> list[dict[str, Any]]:
    """Workers broadcasting on the LAN, minus any already connected to this host.

    Without this filter the UI would list a worker you just paired with and keep offering
    a Connect button that would re-run the pairing flow pointlessly.
    """

    connected_ids = set(_nodes.keys())
    return [node for node in _discovery_registry().list_nodes() if node.get("node_id") not in connected_ids]


@app.post("/api/discovery/connect")
def connect_discovered_node(request: DiscoveryConnectRequest) -> dict[str, Any]:
    node = _discovery_registry().get(request.node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Discovered node is no longer visible")
    connect_node(
        NodeConnectRequest(
            worker_url=node["base_url"],
            name=request.name or node.get("name", "runtime-worker"),
            node_id=request.node_id,
        )
    )
    return {"status": "joining", "node_id": request.node_id, "name": request.name or node.get("name")}


@app.post("/api/nodes/{node_id}/rename")
def rename_node(node_id: str, request: NodeRenameRequest) -> dict[str, Any]:
    node = _nodes.get(node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    name = request.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Name cannot be blank")
    node["name"] = name
    return node

"""Remote worker service for executing real PyTorch workloads."""

from __future__ import annotations

import os
from pathlib import Path
import socket
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .api import MatmulRunRequest
from .benchmark import run_workload
from .devices import discover_devices, get_device_info, system_info
from .discovery import DiscoveryBeacon


class WorkerRun:
    def __init__(self, request: MatmulRunRequest) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.request = request
        self.status = "queued"
        self.completed_iterations = 0
        self.last_latency_seconds: float | None = None
        self.result: dict[str, Any] | None = None
        self.error: str | None = None
        self.created_at = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "request": self.request.model_dump(),
            "completed_iterations": self.completed_iterations,
            "last_latency_seconds": self.last_latency_seconds,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
        }


class WorkerJoinRequest(BaseModel):
    coordinator: str
    name: str = ""
    node_id: str = ""


worker_app = FastAPI(title="Hardware-Aware AI Runtime Worker", version="0.2.0")
_worker_runs: dict[str, WorkerRun] = {}
_worker_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="har-worker")
_worker_config: dict[str, str] = {}
_node_id_path = Path.home() / ".har-runtime" / "node-id"
_discovery_beacon: DiscoveryBeacon | None = None


def _lan_address() -> str:
    """Find the local address used for outbound LAN traffic."""

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        try:
            probe.connect(("8.8.8.8", 80))
            return probe.getsockname()[0]
        except OSError:
            return socket.gethostbyname(socket.gethostname())


def _reachable_base_url(base_url: str) -> str:
    parsed = urlsplit(base_url.rstrip("/"))
    if parsed.hostname not in {"0.0.0.0", "127.0.0.1", "localhost"}:
        return base_url.rstrip("/")
    host = _lan_address()
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return urlunsplit((parsed.scheme or "http", host, parsed.path, parsed.query, parsed.fragment)).rstrip("/")


def _is_local_url(url: str) -> bool:
    return urlsplit(url.rstrip("/")).hostname in {"127.0.0.1", "localhost"}


def stable_node_id() -> str:
    """Return a persistent identity for this machine, generated only once."""

    if _node_id_path.is_file():
        stored = _node_id_path.read_text(encoding="utf-8").strip()
        if stored:
            return stored
    _node_id_path.parent.mkdir(parents=True, exist_ok=True)
    generated = f"{socket.gethostname().lower()}-{uuid.uuid4().hex[:8]}"
    _node_id_path.write_text(generated + "\n", encoding="utf-8")
    return generated


def _execute(record: WorkerRun) -> None:
    record.status = "running"

    def progress(completed: int, _total: int, latency: float) -> None:
        record.completed_iterations = completed
        record.last_latency_seconds = latency

    try:
        record.result = run_workload(
            workload=record.request.workload,
            size=record.request.size,
            backend=record.request.backend,
            batch_size=record.request.batch_size,
            image_size=record.request.image_size,
            depth=record.request.depth,
            traversal_count=record.request.traversal_count,
            warmup_iterations=record.request.warmup_iterations,
            measured_iterations=record.request.measured_iterations,
            seed=record.request.seed,
            progress_callback=progress,
        ).to_dict()
        record.status = "completed"
    except Exception as error:
        record.error = str(error)
        record.status = "failed"


@worker_app.get("/worker/health")
def worker_health() -> dict[str, str]:
    return {
        "status": "ok",
        "node_id": _worker_config.get("node_id", "unconfigured"),
        "accepting_connections": str(_worker_config.get("allow_connections", True)).lower(),
    }


@worker_app.get("/worker/capabilities")
def capabilities() -> list[dict[str, Any]]:
    return [device.to_dict() for device in discover_devices()]


@worker_app.post("/worker/join")
def join_host(request: WorkerJoinRequest) -> dict[str, Any]:
    if not _worker_config.get("allow_connections", True):
        raise HTTPException(status_code=403, detail="Worker is not accepting host connections")
    configure_worker(
        coordinator=request.coordinator,
        base_url=_worker_config["advertise_url"],
        name=request.name,
        node_id=request.node_id or stable_node_id(),
    )
    return {"status": "joining", "node_id": _worker_config["node_id"], "coordinator": request.coordinator}


@worker_app.post("/worker/runs", status_code=202)
def start_worker_run(request: MatmulRunRequest) -> dict[str, Any]:
    try:
        get_device_info(request.backend)
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    record = WorkerRun(request)
    _worker_runs[record.id] = record
    _worker_executor.submit(_execute, record)
    return record.to_dict()


@worker_app.get("/worker/runs/{run_id}")
def worker_run_status(run_id: str) -> dict[str, Any]:
    record = _worker_runs.get(run_id)
    if not record:
        raise HTTPException(status_code=404, detail="Worker run not found")
    return record.to_dict()


def _registration_loop() -> None:
    coordinator = _worker_config["coordinator"].rstrip("/")
    registration = {
        "node_id": _worker_config["node_id"],
        "name": _worker_config["name"],
        "base_url": _worker_config["base_url"],
        "capabilities": [],
        "host": system_info(),
    }
    try:
        registration["capabilities"] = capabilities()
    except Exception:
        # Registration must remain available even if hardware probing is slow
        # or a platform backend raises during startup.
        pass
    while True:
        try:
            with httpx.Client(timeout=10.0) as client:
                client.post(f"{coordinator}/api/nodes/register", json=registration).raise_for_status()
                client.post(f"{coordinator}/api/nodes/heartbeat", json={"node_id": registration["node_id"], "active_job": None})
        except httpx.HTTPError:
            pass
        time.sleep(5)


def configure_worker(
    *,
    coordinator: str | None,
    base_url: str,
    name: str | None = None,
    node_id: str | None = None,
    allow_connections: bool = True,
) -> None:
    global _discovery_beacon
    resolved_node_id = node_id or stable_node_id()
    resolved_name = name or socket.gethostname()
    resolved_advertise_url = _reachable_base_url(base_url)
    coordinator_is_local = bool(coordinator and _is_local_url(coordinator))
    resolved_base_url = base_url.rstrip("/") if coordinator_is_local and _is_local_url(base_url) else resolved_advertise_url
    _worker_config.update(
        {
            "coordinator": coordinator or "",
            "base_url": resolved_base_url,
            "advertise_url": resolved_advertise_url,
            "name": resolved_name,
            "node_id": resolved_node_id,
            "allow_connections": allow_connections,
        }
    )
    _discovery_beacon = DiscoveryBeacon(
        {
            "role": "worker",
            "node_id": resolved_node_id,
            "name": resolved_name,
            "base_url": resolved_advertise_url,
            "host": system_info(),
            "capabilities": [],
        }
    )
    _discovery_beacon.start()
    if coordinator:
        threading.Thread(target=_registration_loop, daemon=True, name="har-registration").start()

"""Remote worker service for executing real PyTorch workloads."""

from __future__ import annotations

import os
import socket
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .api import MatmulRunRequest
from .benchmark import run_matmul
from .devices import discover_devices, get_device_info


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


worker_app = FastAPI(title="Hardware-Aware AI Runtime Worker", version="0.2.0")
_worker_runs: dict[str, WorkerRun] = {}
_worker_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="har-worker")
_worker_config: dict[str, str] = {}


def _execute(record: WorkerRun) -> None:
    record.status = "running"

    def progress(completed: int, _total: int, latency: float) -> None:
        record.completed_iterations = completed
        record.last_latency_seconds = latency

    try:
        record.result = run_matmul(
            size=record.request.size,
            backend=record.request.backend,
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
    return {"status": "ok", "node_id": _worker_config.get("node_id", "unconfigured")}


@worker_app.get("/worker/capabilities")
def capabilities() -> list[dict[str, Any]]:
    return [device.to_dict() for device in discover_devices()]


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
        "capabilities": capabilities(),
    }
    while True:
        try:
            with httpx.Client(timeout=10.0) as client:
                client.post(f"{coordinator}/api/nodes/register", json=registration).raise_for_status()
                client.post(f"{coordinator}/api/nodes/heartbeat", json={"node_id": registration["node_id"], "active_job": None})
        except httpx.HTTPError:
            pass
        time.sleep(5)


def configure_worker(*, coordinator: str, base_url: str, name: str | None = None, node_id: str | None = None) -> None:
    _worker_config.update(
        {
            "coordinator": coordinator,
            "base_url": base_url.rstrip("/"),
            "name": name or socket.gethostname(),
            "node_id": node_id or f"{socket.gethostname().lower()}-{uuid.uuid4().hex[:6]}",
        }
    )
    threading.Thread(target=_registration_loop, daemon=True, name="har-registration").start()

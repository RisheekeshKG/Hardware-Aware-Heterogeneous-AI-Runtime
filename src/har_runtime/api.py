"""Live HTTP and WebSocket API for real benchmark execution."""

from __future__ import annotations

import asyncio
import os
import time
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .benchmark import run_matmul
from .devices import discover_devices, get_device_info


class MatmulRunRequest(BaseModel):
    size: int = Field(default=1024, ge=1, le=16384)
    backend: Literal["cpu", "mps", "cuda"] = "cpu"
    warmup_iterations: int = Field(default=3, ge=0, le=1000)
    measured_iterations: int = Field(default=10, ge=1, le=1000)
    seed: int = Field(default=42)
    target_node: str = "local"


class NodeRegistration(BaseModel):
    node_id: str
    name: str
    base_url: str
    capabilities: list[dict[str, Any]]


class NodeHeartbeat(BaseModel):
    node_id: str
    active_job: str | None = None


class RunRecord:
    def __init__(self, request: MatmulRunRequest) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.request = request
        self.status: str = "queued"
        self.completed_iterations = 0
        self.last_latency_seconds: float | None = None
        self.result: dict[str, Any] | None = None
        self.error: str | None = None
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.updated_at = self.created_at
        self.condition = threading.Condition()
        self.events: list[dict[str, Any]] = []
        self.node_id = request.target_node
        self.network_round_trip_ms: float | None = None

    def publish(self, event: dict[str, Any]) -> None:
        with self.condition:
            self.events.append(event)
            self.updated_at = datetime.now(timezone.utc).isoformat()
            self.condition.notify_all()

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "request": self.request.model_dump(),
            "completed_iterations": self.completed_iterations,
            "last_latency_seconds": self.last_latency_seconds,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "node_id": self.node_id,
            "network_round_trip_ms": self.network_round_trip_ms,
        }


app = FastAPI(title="Hardware-Aware AI Runtime API", version="0.2.0")
_cors_origins = [
    origin.strip()
    for origin in os.getenv("HAR_CORS_ORIGINS", "*").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_runs: dict[str, RunRecord] = {}
_nodes: dict[str, dict[str, Any]] = {}
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="har-benchmark")


def _run_benchmark(record: RunRecord) -> None:
    record.status = "running"
    record.publish({"type": "status", "status": "running"})

    def progress(completed: int, total: int, latency: float) -> None:
        record.completed_iterations = completed
        record.last_latency_seconds = latency
        record.publish(
            {
                "type": "progress",
                "completed_iterations": completed,
                "total_iterations": total,
                "latency_seconds": latency,
            }
        )

    try:
        result = run_matmul(
            size=record.request.size,
            backend=record.request.backend,
            warmup_iterations=record.request.warmup_iterations,
            measured_iterations=record.request.measured_iterations,
            seed=record.request.seed,
            progress_callback=progress,
        )
        record.result = result.to_dict()
        record.status = "completed"
        record.publish({"type": "completed", "result": record.result})
    except Exception as error:  # Keep failures visible to the dashboard.
        record.error = str(error)
        record.status = "failed"
        record.publish({"type": "failed", "error": record.error})


def _run_remote_benchmark(record: RunRecord, node: dict[str, Any]) -> None:
    """Submit to a worker and poll its real execution state."""

    import httpx

    record.status = "running"
    record.publish({"type": "status", "status": "running", "node_id": record.node_id})
    try:
        with httpx.Client(timeout=30.0) as client:
            started = time.perf_counter()
            response = client.post(f"{node['base_url']}/worker/runs", json=record.request.model_dump())
            record.network_round_trip_ms = (time.perf_counter() - started) * 1000
            response.raise_for_status()
            worker_run_id = response.json()["id"]
            node["active_job"] = record.id
            while True:
                started = time.perf_counter()
                status_response = client.get(f"{node['base_url']}/worker/runs/{worker_run_id}")
                record.network_round_trip_ms = (time.perf_counter() - started) * 1000
                status_response.raise_for_status()
                worker_record = status_response.json()
                record.completed_iterations = worker_record["completed_iterations"]
                record.last_latency_seconds = worker_record["last_latency_seconds"]
                record.publish(
                    {
                        "type": "progress",
                        "completed_iterations": record.completed_iterations,
                        "total_iterations": record.request.measured_iterations,
                        "latency_seconds": record.last_latency_seconds,
                        "network_round_trip_ms": record.network_round_trip_ms,
                    }
                )
                if worker_record["status"] in {"completed", "failed"}:
                    if worker_record["status"] == "completed":
                        record.result = worker_record["result"]
                        record.status = "completed"
                        record.publish({"type": "completed", "result": record.result})
                    else:
                        record.error = worker_record["error"]
                        record.status = "failed"
                        record.publish({"type": "failed", "error": record.error})
                    break
                time.sleep(0.15)
    except Exception as error:
        record.error = f"Remote node '{record.node_id}' failed: {error}"
        record.status = "failed"
        record.publish({"type": "failed", "error": record.error})
    finally:
        node["active_job"] = None


@app.post("/api/nodes/register")
def register_node(registration: NodeRegistration) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    node = _nodes.get(registration.node_id, {})
    node.update(
        {
            "node_id": registration.node_id,
            "name": registration.name,
            "base_url": registration.base_url.rstrip("/"),
            "capabilities": registration.capabilities,
            "status": "online",
            "last_seen": now,
            "active_job": node.get("active_job"),
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


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "hardware-aware-ai-runtime"}


@app.get("/api/devices")
def devices() -> list[dict[str, Any]]:
    return [device.to_dict() for device in discover_devices()]


@app.get("/api/runs")
def runs() -> list[dict[str, Any]]:
    return [record.snapshot() for record in reversed(list(_runs.values()))]


@app.get("/api/runs/{run_id}")
def run_status(run_id: str) -> dict[str, Any]:
    record = _runs.get(run_id)
    if not record:
        raise HTTPException(status_code=404, detail="Run not found")
    return record.snapshot()


@app.post("/api/runs", status_code=202)
def start_run(request: MatmulRunRequest) -> dict[str, Any]:
    if request.target_node == "local":
        try:
            get_device_info(request.backend)
        except (ValueError, RuntimeError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        runner = _run_benchmark
        runner_args = (None,)
    else:
        node = _nodes.get(request.target_node)
        if not node or node.get("status") != "online":
            raise HTTPException(status_code=400, detail=f"Node '{request.target_node}' is not online")
        capabilities = {device["backend"]: device for device in node["capabilities"]}
        if not capabilities.get(request.backend, {}).get("available", False):
            raise HTTPException(status_code=400, detail=f"Backend '{request.backend}' is unavailable on node '{request.target_node}'")
        runner = _run_remote_benchmark
        runner_args = (node,)
    record = RunRecord(request)
    _runs[record.id] = record
    if request.target_node == "local":
        _executor.submit(runner, record)
    else:
        _executor.submit(runner, record, *runner_args)
    return record.snapshot()


@app.websocket("/api/runs/{run_id}/events")
async def run_events(websocket: WebSocket, run_id: str) -> None:
    await websocket.accept()
    record = _runs.get(run_id)
    if not record:
        await websocket.send_json({"type": "failed", "error": "Run not found"})
        await websocket.close(code=1008)
        return

    sent = 0
    try:
        while True:
            with record.condition:
                if sent >= len(record.events) and record.status not in {"completed", "failed"}:
                    record.condition.wait(timeout=0.5)
                events = record.events[sent:]
                sent = len(record.events)
            for event in events:
                await websocket.send_json(event)
            if record.status in {"completed", "failed"} and sent >= len(record.events):
                break
            await asyncio.sleep(0)
    except WebSocketDisconnect:
        return

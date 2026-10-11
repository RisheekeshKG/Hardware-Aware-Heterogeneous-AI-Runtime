"""Live HTTP and WebSocket API for real benchmark execution."""

from __future__ import annotations

import asyncio
import os
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
    try:
        get_device_info(request.backend)
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    record = RunRecord(request)
    _runs[record.id] = record
    _executor.submit(_run_benchmark, record)
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

"""Pydantic request shapes plus the in-memory records they produce."""

from __future__ import annotations

import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field


class MatmulRunRequest(BaseModel):
    workload: Literal["matmul", "image", "tree"] = "matmul"
    size: int = Field(default=1024, ge=1, le=16384)
    backend: Literal["cpu", "mps", "cuda"] = "cpu"
    warmup_iterations: int = Field(default=3, ge=0, le=1000)
    measured_iterations: int = Field(default=10, ge=1, le=1000)
    seed: int = Field(default=42)
    target_node: str = "local"
    batch_size: int = Field(default=8, ge=1, le=4096)
    image_size: int = Field(default=32, ge=4, le=1024)
    depth: int = Field(default=12, ge=1, le=20)
    traversal_count: int = Field(default=4096, ge=1, le=1_000_000)


class NodeRegistration(BaseModel):
    node_id: str
    name: str
    base_url: str
    capabilities: list[dict[str, Any]]
    host: dict[str, Any] = Field(default_factory=dict)


class NodeHeartbeat(BaseModel):
    node_id: str
    active_job: str | None = None


class NodeConnectRequest(BaseModel):
    worker_url: str
    name: str | None = None
    node_id: str = ""


class DiscoveryConnectRequest(BaseModel):
    node_id: str
    name: str | None = None


class NodeRenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class ScriptRunRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=1_000_000)
    args: list[str] = Field(default_factory=list, max_length=32)
    target_node: str = "local"
    # Hard timeout for the user script. 0 disables the limit (not recommended). The default
    # matches subprocess_runner.DEFAULT_SCRIPT_TIMEOUT_SECONDS and prevents a runaway script
    # from pinning a worker forever.
    timeout_seconds: float = Field(default=600.0, ge=0.0, le=86_400.0)
    # If set, a retry (same key within 5 minutes) is deduped: the server returns the existing
    # record instead of starting another run. A client picks any random string per logical
    # submission — common pattern is a UUID generated client-side right before the POST.
    idempotency_key: str | None = Field(default=None, max_length=128)


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

    def trace_snapshot(self) -> dict[str, Any]:
        """Expose measured workload phases without inventing kernel telemetry."""

        latency_seconds = (self.result or {}).get("latency_seconds", {}).get("median")
        operations = [
            {
                "name": self.request.workload,
                "type": "compute",
                "backend": self.request.backend,
                "duration_seconds": latency_seconds,
                "measured": latency_seconds is not None,
                "status": self.status,
            }
        ]
        if self.request.target_node != "local":
            operations.insert(
                0,
                {
                    "name": "remote_dispatch",
                    "type": "transfer",
                    "backend": "network",
                    "duration_seconds": self.network_round_trip_ms / 1000 if self.network_round_trip_ms is not None else None,
                    "measured": self.network_round_trip_ms is not None,
                    "status": self.status,
                },
            )
        return {
            "run_id": self.id,
            "status": self.status,
            "workload": self.request.workload,
            "backend": self.request.backend,
            "target_node": self.request.target_node,
            "operations": operations,
            "result": self.result,
        }


class ScriptRecord:
    def __init__(self, request: ScriptRunRequest) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.request = request
        self.status = "queued"
        self.output = ""
        self.error: str | None = None
        self.exit_code: int | None = None
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.updated_at = self.created_at
        self.started_at: str | None = None  # when the interpreter actually started
        self.finished_at: str | None = None  # when it returned (local) or the worker reported done
        self.remote_execute_seconds: float | None = None  # end-to-end on the worker, from its monotonic clock
        self.timed_out: bool = False
        # Streaming output: each chunk is {seq, stream, text, at}. The SSE endpoint replays
        # all existing chunks on connect and then pushes new ones as they arrive. `output`
        # remains the concatenated tail-100k view for clients that just want the final text.
        self.chunks: list[dict[str, Any]] = []
        self._chunks_lock = threading.Lock()
        self._chunks_event = threading.Event()

    def append_chunk(self, stream: str, text: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._chunks_lock:
            seq = len(self.chunks)
            self.chunks.append({"seq": seq, "stream": stream, "text": text, "at": now})
            self.output = (self.output + text)[-100_000:]
            self.updated_at = now
        self._chunks_event.set()
        self._chunks_event.clear()

    def chunks_since(self, since: int) -> list[dict[str, Any]]:
        with self._chunks_lock:
            return [c for c in self.chunks if c["seq"] > since]

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "filename": self.request.filename,
            "args": self.request.args,
            "target_node": self.request.target_node,
            "output": self.output,
            "error": self.error,
            "exit_code": self.exit_code,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "remote_execute_seconds": self.remote_execute_seconds,
            "timed_out": self.timed_out,
        }


def validate_script_filename(filename: str) -> str:
    path = Path(filename)
    if path.name != filename or path.suffix.lower() != ".py":
        raise ValueError("Choose a single Python file with a .py extension")
    return path.name

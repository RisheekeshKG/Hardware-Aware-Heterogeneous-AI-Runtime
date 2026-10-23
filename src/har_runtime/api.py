"""Live HTTP and WebSocket API for real benchmark execution."""

from __future__ import annotations

import asyncio
import contextlib
import io
import os
from pathlib import Path
import runpy
import socket
import sys
import tempfile
import time
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .benchmark import run_workload
from .discovery import DiscoveryRegistry
from .devices import discover_devices, get_device_info, system_info


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

_runs: dict[str, RunRecord] = {}
_nodes: dict[str, dict[str, Any]] = {}
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="har-benchmark")
_script_runs: dict[str, "ScriptRecord"] = {}


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
        self.remote_execute_seconds: float | None = None  # end-to-end on the worker, from its own clock

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
        }


def _validate_script_filename(filename: str) -> str:
    path = Path(filename)
    if path.name != filename or path.suffix.lower() != ".py":
        raise ValueError("Choose a single Python file with a .py extension")
    return path.name


def _run_script_in_process(record: ScriptRecord) -> None:
    """Run a user-approved file without invoking a shell command."""

    record.status = "running"
    record.started_at = datetime.now(timezone.utc).isoformat()
    record.updated_at = record.started_at
    try:
        with tempfile.TemporaryDirectory(prefix="har-job-") as directory:
            script_path = Path(directory) / record.request.filename
            script_path.write_text(record.request.content, encoding="utf-8")
            previous_argv = sys.argv
            sys.argv = [str(script_path), *record.request.args]
            output = io.StringIO()
            try:
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                    runpy.run_path(str(script_path), run_name="__main__")
            finally:
                sys.argv = previous_argv
            record.output = output.getvalue()[-100_000:]
            record.exit_code = 0
            record.status = "completed"
    except SystemExit as error:
        record.exit_code = int(error.code) if isinstance(error.code, int) else 1
        record.error = None if record.exit_code == 0 else str(error)
        record.status = "completed" if record.exit_code == 0 else "failed"
    except Exception as error:  # Keep user script failures visible to the app.
        record.error = str(error)
        record.status = "failed"
    finally:
        record.finished_at = datetime.now(timezone.utc).isoformat()
        record.updated_at = record.finished_at
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


@app.get("/api/runtime/role")
def runtime_role() -> dict[str, str]:
    return {"role": _session["role"]}


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
        result = run_workload(
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
def disconnect_node(node_id: str) -> dict[str, str]:
    """Remove a node from this host's roster.

    Workers are not told; their trust state belongs to the worker's own pairing flow.
    After this call, the UI stops offering the node as a target until it registers again.
    """

    removed = _nodes.pop(node_id, None)
    if removed is None:
        raise HTTPException(status_code=404, detail="Node is not registered")
    return {"status": "disconnected", "node_id": node_id}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "hardware-aware-ai-runtime"}


@app.get("/api/devices")
def devices() -> list[dict[str, Any]]:
    return [device.to_dict() for device in discover_devices()]


@app.get("/api/system")
def system() -> dict[str, Any]:
    return {"host": system_info(), "devices": devices()}


@app.get("/api/session")
def session() -> dict[str, Any]:
    return {**_session, "connected_workers": len(_nodes)}


CONNECT_APPROVAL_TIMEOUT_SECONDS = 120.0
DEFAULT_WORKER_PORT = 9000


def _normalize_worker_url(raw: str) -> str:
    """Accept "192.168.1.25", "192.168.1.25:9000" or a full URL."""

    value = raw.strip().rstrip("/")
    if "://" not in value:
        value = f"http://{value}"
    parsed = urlsplit(value)
    if not parsed.hostname:
        raise HTTPException(status_code=422, detail="Enter the other computer's address, e.g. 192.168.1.25")
    netloc = parsed.netloc if parsed.port else f"{parsed.netloc}:{DEFAULT_WORKER_PORT}"
    return urlunsplit((parsed.scheme, netloc, "", "", ""))


def _local_worker_url() -> str:
    return os.getenv("HAR_LOCAL_WORKER_URL", f"http://127.0.0.1:{DEFAULT_WORKER_PORT}")


@app.get("/api/pairing")
def pairing_requests() -> list[dict[str, Any]]:
    """Pending connection requests on this computer's worker (empty when not a worker).

    Raises on worker-side failures instead of swallowing them so the UI can tell the user
    "the worker service isn't reachable" rather than silently showing no pending requests.
    """

    import httpx

    if _session["role"] != "worker":
        return []
    try:
        response = httpx.get(f"{_local_worker_url()}/worker/pairing", timeout=2.0)
        response.raise_for_status()
        return response.json()
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"This computer's worker service isn't responding: {error}") from error
    except ValueError as error:
        raise HTTPException(status_code=502, detail=f"Worker returned an unexpected response: {error}") from error


@app.get("/api/trusted-hosts")
def trusted_hosts() -> list[dict[str, Any]]:
    """Hosts the local worker will accept jobs from (empty when not a worker)."""

    import httpx

    if _session["role"] != "worker":
        return []
    try:
        response = httpx.get(f"{_local_worker_url()}/worker/trusted-hosts", timeout=2.0)
        response.raise_for_status()
        return response.json()
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"Worker service isn't responding: {error}") from error


@app.delete("/api/trusted-hosts/{client_ip}")
def revoke_trusted_host(client_ip: str) -> dict[str, Any]:
    """Forget a trusted host so this worker refuses future jobs from that IP."""

    import httpx

    if _session["role"] != "worker":
        raise HTTPException(status_code=400, detail="This computer isn't in Worker mode")
    try:
        response = httpx.delete(f"{_local_worker_url()}/worker/trusted-hosts/{client_ip}", timeout=5.0)
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"Worker service isn't responding: {error}") from error
    if response.status_code >= 400:
        detail = response.json().get("detail", response.text) if response.content else response.reason_phrase
        raise HTTPException(status_code=response.status_code, detail=detail)
    return response.json()


@app.post("/api/pairing/{request_id}/{decision}")
def decide_pairing(request_id: str, decision: Literal["accept", "decline"]) -> dict[str, Any]:
    import httpx

    try:
        response = httpx.post(f"{_local_worker_url()}/worker/pairing/{request_id}/{decision}", timeout=5.0)
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"Worker service is not running: {error}") from error
    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=response.json().get("detail", response.text))
    return response.json()


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
                    return response.json()
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
    return _discovery_registry().list_nodes()


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


def _run_remote_script(record: ScriptRecord, node: dict[str, Any]) -> None:
    import httpx

    record.status = "running"
    record.started_at = datetime.now(timezone.utc).isoformat()
    record.updated_at = record.started_at
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.post(f"{node['base_url']}/worker/scripts", json=record.request.model_dump())
            response.raise_for_status()
            worker_run_id = response.json()["id"]
            node["active_job"] = record.id
            while True:
                worker_response = client.get(f"{node['base_url']}/worker/scripts/{worker_run_id}")
                worker_response.raise_for_status()
                worker_record = worker_response.json()
                record.status = worker_record["status"]
                record.output = worker_record.get("output", "")
                record.error = worker_record.get("error")
                record.exit_code = worker_record.get("exit_code")
                if record.status in {"completed", "failed"}:
                    # Pull the worker-side timing when available so we can show transport vs execute.
                    worker_started = worker_record.get("started_at") or worker_record.get("created_at")
                    worker_finished = worker_record.get("finished_at") or worker_record.get("updated_at")
                    if worker_started and worker_finished:
                        try:
                            start_dt = datetime.fromisoformat(worker_started.replace("Z", "+00:00"))
                            end_dt = datetime.fromisoformat(worker_finished.replace("Z", "+00:00"))
                            record.remote_execute_seconds = max((end_dt - start_dt).total_seconds(), 0.0)
                        except ValueError:
                            record.remote_execute_seconds = None
                    break
                time.sleep(0.25)
    except Exception as error:
        record.status = "failed"
        record.error = f"Remote device '{record.request.target_node}' failed: {error}"
    finally:
        record.finished_at = datetime.now(timezone.utc).isoformat()
        record.updated_at = record.finished_at
        node["active_job"] = None


@app.get("/api/scripts")
def scripts() -> list[dict[str, Any]]:
    return [record.snapshot() for record in reversed(list(_script_runs.values()))]


@app.get("/api/scripts/{script_id}")
def script_status(script_id: str) -> dict[str, Any]:
    record = _script_runs.get(script_id)
    if not record:
        raise HTTPException(status_code=404, detail="Script run not found")
    return record.snapshot()


@app.post("/api/scripts", status_code=202)
def start_script(request: ScriptRunRequest) -> dict[str, Any]:
    try:
        _validate_script_filename(request.filename)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    record = ScriptRecord(request)
    _script_runs[record.id] = record
    if request.target_node == "local":
        _executor.submit(_run_script_in_process, record)
    else:
        node = _nodes.get(request.target_node)
        if not node or node.get("status") != "online":
            raise HTTPException(status_code=400, detail=f"Device '{request.target_node}' is not online")
        _executor.submit(_run_remote_script, record, node)
    return record.snapshot()


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


@app.get("/api/runs")
def runs() -> list[dict[str, Any]]:
    return [record.snapshot() for record in reversed(list(_runs.values()))]


@app.get("/api/runs/{run_id}")
def run_status(run_id: str) -> dict[str, Any]:
    record = _runs.get(run_id)
    if not record:
        raise HTTPException(status_code=404, detail="Run not found")
    return record.snapshot()


@app.get("/api/runs/{run_id}/trace")
def run_trace(run_id: str) -> dict[str, Any]:
    record = _runs.get(run_id)
    if not record:
        raise HTTPException(status_code=404, detail="Run not found")
    return record.trace_snapshot()


@app.get("/api/runtime")
def runtime_snapshot() -> dict[str, Any]:
    """Return the live state needed by the desktop runtime console."""

    visible_nodes = nodes()
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
    # HTTP middleware does not cover websockets; apply the same local-only rule.
    if (websocket.client.host if websocket.client else "") not in LOOPBACK_CLIENTS:
        await websocket.close(code=1008)
        return
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

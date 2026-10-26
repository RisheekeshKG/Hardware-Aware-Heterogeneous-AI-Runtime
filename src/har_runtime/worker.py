"""Remote worker service for executing real PyTorch workloads."""

from __future__ import annotations

import os
from pathlib import Path
import contextlib
import io
import runpy
import socket
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import json

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .api import MatmulRunRequest, ScriptRunRequest
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


class WorkerScriptRun:
    def __init__(self, request: ScriptRunRequest) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.request = request
        self.status = "queued"
        self.output = ""
        self.error: str | None = None
        self.exit_code: int | None = None
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.started_at: str | None = None
        self.finished_at: str | None = None
        self.execute_seconds: float | None = None  # monotonic, so skew-free
        self.timed_out: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "filename": self.request.filename,
            "output": self.output,
            "error": self.error,
            "exit_code": self.exit_code,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "execute_seconds": self.execute_seconds,
            "timed_out": self.timed_out,
        }


class WorkerJoinRequest(BaseModel):
    coordinator: str
    name: str = ""
    node_id: str = ""


worker_app = FastAPI(title="Hardware-Aware AI Runtime Worker", version="0.2.0")
_worker_runs: dict[str, WorkerRun] = {}
_worker_script_runs: dict[str, WorkerScriptRun] = {}
_worker_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="har-worker")
_worker_config: dict[str, Any] = {}
_state_dir = Path.home() / ".har-runtime"
_node_id_path = _state_dir / "node-id"
_trusted_hosts_path = _state_dir / "trusted-hosts.json"
_discovery_beacon: DiscoveryBeacon | None = None
# Bumped on every (re)configuration so a previous registration loop stops.
_registration_generation = 0
_config_lock = threading.Lock()

LOOPBACK_CLIENTS = {"127.0.0.1", "::1", "localhost", "testclient"}
PAIRING_REQUEST_TTL_SECONDS = 120.0
# Hosts approved on this machine, by IP. Only they (and this machine) may run work here.
_trusted_hosts: set[str] = set()
_pairing_requests: dict[str, dict[str, Any]] = {}
_pairing_lock = threading.Lock()
# What the person at this computer sees about the host it works for.
HOST_CONTACT_TIMEOUT_SECONDS = 15.0
_connection: dict[str, Any] = {
    "connected_at": None,
    "last_contact": None,
    "last_error": None,
    "disconnected_by_host": False,
    "jobs_received": 0,
    "last_job_at": None,
}
_connection_lock = threading.Lock()


def _load_trusted_hosts() -> None:
    try:
        stored = json.loads(_trusted_hosts_path.read_text(encoding="utf-8"))
        _trusted_hosts.update(str(host) for host in stored if host)
    except (OSError, ValueError, TypeError):
        pass


def _save_trusted_hosts() -> None:
    try:
        _state_dir.mkdir(parents=True, exist_ok=True)
        _trusted_hosts_path.write_text(json.dumps(sorted(_trusted_hosts)), encoding="utf-8")
    except OSError:
        pass


_load_trusted_hosts()


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def _is_loopback_client(request: Request) -> bool:
    return _client_ip(request) in LOOPBACK_CLIENTS


def _require_trusted(request: Request) -> None:
    client = _client_ip(request)
    if client in LOOPBACK_CLIENTS or client in _trusted_hosts:
        return
    raise HTTPException(status_code=403, detail="This computer has not accepted a connection from you")


def _require_loopback(request: Request) -> None:
    if not _is_loopback_client(request):
        raise HTTPException(status_code=403, detail="Only available on this computer")


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


def _execute_script(record: WorkerScriptRun) -> None:
    """Run the submitted script in an isolated subprocess with a hard timeout.

    The worker now mirrors the host-side path from api.py: subprocess isolation
    means a bad user script can't kill the worker service, timeouts are enforced
    at the OS level, and `execute_seconds` comes from a monotonic clock so the
    host doesn't have to subtract wall-clock timestamps that could skew.
    """

    from .subprocess_runner import DEFAULT_SCRIPT_TIMEOUT_SECONDS, run_script_in_subprocess

    record.status = "running"
    record.started_at = datetime.now(timezone.utc).isoformat()
    try:
        with tempfile.TemporaryDirectory(prefix="har-worker-job-") as directory:
            result = run_script_in_subprocess(
                filename=Path(record.request.filename).name,
                content=record.request.content,
                args=record.request.args,
                cwd=Path(directory),
                timeout_seconds=record.request.timeout_seconds or DEFAULT_SCRIPT_TIMEOUT_SECONDS,
            )
            output_parts = [result["stdout"]]
            if result["stderr"]:
                output_parts.append(result["stderr"])
            record.output = "".join(output_parts)[-100_000:]
            record.exit_code = result["exit_code"]
            record.execute_seconds = result["execute_seconds"]
            record.timed_out = bool(result["timed_out"])
            if result["timed_out"]:
                record.status = "failed"
                record.error = f"Script exceeded {record.request.timeout_seconds:g}s"
            elif result["exit_code"] == 0:
                record.status = "completed"
            else:
                record.status = "failed"
                record.error = result["stderr"][-4000:] or f"Exit code {result['exit_code']}"
    except Exception as error:
        record.error = str(error)
        record.status = "failed"
    finally:
        record.finished_at = datetime.now(timezone.utc).isoformat()


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


@worker_app.get("/worker/env-hash")
def worker_env_hash() -> dict[str, object]:
    """Return this worker's Python + key-package fingerprint.

    The host calls this before dispatching to warn the user if the worker is missing
    `torch` or runs a different major version — the common silent failure.
    """

    from .env_hash import env_fingerprint

    return env_fingerprint()


@worker_app.post("/worker/join", response_model=None)
def join_host(request: WorkerJoinRequest, http_request: Request) -> dict[str, Any] | JSONResponse:
    """Join a host once the person at this computer has accepted it.

    Unknown hosts get a 202 "pending" answer and a pairing request that the
    desktop app shows as an Accept/Decline prompt. The host keeps calling this
    endpoint until the request is accepted (200) or declined (403).
    """

    if not _worker_config.get("allow_connections", True):
        raise HTTPException(status_code=403, detail="Worker is not accepting host connections")
    client = _client_ip(http_request)
    if client not in LOOPBACK_CLIENTS and client not in _trusted_hosts:
        pending = _pairing_request_for(client, request)
        if pending["status"] == "declined":
            raise HTTPException(status_code=403, detail="The connection was declined on that computer")
        if pending["status"] != "accepted":
            return JSONResponse(status_code=202, content={"status": "pending", "request_id": pending["id"]})
    configure_worker(
        coordinator=request.coordinator,
        base_url=_worker_config["advertise_url"],
        name=request.name or _default_name(),
        node_id=request.node_id or stable_node_id(),
    )
    return {"status": "joining", "node_id": _worker_config["node_id"], "coordinator": request.coordinator}


def _pairing_request_for(client: str, request: WorkerJoinRequest) -> dict[str, Any]:
    now = time.monotonic()
    with _pairing_lock:
        for record_id, record in list(_pairing_requests.items()):
            if now - record["last_seen"] > PAIRING_REQUEST_TTL_SECONDS:
                del _pairing_requests[record_id]
        for record in _pairing_requests.values():
            if record["client_ip"] == client:
                record["last_seen"] = now
                record["coordinator"] = request.coordinator
                return record
        record = {
            "id": uuid.uuid4().hex[:12],
            "client_ip": client,
            "coordinator": request.coordinator,
            "status": "pending",
            "requested_at": datetime.now(timezone.utc).isoformat(),
            "last_seen": now,
        }
        _pairing_requests[record["id"]] = record
        return record


@worker_app.get("/worker/pairing")
def pairing_requests(http_request: Request) -> list[dict[str, Any]]:
    _require_loopback(http_request)
    with _pairing_lock:
        return [
            {key: value for key, value in record.items() if key != "last_seen"}
            for record in _pairing_requests.values()
            if record["status"] == "pending"
        ]


@worker_app.post("/worker/pairing/{request_id}/{decision}")
def decide_pairing(request_id: str, decision: str, http_request: Request) -> dict[str, Any]:
    _require_loopback(http_request)
    if decision not in {"accept", "decline"}:
        raise HTTPException(status_code=422, detail="Decision must be accept or decline")
    with _pairing_lock:
        record = _pairing_requests.get(request_id)
        if not record:
            raise HTTPException(status_code=404, detail="Connection request has expired")
        record["status"] = "accepted" if decision == "accept" else "declined"
    if decision == "accept":
        _trusted_hosts.add(record["client_ip"])
        _save_trusted_hosts()
    return {"id": request_id, "status": record["status"]}


@worker_app.get("/worker/trusted-hosts")
def list_trusted_hosts(http_request: Request) -> list[dict[str, Any]]:
    """Lists every IP this worker will accept jobs from. Loopback-only — the owner's own UI."""

    _require_loopback(http_request)
    return [{"client_ip": ip} for ip in sorted(_trusted_hosts)]


@worker_app.delete("/worker/trusted-hosts/{client_ip}")
def revoke_trusted_host(client_ip: str, http_request: Request) -> dict[str, Any]:
    """Remove an IP from the trusted set, persisted. Future jobs from it will be refused."""

    _require_loopback(http_request)
    if client_ip not in _trusted_hosts:
        raise HTTPException(status_code=404, detail="That host was not in the trusted list")
    _trusted_hosts.discard(client_ip)
    _save_trusted_hosts()
    return {"status": "revoked", "client_ip": client_ip}


@worker_app.post("/worker/runs", status_code=202)
def start_worker_run(request: MatmulRunRequest, http_request: Request) -> dict[str, Any]:
    _require_trusted(http_request)
    try:
        get_device_info(request.backend)
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    record = WorkerRun(request)
    _worker_runs[record.id] = record
    _worker_executor.submit(_execute, record)
    _record_job()
    return record.to_dict()


@worker_app.post("/worker/scripts", status_code=202)
def start_worker_script(request: ScriptRunRequest, http_request: Request) -> dict[str, Any]:
    _require_trusted(http_request)
    if Path(request.filename).name != request.filename or Path(request.filename).suffix.lower() != ".py":
        raise HTTPException(status_code=422, detail="Only a single .py file can be run")
    record = WorkerScriptRun(request)
    _worker_script_runs[record.id] = record
    _worker_executor.submit(_execute_script, record)
    _record_job()
    return record.to_dict()


@worker_app.get("/worker/scripts/{run_id}")
def worker_script_status(run_id: str, http_request: Request) -> dict[str, Any]:
    _require_trusted(http_request)
    record = _worker_script_runs.get(run_id)
    if not record:
        raise HTTPException(status_code=404, detail="Worker script run not found")
    return record.to_dict()


@worker_app.get("/worker/runs/{run_id}")
def worker_run_status(run_id: str, http_request: Request) -> dict[str, Any]:
    _require_trusted(http_request)
    record = _worker_runs.get(run_id)
    if not record:
        raise HTTPException(status_code=404, detail="Worker run not found")
    return record.to_dict()


def _record_job() -> None:
    with _connection_lock:
        _connection["jobs_received"] += 1
        _connection["last_job_at"] = datetime.now(timezone.utc).isoformat()


@worker_app.post("/worker/stop-serving-host")
def stop_serving_host(http_request: Request) -> dict[str, Any]:
    """Clear the remembered coordinator and halt the registration retry loop. Loopback-only."""

    _require_loopback(http_request)
    coordinator = _worker_config.get("coordinator") or ""
    if not coordinator:
        return {"status": "already-idle"}
    _stop_serving_host(_registration_generation)
    return {"status": "stopped", "coordinator": coordinator}


@worker_app.get("/worker/connection")
def connection_status(http_request: Request) -> dict[str, Any]:
    """Which host this worker serves and whether it can reach it right now. Loopback-only."""

    _require_loopback(http_request)
    coordinator = _worker_config.get("coordinator") or ""
    with _connection_lock:
        state = dict(_connection)
    last_contact = state.pop("last_contact")
    seconds_since_contact = time.monotonic() - last_contact if last_contact is not None else None
    if not coordinator:
        status = "disconnected" if state["disconnected_by_host"] else "waiting"
    elif seconds_since_contact is not None and seconds_since_contact <= HOST_CONTACT_TIMEOUT_SECONDS:
        status = "connected"
    else:
        status = "unreachable"
    running = sum(1 for record in [*_worker_runs.values(), *_worker_script_runs.values()] if record.status in {"queued", "running"})
    return {
        "status": status,
        "coordinator": coordinator,
        "host_ip": urlsplit(coordinator).hostname if coordinator else None,
        "seconds_since_contact": round(seconds_since_contact, 1) if seconds_since_contact is not None else None,
        "running_jobs": running,
        **state,
    }


def _registration_loop(generation: int) -> None:
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
    with httpx.Client(timeout=10.0) as client:
        while generation == _registration_generation:
            try:
                response = client.post(f"{coordinator}/api/nodes/register", json=registration)
                if response.status_code == 410:
                    # The host removed this computer; stop until a host connects again.
                    _stop_serving_host(generation)
                    return
                response.raise_for_status()
                client.post(f"{coordinator}/api/nodes/heartbeat", json={"node_id": registration["node_id"], "active_job": None})
                with _connection_lock:
                    now = time.monotonic()
                    if _connection["connected_at"] is None:
                        _connection["connected_at"] = datetime.now(timezone.utc).isoformat()
                    _connection["last_contact"] = now
                    _connection["last_error"] = None
            except httpx.HTTPError as error:
                with _connection_lock:
                    _connection["last_error"] = str(error) or type(error).__name__
            time.sleep(5)


def _stop_serving_host(generation: int) -> None:
    global _registration_generation
    with _config_lock:
        if generation != _registration_generation:
            return
        _registration_generation += 1
        _worker_config["coordinator"] = ""
    with _connection_lock:
        _connection.update(connected_at=None, last_contact=None, last_error=None, disconnected_by_host=True)
    try:
        _last_host_path.unlink()
    except OSError:
        pass


def _default_name() -> str:
    return socket.gethostname()


_last_host_path = _state_dir / "last-host.json"


def _remember_host(coordinator: str, name: str) -> None:
    try:
        _state_dir.mkdir(parents=True, exist_ok=True)
        _last_host_path.write_text(json.dumps({"coordinator": coordinator, "name": name}), encoding="utf-8")
    except OSError:
        pass


def _remembered_host() -> dict[str, str] | None:
    """Return the last accepted host, so a restarted worker rejoins it without a new prompt."""

    try:
        stored = json.loads(_last_host_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    coordinator = str(stored.get("coordinator") or "")
    if urlsplit(coordinator).hostname not in _trusted_hosts:
        return None
    return {"coordinator": coordinator, "name": str(stored.get("name") or "")}


def configure_worker(
    *,
    coordinator: str | None,
    base_url: str,
    name: str | None = None,
    node_id: str | None = None,
    allow_connections: bool = True,
) -> None:
    global _discovery_beacon, _registration_generation
    if not coordinator:
        remembered = _remembered_host()
        if remembered:
            coordinator = remembered["coordinator"]
            name = name or remembered["name"] or None
    elif not _is_local_url(coordinator):
        _remember_host(coordinator, name or "")
    resolved_node_id = node_id or stable_node_id()
    resolved_name = name or _default_name()
    resolved_advertise_url = _reachable_base_url(base_url)
    coordinator_is_local = bool(coordinator and _is_local_url(coordinator))
    resolved_base_url = base_url.rstrip("/") if coordinator_is_local and _is_local_url(base_url) else resolved_advertise_url
    with _config_lock:
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
        _registration_generation += 1
        generation = _registration_generation
        with _connection_lock:
            _connection.update(connected_at=None, last_contact=None, last_error=None, disconnected_by_host=False)
        if _discovery_beacon:
            _discovery_beacon.stop()
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
        threading.Thread(target=_registration_loop, args=(generation,), daemon=True, name="har-registration").start()

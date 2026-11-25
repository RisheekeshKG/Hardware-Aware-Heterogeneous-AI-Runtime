"""Stopping scripts: the subprocess runner, the host endpoint, and the host → worker path."""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path

import httpx
import psutil
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from har.runtime import worker
from har.runtime.api import app
from har.runtime.api import core as api_core
from har.runtime.api.jobs import run_script_in_process
from har.runtime.api.schemas import ScriptRecord, ScriptRunRequest
from har.runtime.subprocess_runner import run_script_in_subprocess


def _wait_for(predicate, timeout: float = 10.0, interval: float = 0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise AssertionError("condition not met in time")


def _gone(pid: int) -> bool:
    try:
        return psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return True


# --- subprocess runner -------------------------------------------------------------------

GRANDCHILD_SCRIPT = """
import signal, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c",
    "import signal, time; signal.signal(signal.SIGINT, signal.SIG_IGN); time.sleep(60)"])
print(f"grandchild={child.pid}", flush=True)
time.sleep(60)
"""


def test_runner_stops_script_and_grandchildren():
    cancel = threading.Event()
    seen: list[str] = []

    def on_chunk(_stream: str, text: str) -> None:
        seen.append(text)
        if "grandchild=" in text:
            cancel.set()

    with tempfile.TemporaryDirectory() as directory:
        started = time.monotonic()
        result = run_script_in_subprocess(
            filename="tree.py",
            content=GRANDCHILD_SCRIPT,
            args=[],
            cwd=Path(directory),
            timeout_seconds=30,
            on_chunk=on_chunk,
            cancel_event=cancel,
        )
    assert result["stopped"] is True
    assert result["timed_out"] is False
    assert time.monotonic() - started < 15
    assert "[har] Stopped by request." in result["stderr"]
    pid = int(re.search(r"grandchild=(\d+)", "".join(seen)).group(1))
    # The grandchild ignored SIGINT, so only the follow-up SIGKILL to the group gets it.
    _wait_for(lambda: _gone(pid), timeout=5)


def test_runner_cancelled_before_start_spawns_nothing():
    cancel = threading.Event()
    cancel.set()
    with tempfile.TemporaryDirectory() as directory:
        marker = Path(directory) / "ran.txt"
        result = run_script_in_subprocess(
            filename="never.py",
            content=f"open({str(marker)!r}, 'w').write('x')",
            args=[],
            cwd=Path(directory),
            cancel_event=cancel,
        )
        assert result["stopped"] is True
        assert result["exit_code"] is None
        assert not marker.exists()
        assert not (Path(directory) / "never.py").exists()


def test_runner_cancel_after_exit_is_a_no_op():
    cancel = threading.Event()
    with tempfile.TemporaryDirectory() as directory:
        result = run_script_in_subprocess(
            filename="quick.py",
            content="print('hi')",
            args=[],
            cwd=Path(directory),
            cancel_event=cancel,
        )
    cancel.set()
    assert result["stopped"] is False
    assert result["exit_code"] == 0


# --- host endpoint -----------------------------------------------------------------------

def _submit(client: TestClient, content: str, **extra) -> str:
    response = client.post("/api/scripts", json={"filename": "job.py", "content": content, "timeout_seconds": 30, **extra})
    assert response.status_code == 202, response.text
    return response.json()["id"]


def _status(client: TestClient, script_id: str) -> dict:
    return client.get(f"/api/scripts/{script_id}").json()


SLEEPER = "import time\nprint('started', flush=True)\ntime.sleep(30)\n"


def test_host_stop_running_script():
    client = TestClient(app)
    script_id = _submit(client, SLEEPER)
    _wait_for(lambda: "started" in _status(client, script_id)["output"])

    response = client.post(f"/api/scripts/{script_id}/stop")
    assert response.status_code == 202
    assert response.json()["stop_requested"] is True

    final = _wait_for(lambda: (s := _status(client, script_id))["status"] == "stopped" and s)
    assert "[har] Stopped by request." in final["output"]
    assert final["finished_at"]

    # Stopping again is fine, and the SSE stream ends with the stopped status.
    assert client.post(f"/api/scripts/{script_id}/stop").status_code == 202
    with client.stream("GET", f"/api/scripts/{script_id}/stream") as stream:
        done = None
        lines = stream.iter_lines()
        for line in lines:
            if line.startswith("event: done"):
                done = json.loads(next(lines)[len("data:"):])
                break
    assert done["status"] == "stopped"


def test_host_stop_finished_script_is_409_and_unknown_is_404():
    client = TestClient(app)
    script_id = _submit(client, "print('done')")
    _wait_for(lambda: _status(client, script_id)["status"] == "completed")
    response = client.post(f"/api/scripts/{script_id}/stop")
    assert response.status_code == 409
    assert _status(client, script_id)["status"] == "completed"
    assert client.post("/api/scripts/nope/stop").status_code == 404


def test_queued_run_stopped_before_it_starts_never_runs():
    record = ScriptRecord(ScriptRunRequest(filename="never.py", content="raise SystemExit(3)"))
    assert record.request_stop() == "stopped"
    assert record.status == "stopped"
    run_script_in_process(record)  # what the executor would do once a slot frees up
    assert record.status == "stopped"
    assert record.started_at is None
    assert record.exit_code is None
    assert "Stopped before it started" in record.output


def test_stream_since_skips_chunks_the_client_has():
    client = TestClient(app)
    script_id = _submit(client, "print('one', flush=True)\nprint('two', flush=True)\n")
    _wait_for(lambda: _status(client, script_id)["status"] == "completed")
    with client.stream("GET", f"/api/scripts/{script_id}/stream?since=0") as stream:
        payloads = []
        for line in stream.iter_lines():
            if line.startswith("data:") and '"seq"' in line:
                payloads.append(json.loads(line[len("data:"):]))
            if line.startswith("event: done"):
                break
    assert payloads and all(p["seq"] > 0 for p in payloads)


def test_script_list_can_leave_out_output():
    client = TestClient(app)
    script_id = _submit(client, "print('x' * 1000)")
    _wait_for(lambda: _status(client, script_id)["status"] == "completed")
    light = client.get("/api/scripts?include_output=false").json()
    assert all("output" not in run for run in light)
    full = client.get("/api/scripts").json()
    assert any("x" * 1000 in run.get("output", "") for run in full)


# --- host → worker -----------------------------------------------------------------------

class _InProcessClient:
    """Stands in for httpx.Client inside jobs.py and sends requests to an ASGI app."""

    def __init__(self, target_app):
        self._client = TestClient(target_app)

    def __call__(self, *args, **kwargs):
        return self

    def __enter__(self):
        return self._client

    def __exit__(self, *exc):
        return False


@pytest.fixture
def remote_node(monkeypatch):
    node_id = "stop-test-node"
    node = {"node_id": node_id, "name": "Test worker", "base_url": "http://testserver", "status": "online", "capabilities": []}
    monkeypatch.setitem(api_core._nodes, node_id, node)

    def use(target_app):
        monkeypatch.setattr(httpx, "Client", _InProcessClient(target_app))
        return node_id

    return use


def test_remote_stop_end_to_end(remote_node):
    node_id = remote_node(worker.worker_app)
    client = TestClient(app)
    script_id = _submit(client, SLEEPER, target_node=node_id)
    _wait_for(lambda: "started" in _status(client, script_id)["output"])

    assert client.post(f"/api/scripts/{script_id}/stop").status_code == 202
    final = _wait_for(lambda: (s := _status(client, script_id))["status"] == "stopped" and s, timeout=15)
    assert "[har] Stopped by request." in final["output"]
    assert worker._worker_script_runs[final["worker_run_id"]].status == "stopped"


def test_remote_stop_against_older_worker_explains(remote_node):
    old_worker = FastAPI()  # has scripts, but no /stop endpoint

    @old_worker.post("/worker/scripts", status_code=202)
    def submit():
        return {"id": "old-run"}

    @old_worker.get("/worker/scripts/old-run")
    def status():
        return {"id": "old-run", "status": "running", "output": "", "error": None, "exit_code": None}

    @old_worker.get("/worker/scripts/old-run/chunks")
    def chunks():
        return {"chunks": [], "status": "running", "exit_code": None}

    node_id = remote_node(old_worker)
    client = TestClient(app)
    script_id = _submit(client, SLEEPER, target_node=node_id)
    _wait_for(lambda: _status(client, script_id)["worker_run_id"] == "old-run")

    assert client.post(f"/api/scripts/{script_id}/stop").status_code == 202
    final = _wait_for(lambda: (s := _status(client, script_id))["status"] == "stopped" and s)
    assert "Update HAR there" in final["error"]


def test_untrusted_host_cannot_stop_worker_scripts(monkeypatch):
    monkeypatch.setattr(worker, "_trusted_hosts", set())
    monkeypatch.setattr(worker, "_host_secrets", {})
    stranger = TestClient(worker.worker_app, client=("10.0.0.66", 50000))
    assert stranger.post("/worker/scripts/anything/stop").status_code == 403


# --- rename ------------------------------------------------------------------------------

def test_rename_survives_re_registration():
    client = TestClient(app)
    registration = {"node_id": "rename-node", "name": "DESKTOP-7F3K", "base_url": "http://10.0.0.9:9000", "capabilities": []}
    try:
        assert client.post("/api/nodes/register", json=registration).status_code == 200
        assert client.post("/api/nodes/rename-node/rename", json={"name": "Gaming PC"}).status_code == 200
        client.post("/api/nodes/register", json=registration)  # the worker's next registration
        names = {node["node_id"]: node["name"] for node in client.get("/api/nodes").json()}
        assert names["rename-node"] == "Gaming PC"
    finally:
        api_core._nodes.pop("rename-node", None)
        api_core._node_aliases.pop("rename-node", None)


@pytest.fixture(autouse=True)
def _no_leftover_processes():
    yield
    if os.name != "nt":
        from har.runtime.subprocess_runner import kill_all_tracked

        kill_all_tracked()

"""`/api/runs*` endpoints: submit, list, status, trace, and the live-event WebSocket."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import HTTPException, WebSocket, WebSocketDisconnect

from ..devices import get_device_info
from ._core import LOOPBACK_CLIENTS, _executor, _nodes, _runs, app
from ._runners import run_benchmark, run_remote_benchmark
from .models import MatmulRunRequest, RunRecord


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


@app.post("/api/runs", status_code=202)
def start_run(request: MatmulRunRequest) -> dict[str, Any]:
    if request.target_node == "local":
        try:
            get_device_info(request.backend)
        except (ValueError, RuntimeError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        runner = run_benchmark
        runner_args: tuple[Any, ...] = ()
    else:
        node = _nodes.get(request.target_node)
        if not node or node.get("status") != "online":
            raise HTTPException(status_code=400, detail=f"Node '{request.target_node}' is not online")
        capabilities = {device["backend"]: device for device in node["capabilities"]}
        if not capabilities.get(request.backend, {}).get("available", False):
            raise HTTPException(status_code=400, detail=f"Backend '{request.backend}' is unavailable on node '{request.target_node}'")
        runner = run_remote_benchmark
        runner_args = (node,)
    record = RunRecord(request)
    _runs[record.id] = record
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

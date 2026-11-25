"""`/api/scripts*` endpoints: submit, status, stop, cursor chunks, SSE stream."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from .core import _executor, _nodes, _script_runs, app
from .jobs import run_remote_script, run_script_in_process
from .schemas import ACTIVE_STATUSES, ScriptRecord, ScriptRunRequest, validate_script_filename


@app.get("/api/scripts")
def scripts(include_output: bool = True) -> list[dict[str, Any]]:
    """Every run, newest first. The UI's list poll passes `include_output=false`: each run
    can carry up to 100 KB of output, and the list doesn't show it."""

    return [record.snapshot(include_output=include_output) for record in reversed(list(_script_runs.values()))]


@app.get("/api/scripts/{script_id}")
def script_status(script_id: str) -> dict[str, Any]:
    record = _script_runs.get(script_id)
    if not record:
        raise HTTPException(status_code=404, detail="Script run not found")
    return record.snapshot()


@app.post("/api/scripts/{script_id}/stop", status_code=202)
def stop_script(script_id: str) -> dict[str, Any]:
    """Stop a queued or running script. Safe to call twice.

    A queued run is final at once. A running one gets `stop_requested: true` and moves to
    `stopped` within a few seconds (SIGINT, then SIGKILL after 2 s; remote runs also wait
    for the worker to confirm). 409 if it already finished on its own.
    """

    record = _script_runs.get(script_id)
    if not record:
        raise HTTPException(status_code=404, detail="Script run not found")
    outcome = record.request_stop()
    if outcome == "finished" and record.status != "stopped":
        raise HTTPException(status_code=409, detail=f"This script already {record.status}")
    return record.snapshot()


@app.get("/api/scripts/{script_id}/chunks")
def script_chunks(script_id: str, since: int = -1) -> dict[str, Any]:
    """Cursor-based read of streamed output. `?since=N` returns every chunk with seq > N.

    This is what the host uses to pull incrementally from a remote worker, and it also
    serves as the fallback for UI contexts that can't open an SSE connection.
    """

    record = _script_runs.get(script_id)
    if not record:
        raise HTTPException(status_code=404, detail="Script run not found")
    return {
        "script_id": script_id,
        "chunks": record.chunks_since(since),
        "status": record.status,
        "exit_code": record.exit_code,
    }


@app.get("/api/scripts/{script_id}/stream")
async def script_stream(script_id: str, since: int = -1):
    """Server-Sent Events: pushes each new output chunk as it lands, then a terminal 'done'.

    The user-facing win: a 2-minute training script no longer sits as a blank panel. Output
    scrolls as it's produced, and the final `done` event carries exit_code + status so the
    client can stop listening cleanly without a separate HTTP call. `?since=N` skips chunks
    the client already has, so a reconnect doesn't replay the whole output.
    """

    import json as _json

    from fastapi.responses import StreamingResponse

    record = _script_runs.get(script_id)
    if not record:
        raise HTTPException(status_code=404, detail="Script run not found")

    async def generate():
        last_seq = since
        while True:
            chunks = record.chunks_since(last_seq)
            for chunk in chunks:
                yield f"data: {_json.dumps(chunk)}\n\n"
                last_seq = chunk["seq"]
            if record.status not in ACTIVE_STATUSES:
                # Give the pipe reader threads a last chance to flush before saying done.
                final = record.chunks_since(last_seq)
                for chunk in final:
                    yield f"data: {_json.dumps(chunk)}\n\n"
                    last_seq = chunk["seq"]
                yield f"event: done\ndata: {_json.dumps({'status': record.status, 'exit_code': record.exit_code, 'timed_out': record.timed_out})}\n\n"
                return
            # Keep the connection alive while we wait for more; comment lines are SSE heartbeats
            # that proxies won't mistake for a dead stream.
            yield ": keep-alive\n\n"
            await asyncio.sleep(0.2)

    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


_IDEMPOTENCY_WINDOW_SECONDS = 300.0


def _find_recent_idempotent_script(key: str) -> ScriptRecord | None:
    """Return a <5-minute-old record that matches this idempotency key, else None.

    The scan is linear over `_script_runs`, which is bounded by the UI's history size
    (~hundreds). Durable storage will move this to an index when the SQLite migration lands.
    """

    now = datetime.now(timezone.utc)
    for existing in _script_runs.values():
        if getattr(existing.request, "idempotency_key", None) != key:
            continue
        try:
            created = datetime.fromisoformat(existing.created_at)
        except ValueError:
            continue
        if (now - created).total_seconds() <= _IDEMPOTENCY_WINDOW_SECONDS:
            return existing
    return None


@app.post("/api/scripts", status_code=202)
def start_script(request: ScriptRunRequest) -> dict[str, Any]:
    try:
        validate_script_filename(request.filename)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    # Return the existing record on duplicate submission (e.g. network retry after a timeout)
    # so the user never ends up with two runs of the same script.
    if request.idempotency_key:
        existing = _find_recent_idempotent_script(request.idempotency_key)
        if existing is not None:
            return existing.snapshot()

    # Validate the target *before* creating the record so a 400 can't leave an orphan
    # queued row sitting in _script_runs forever (observed: GET /api/scripts kept
    # showing a never-progressing "queued" entry for a since-offline worker).
    node = None
    if request.target_node != "local":
        node = _nodes.get(request.target_node)
        if not node or node.get("status") != "online":
            raise HTTPException(status_code=400, detail=f"Device '{request.target_node}' is not online")

    record = ScriptRecord(request)
    _script_runs[record.id] = record
    if request.target_node == "local":
        _executor.submit(run_script_in_process, record)
    else:
        _executor.submit(run_remote_script, record, node)
    return record.snapshot()

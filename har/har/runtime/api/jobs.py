"""The four long-running jobs scheduled on the thread pool: local/remote × benchmark/script."""

from __future__ import annotations

import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..benchmark import run_workload
from .auth import _signed_headers_for
from .schemas import ACTIVE_STATUSES, RunRecord, ScriptRecord

# After asking a worker to stop a script, how long we wait for it to report a final
# status before giving up on it and marking the host's record stopped anyway.
REMOTE_STOP_CONFIRM_SECONDS = 15.0


def run_benchmark(record: RunRecord) -> None:
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


def run_remote_benchmark(record: RunRecord, node: dict[str, Any]) -> None:
    """Submit to a worker and poll its real execution state."""

    import json as _json

    import httpx

    record.status = "running"
    record.publish({"type": "status", "status": "running", "node_id": record.node_id})
    node_id = node.get("node_id", "")
    try:
        with httpx.Client(timeout=30.0) as client:
            started = time.perf_counter()
            submit_url = f"{node['base_url']}/worker/runs"
            submit_body = _json.dumps(record.request.model_dump()).encode("utf-8")
            response = client.post(
                submit_url,
                content=submit_body,
                headers={"Content-Type": "application/json", **_signed_headers_for(node_id, "POST", submit_url, submit_body)},
            )
            record.network_round_trip_ms = (time.perf_counter() - started) * 1000
            response.raise_for_status()
            worker_run_id = response.json()["id"]
            node["active_job"] = record.id
            while True:
                started = time.perf_counter()
                poll_url = f"{node['base_url']}/worker/runs/{worker_run_id}"
                status_response = client.get(poll_url, headers=_signed_headers_for(node_id, "GET", poll_url))
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
                if worker_record["status"] not in ACTIVE_STATUSES:
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


def run_script_in_process(record: ScriptRecord) -> None:
    """Run a user-approved file in an isolated subprocess with a hard timeout.

    Replacing the previous same-process runpy means a crashing / hanging user script
    can only harm its own OS process; the API stays responsive and we can SIGKILL the
    whole process group on timeout. Duration comes from `time.monotonic()` inside
    `subprocess_runner`, so it's immune to wall-clock jumps.
    """

    from ..subprocess_runner import DEFAULT_SCRIPT_TIMEOUT_SECONDS as _DEFAULT_SCRIPT_TIMEOUT_SECONDS
    from ..subprocess_runner import run_script_in_subprocess

    if not record.begin_running():
        return  # stopped while queued; request_stop already finalised the record
    try:
        with tempfile.TemporaryDirectory(prefix="har-job-") as directory:
            result = run_script_in_subprocess(
                filename=record.request.filename,
                content=record.request.content,
                args=record.request.args,
                cwd=Path(directory),
                timeout_seconds=record.request.timeout_seconds or _DEFAULT_SCRIPT_TIMEOUT_SECONDS,
                on_chunk=record.append_chunk,
                cancel_event=record.cancel_event,
            )
            # `record.output` was already populated incrementally by append_chunk. Fall back
            # to the aggregated buffer only if streaming produced nothing (very short scripts
            # that printed less than one flush boundary).
            if not record.output:
                output_parts = [result["stdout"]]
                if result["stderr"]:
                    output_parts.append(result["stderr"])
                record.output = "".join(output_parts)[-100_000:]
            record.exit_code = result["exit_code"]
            record.timed_out = bool(result["timed_out"])
            record.remote_execute_seconds = result["execute_seconds"]
            if result.get("stopped"):
                record.status = "stopped"
            elif result["timed_out"]:
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
        record.updated_at = record.finished_at


def run_remote_script(record: ScriptRecord, node: dict[str, Any]) -> None:
    import json as _json

    import httpx

    if not record.begin_running():
        return  # stopped while queued; nothing was sent to the worker
    node_id = node.get("node_id", "")
    try:
        with httpx.Client(timeout=30.0) as client:
            submit_url = f"{node['base_url']}/worker/scripts"
            submit_body = _json.dumps(record.request.model_dump()).encode("utf-8")
            response = client.post(
                submit_url,
                content=submit_body,
                headers={"Content-Type": "application/json", **_signed_headers_for(node_id, "POST", submit_url, submit_body)},
            )
            response.raise_for_status()
            worker_run_id = response.json()["id"]
            record.worker_run_id = worker_run_id
            node["active_job"] = record.id
            last_chunk_seq = -1
            stop_deadline: float | None = None

            def drain_chunks() -> None:
                # The cursor lives on the host, so re-reading never double-appends output.
                nonlocal last_chunk_seq
                chunks_url = f"{node['base_url']}/worker/scripts/{worker_run_id}/chunks?since={last_chunk_seq}"
                try:
                    chunk_response = client.get(chunks_url, headers=_signed_headers_for(node_id, "GET", chunks_url))
                    chunk_response.raise_for_status()
                    for chunk in chunk_response.json().get("chunks", []):
                        record.append_chunk(chunk["stream"], chunk["text"])
                        last_chunk_seq = max(last_chunk_seq, chunk.get("seq", last_chunk_seq))
                except Exception:
                    # Older workers don't have /chunks; the status poll's aggregated
                    # `output` below is the fallback.
                    pass

            while True:
                if record.cancel_event.is_set() and stop_deadline is None:
                    stop_deadline = time.monotonic() + REMOTE_STOP_CONFIRM_SECONDS
                    if not _ask_worker_to_stop(client, node, node_id, worker_run_id, record):
                        return

                drain_chunks()

                poll_url = f"{node['base_url']}/worker/scripts/{worker_run_id}"
                worker_response = client.get(poll_url, headers=_signed_headers_for(node_id, "GET", poll_url))
                worker_response.raise_for_status()
                worker_record = worker_response.json()
                # Only overwrite `output` from the status poll if streaming has produced nothing —
                # otherwise the status poll's aggregated snapshot would stomp on our live chunks.
                if not record.chunks:
                    record.output = worker_record.get("output", "")
                record.error = worker_record.get("error")
                record.exit_code = worker_record.get("exit_code")
                # The worker may report "queued" while its single slot is busy; the host
                # keeps showing "running" until the worker reports a final status.
                if worker_record["status"] not in ACTIVE_STATUSES:
                    # Lines printed between the last drain and the exit would otherwise be lost.
                    drain_chunks()
                    record.status = worker_record["status"]
                    # Prefer the worker's monotonic execute_seconds — immune to clock skew between
                    # host and worker. Only fall back to subtracting ISO timestamps if the worker
                    # is older than 1.0.2 and didn't send it.
                    monotonic = worker_record.get("execute_seconds")
                    if isinstance(monotonic, (int, float)) and monotonic >= 0:
                        record.remote_execute_seconds = float(monotonic)
                    else:
                        worker_started = worker_record.get("started_at") or worker_record.get("created_at")
                        worker_finished = worker_record.get("finished_at") or worker_record.get("updated_at")
                        if worker_started and worker_finished:
                            try:
                                start_dt = datetime.fromisoformat(worker_started.replace("Z", "+00:00"))
                                end_dt = datetime.fromisoformat(worker_finished.replace("Z", "+00:00"))
                                record.remote_execute_seconds = max((end_dt - start_dt).total_seconds(), 0.0)
                            except ValueError:
                                record.remote_execute_seconds = None
                    record.timed_out = bool(worker_record.get("timed_out", False))
                    break
                if stop_deadline is not None and time.monotonic() > stop_deadline:
                    record.status = "stopped"
                    record.error = (
                        f"Asked the other computer to stop this script, but it didn't confirm within "
                        f"{REMOTE_STOP_CONFIRM_SECONDS:g} s. It may still be running there."
                    )
                    break
                time.sleep(0.25)
    except Exception as error:
        record.status = "failed"
        record.error = f"Remote device '{record.request.target_node}' failed: {error}"
    finally:
        record.finished_at = datetime.now(timezone.utc).isoformat()
        record.updated_at = record.finished_at
        node["active_job"] = None


def _ask_worker_to_stop(client, node: dict[str, Any], node_id: str, worker_run_id: str, record: ScriptRecord) -> bool:
    """Send the signed stop request. Returns False when the host should stop polling now.

    A 404 or 405 here means the worker runs a HAR version without the stop endpoint
    (a new worker answers 404 only for an unknown run, which we treat the same way:
    there is nothing left to stop there).
    """

    stop_url = f"{node['base_url']}/worker/scripts/{worker_run_id}/stop"
    try:
        response = client.post(stop_url, content=b"", headers=_signed_headers_for(node_id, "POST", stop_url, b""))
    except Exception as error:
        record.append_chunk("stderr", f"[har] Could not reach the other computer to stop the script: {error}\n")
        return True  # keep polling; the confirm deadline ends this if it never answers
    if response.status_code in {404, 405}:
        record.status = "stopped"
        record.error = (
            "The other computer's HAR version can't stop scripts. Update HAR there. "
            "The script may still be running on that computer."
        )
        return False
    # 409 = it finished on its own before the stop arrived; the next poll picks that up.
    return True

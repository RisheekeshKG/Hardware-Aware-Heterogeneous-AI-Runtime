"""Tests for the SSE / cursor streaming path on scripts."""

import json
import time

from fastapi.testclient import TestClient

from har.runtime.api import app


def _submit_slow(client: TestClient, idx: int = 0, sleep: float = 0.3):
    code = (
        f"import sys, time\n"
        f"print('tick-{idx}-start', flush=True)\n"
        f"time.sleep({sleep})\n"
        f"print('tick-{idx}-end', flush=True)\n"
    )
    response = client.post(
        "/api/scripts",
        json={"filename": f"t_{idx}.py", "content": code, "timeout_seconds": 10},
    )
    assert response.status_code == 202
    return response.json()["id"]


def test_chunks_endpoint_grows_as_subprocess_prints():
    client = TestClient(app)
    script_id = _submit_slow(client, idx=0, sleep=0.3)

    # Poll /chunks for up to 10 s, collecting everything the subprocess emits.
    deadline = time.time() + 10
    all_chunks: list[dict] = []
    last_seq = -1
    while time.time() < deadline:
        response = client.get(f"/api/scripts/{script_id}/chunks?since={last_seq}")
        payload = response.json()
        for chunk in payload["chunks"]:
            all_chunks.append(chunk)
            last_seq = max(last_seq, chunk["seq"])
        if payload["status"] in {"completed", "failed"} and payload["chunks"] == []:
            break
        time.sleep(0.1)

    texts = "".join(c["text"] for c in all_chunks)
    assert "tick-0-start" in texts, texts
    assert "tick-0-end" in texts, texts
    seqs = [c["seq"] for c in all_chunks]
    assert seqs == sorted(seqs), "chunks should arrive in monotonically-increasing seq order"


def test_stream_endpoint_emits_data_and_done():
    client = TestClient(app)
    script_id = _submit_slow(client, idx=1, sleep=0.1)

    with client.stream("GET", f"/api/scripts/{script_id}/stream") as response:
        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]

        data_payloads: list[dict] = []
        got_done = False
        deadline = time.time() + 10
        for raw in response.iter_lines():
            if time.time() > deadline:
                break
            if raw is None:
                continue
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="replace")
            line = raw.rstrip()
            if line.startswith("data:"):
                payload = json.loads(line[len("data:"):].strip())
                data_payloads.append(payload)
            elif line.startswith("event: done"):
                got_done = True
            if got_done and line == "":
                break

    assert got_done, "SSE stream must end with a `done` event"
    joined = "".join(p.get("text", "") for p in data_payloads)
    assert "tick-1-start" in joined, joined
    assert "tick-1-end" in joined, joined

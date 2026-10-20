from fastapi.testclient import TestClient
import time

from har_runtime.api import app


def test_health_and_device_routes():
    client = TestClient(app)
    assert client.get("/api/health").json()["status"] == "ok"
    response = client.get("/api/devices")
    assert response.status_code == 200
    assert {device["backend"] for device in response.json()} == {"cpu", "mps", "cuda"}


def test_system_route_includes_host_inventory():
    client = TestClient(app)
    system = client.get("/api/system").json()
    assert system["host"]["os"]["name"]
    assert system["host"]["architecture"]["machine"]
    assert system["host"]["memory"]["total_bytes"] > 0
    assert system["host"]["runtime"]["pytorch_version"]


def test_runtime_starts_as_host_without_pairing_code():
    client = TestClient(app)
    response = client.get("/api/session")
    assert response.status_code == 200
    session = response.json()
    assert session["role"] == "host"
    assert "pairing_code" not in session


def test_api_rejects_unavailable_cuda():
    client = TestClient(app)
    response = client.post("/api/runs", json={"backend": "cuda", "size": 8})
    assert response.status_code == 400


def test_node_registration_and_listing():
    client = TestClient(app)
    response = client.post(
        "/api/nodes/register",
        json={
            "node_id": "test-node",
            "name": "Test worker",
            "base_url": "http://127.0.0.1:9000",
            "capabilities": [{"backend": "cpu", "available": True}],
        },
    )
    assert response.status_code == 200
    nodes = client.get("/api/nodes").json()
    assert any(node["node_id"] == "test-node" and node["status"] == "online" for node in nodes)


def test_node_can_be_renamed_after_registration():
    client = TestClient(app)
    response = client.post(
        "/api/nodes/register",
        json={
            "node_id": "rename-node",
            "name": "Automatic hostname",
            "base_url": "http://127.0.0.1:9001",
            "capabilities": [],
        },
    )
    assert response.status_code == 200

    renamed = client.post("/api/nodes/rename-node/rename", json={"name": "Office Mac"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Office Mac"


def test_manual_connect_request_accepts_only_worker_url():
    from har_runtime.api import NodeConnectRequest

    request = NodeConnectRequest(worker_url="http://127.0.0.1:9000")
    assert request.name is None


def test_python_script_run_is_managed_and_captures_output():
    client = TestClient(app)
    response = client.post(
        "/api/scripts",
        json={"filename": "hello.py", "content": "print('hello from har')"},
    )
    assert response.status_code == 202
    script_id = response.json()["id"]
    for _ in range(20):
        result = client.get(f"/api/scripts/{script_id}").json()
        if result["status"] in {"completed", "failed"}:
            break
        time.sleep(0.01)
    assert result["status"] == "completed"
    assert "hello from har" in result["output"]


def test_python_script_rejects_non_python_filename():
    client = TestClient(app)
    response = client.post(
        "/api/scripts",
        json={"filename": "run.sh", "content": "echo unsafe"},
    )
    assert response.status_code == 422

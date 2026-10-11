from fastapi.testclient import TestClient

from har_runtime.api import app


def test_health_and_device_routes():
    client = TestClient(app)
    assert client.get("/api/health").json()["status"] == "ok"
    response = client.get("/api/devices")
    assert response.status_code == 200
    assert {device["backend"] for device in response.json()} == {"cpu", "mps", "cuda"}


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

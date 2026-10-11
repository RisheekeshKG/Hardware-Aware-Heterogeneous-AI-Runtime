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

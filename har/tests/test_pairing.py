import pytest
from fastapi.testclient import TestClient

from har.runtime import api, worker

HOST_IP = "10.0.0.9"
JOIN = {"coordinator": f"http://{HOST_IP}:8000", "name": "", "node_id": ""}


@pytest.fixture
def worker_state(monkeypatch, tmp_path):
    monkeypatch.setattr(worker, "_trusted_hosts", set())
    monkeypatch.setattr(worker, "_pairing_requests", {})
    monkeypatch.setattr(worker, "_trusted_hosts_path", tmp_path / "trusted-hosts.json")
    monkeypatch.setattr(worker, "_last_host_path", tmp_path / "last-host.json")
    monkeypatch.setattr(worker, "_state_dir", tmp_path)
    monkeypatch.setitem(worker._worker_config, "advertise_url", "http://10.0.0.20:9000")
    monkeypatch.setitem(worker._worker_config, "allow_connections", True)
    configured = []
    monkeypatch.setattr(worker, "configure_worker", lambda **kwargs: configured.append(kwargs) or worker._worker_config.update(node_id="node-1"))
    return configured


def remote(app, ip=HOST_IP):
    return TestClient(app, client=(ip, 50000))


def local(app):
    return TestClient(app)


def test_unknown_host_waits_for_approval_then_joins(worker_state):
    first = remote(worker.worker_app).post("/worker/join", json=JOIN)
    assert first.status_code == 202
    assert first.json()["status"] == "pending"
    assert not worker_state

    pending = local(worker.worker_app).get("/worker/pairing").json()
    assert [request["client_ip"] for request in pending] == [HOST_IP]

    decided = local(worker.worker_app).post(f"/worker/pairing/{pending[0]['id']}/accept")
    assert decided.json()["status"] == "accepted"

    joined = remote(worker.worker_app).post("/worker/join", json=JOIN)
    assert joined.status_code == 200
    assert worker_state[0]["coordinator"] == JOIN["coordinator"]
    assert HOST_IP in worker._trusted_hosts


def test_declined_host_is_rejected(worker_state):
    remote(worker.worker_app).post("/worker/join", json=JOIN)
    request_id = local(worker.worker_app).get("/worker/pairing").json()[0]["id"]
    local(worker.worker_app).post(f"/worker/pairing/{request_id}/decline")

    assert remote(worker.worker_app).post("/worker/join", json=JOIN).status_code == 403
    assert not worker_state


def test_repeated_join_attempts_create_one_request(worker_state):
    for _ in range(3):
        remote(worker.worker_app).post("/worker/join", json=JOIN)
    assert len(local(worker.worker_app).get("/worker/pairing").json()) == 1


def test_pairing_decisions_are_local_only(worker_state):
    remote(worker.worker_app).post("/worker/join", json=JOIN)
    request_id = local(worker.worker_app).get("/worker/pairing").json()[0]["id"]

    assert remote(worker.worker_app).get("/worker/pairing").status_code == 403
    assert remote(worker.worker_app).post(f"/worker/pairing/{request_id}/accept").status_code == 403


def test_untrusted_host_cannot_run_code(worker_state):
    script = {"filename": "x.py", "content": "print(1)"}
    assert remote(worker.worker_app, "10.0.0.66").post("/worker/scripts", json=script).status_code == 403
    assert remote(worker.worker_app, "10.0.0.66").post("/worker/runs", json={}).status_code == 403


def test_host_api_only_exposes_registration_to_other_computers():
    other = remote(api.app, "10.0.0.66")
    assert other.post("/api/scripts", json={"filename": "x.py", "content": "print(1)"}).status_code == 403
    assert other.get("/api/runtime").status_code == 403
    assert other.get("/api/health").status_code == 200


def test_cors_rejects_unknown_websites():
    response = local(api.app).options(
        "/api/scripts",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
    )
    assert "access-control-allow-origin" not in response.headers


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("192.168.1.25", "http://192.168.1.25:9000"),
        ("192.168.1.25:9100", "http://192.168.1.25:9100"),
        ("http://192.168.1.25:9000/", "http://192.168.1.25:9000"),
        (" http://mac.local ", "http://mac.local:9000"),
    ],
)
def test_worker_address_normalization(raw, expected):
    assert api._normalize_worker_url(raw) == expected


@pytest.fixture
def connection(monkeypatch):
    state = {"connected_at": None, "last_contact": None, "last_error": None, "disconnected_by_host": False, "jobs_received": 0, "last_job_at": None}
    monkeypatch.setattr(worker, "_connection", state)
    monkeypatch.setitem(worker._worker_config, "coordinator", "")
    return state


def test_connection_waits_without_a_host(connection):
    status = local(worker.worker_app).get("/worker/connection").json()
    assert status["status"] == "waiting"
    assert status["host_ip"] is None


def test_connection_reports_recent_contact(connection, monkeypatch):
    monkeypatch.setitem(worker._worker_config, "coordinator", f"http://{HOST_IP}:8000")
    connection["last_contact"] = worker.time.monotonic() - 2
    status = local(worker.worker_app).get("/worker/connection").json()
    assert status["status"] == "connected"
    assert status["host_ip"] == HOST_IP


def test_connection_reports_unreachable_host(connection, monkeypatch):
    monkeypatch.setitem(worker._worker_config, "coordinator", f"http://{HOST_IP}:8000")
    connection["last_contact"] = worker.time.monotonic() - 60
    connection["last_error"] = "timed out"
    status = local(worker.worker_app).get("/worker/connection").json()
    assert status["status"] == "unreachable"
    assert status["last_error"] == "timed out"


def test_connection_status_is_local_only(connection):
    assert remote(worker.worker_app).get("/worker/connection").status_code == 403


def test_host_disconnect_stops_worker(connection, monkeypatch, tmp_path):
    monkeypatch.setitem(worker._worker_config, "coordinator", f"http://{HOST_IP}:8000")
    monkeypatch.setattr(worker, "_last_host_path", tmp_path / "last-host.json")
    (tmp_path / "last-host.json").write_text("{}")
    worker._stop_serving_host(worker._registration_generation)
    status = local(worker.worker_app).get("/worker/connection").json()
    assert status["status"] == "disconnected"
    assert not (tmp_path / "last-host.json").exists()


def test_disconnected_node_cannot_reregister(monkeypatch):
    monkeypatch.setattr(api, "_nodes", {})
    monkeypatch.setattr(api, "_disconnected_nodes", set())
    registration = {"node_id": "pc-1", "name": "PC", "base_url": "http://10.0.0.20:9000", "capabilities": []}
    client = remote(api.app, "10.0.0.20")
    assert client.post("/api/nodes/register", json=registration).status_code == 200
    assert local(api.app).delete("/api/nodes/pc-1").status_code == 200
    assert client.post("/api/nodes/register", json=registration).status_code == 410

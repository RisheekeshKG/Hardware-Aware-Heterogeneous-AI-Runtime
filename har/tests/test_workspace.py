"""The Scripts page's file workspace: list, read, save, rename, delete."""

import pytest
from fastapi.testclient import TestClient

from har.runtime.api import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("HAR_WORKSPACE_DIR", str(tmp_path / "scripts"))
    return TestClient(app)


def test_new_workspace_starts_with_an_example(client, tmp_path):
    listing = client.get("/api/workspace").json()
    assert listing["path"] == str(tmp_path / "scripts")
    assert [f["name"] for f in listing["files"]] == ["example.py"]
    assert "har.offload" in client.get("/api/workspace/files/example.py").json()["content"]


def test_example_is_not_recreated_after_deleting_it(client):
    client.get("/api/workspace")
    assert client.delete("/api/workspace/files/example.py").status_code == 200
    assert client.get("/api/workspace").json()["files"] == []


def test_save_then_read_round_trips(client):
    saved = client.put("/api/workspace/files/train.py", json={"content": "print('hi')\n"})
    assert saved.status_code == 200 and saved.json()["size"] == 12
    assert client.get("/api/workspace/files/train.py").json()["content"] == "print('hi')\n"
    names = [f["name"] for f in client.get("/api/workspace").json()["files"]]
    assert "train.py" in names


@pytest.mark.parametrize("name", ["../escape.py", "notes.txt", ".py", "a%2Fb.py"])
def test_rejects_names_outside_the_folder_or_not_python(client, name):
    assert client.put(f"/api/workspace/files/{name}", json={"content": "x"}).status_code in {404, 422}


def test_rename_and_conflicts(client):
    client.put("/api/workspace/files/a.py", json={"content": "a"})
    client.put("/api/workspace/files/b.py", json={"content": "b"})
    assert client.post("/api/workspace/files/a.py/rename", json={"new_name": "b.py"}).status_code == 409
    assert client.post("/api/workspace/files/a.py/rename", json={"new_name": "c.py"}).json()["name"] == "c.py"
    assert client.get("/api/workspace/files/a.py").status_code == 404
    assert client.post("/api/workspace/files/missing.py/rename", json={"new_name": "d.py"}).status_code == 404


def test_delete_missing_file_is_404(client):
    assert client.delete("/api/workspace/files/nope.py").status_code == 404

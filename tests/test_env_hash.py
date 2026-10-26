"""Tests for env_hash — the fingerprint host and worker exchange to catch mismatched deps."""

from har_runtime.env_hash import env_fingerprint


def test_fingerprint_is_deterministic():
    first = env_fingerprint()
    second = env_fingerprint()
    assert first == second


def test_fingerprint_shape():
    data = env_fingerprint()
    assert set(data) == {"python", "platform", "machine", "packages", "hash"}
    assert isinstance(data["hash"], str) and len(data["hash"]) == 16
    assert isinstance(data["packages"], dict)
    assert data["platform"] in {"darwin", "linux", "windows"}


def test_hash_changes_with_versions(monkeypatch):
    import har_runtime.env_hash as module

    original = module._package_versions
    seen = {"call": 0}

    def fake_versions():
        seen["call"] += 1
        return {"torch": "2.0.0", "numpy": "1.26.0", "psutil": "5.9.0", "fastapi": "0.110.0",
                "uvicorn": "0.29.0", "httpx": "0.27.0", "pydantic": "2.0.0", "pynvml": "absent"}

    monkeypatch.setattr(module, "_package_versions", fake_versions)
    baseline = module.env_fingerprint()["hash"]

    monkeypatch.setattr(module, "_package_versions", lambda: {**fake_versions(), "torch": "2.1.0"})
    changed = module.env_fingerprint()["hash"]
    assert baseline != changed, "Changing torch version must change the fingerprint hash"
    monkeypatch.setattr(module, "_package_versions", original)

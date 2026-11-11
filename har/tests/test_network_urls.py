from har.runtime import api, worker
from har.runtime.api import _core as _api_core


def test_worker_resolves_wildcard_url_without_dropping_port(monkeypatch):
    monkeypatch.setattr(worker, "_lan_address", lambda: "192.168.1.25")

    assert worker._reachable_base_url("http://0.0.0.0:9000") == "http://192.168.1.25:9000"


def test_host_resolves_wildcard_url_without_dropping_port(monkeypatch):
    # configure_host_url mutates the shared _session dict inside api._core; monkeypatch
    # the attribute there so the production code sees our fresh dict.
    monkeypatch.setattr(_api_core, "_session", {"host_url": None})

    api.configure_host_url("http://0.0.0.0:8000")

    assert _api_core._session["host_url"].startswith("http://")
    assert _api_core._session["host_url"].endswith(":8000")

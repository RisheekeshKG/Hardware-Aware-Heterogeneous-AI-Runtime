"""Pairing + trusted-hosts + worker-connection proxies that forward to the local worker."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import HTTPException

from .core import _session, app
from .auth import _local_worker_url


@app.get("/api/pairing")
def pairing_requests() -> list[dict[str, Any]]:
    """Pending connection requests on this computer's worker (empty when not a worker).

    Raises on worker-side failures instead of swallowing them so the UI can tell the user
    "the worker service isn't reachable" rather than silently showing no pending requests.
    """

    import httpx

    if _session["role"] != "worker":
        return []
    try:
        response = httpx.get(f"{_local_worker_url()}/worker/pairing", timeout=2.0)
        response.raise_for_status()
        return response.json()
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"This computer's worker service isn't responding: {error}") from error
    except ValueError as error:
        raise HTTPException(status_code=502, detail=f"Worker returned an unexpected response: {error}") from error


@app.get("/api/worker-connection")
def worker_connection() -> dict[str, Any] | None:
    """The host this computer's worker serves and whether it is reachable (null when not a worker)."""

    import httpx

    if _session["role"] != "worker":
        return None
    try:
        response = httpx.get(f"{_local_worker_url()}/worker/connection", timeout=2.0)
        response.raise_for_status()
        return response.json()
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"Worker service isn't responding: {error}") from error


@app.post("/api/worker-connection/stop")
def stop_working_for_host() -> dict[str, Any]:
    """Forget the remembered coordinator so the worker stops auto-retrying every 5 seconds."""

    import httpx

    if _session["role"] != "worker":
        raise HTTPException(status_code=400, detail="This computer isn't in Worker mode")
    try:
        response = httpx.post(f"{_local_worker_url()}/worker/stop-serving-host", timeout=5.0)
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"Worker service isn't responding: {error}") from error
    if response.status_code >= 400:
        detail = response.json().get("detail", response.text) if response.content else response.reason_phrase
        raise HTTPException(status_code=response.status_code, detail=detail)
    return response.json()


@app.get("/api/trusted-hosts")
def trusted_hosts() -> list[dict[str, Any]]:
    """Hosts the local worker will accept jobs from (empty when not a worker)."""

    import httpx

    if _session["role"] != "worker":
        return []
    try:
        response = httpx.get(f"{_local_worker_url()}/worker/trusted-hosts", timeout=2.0)
        response.raise_for_status()
        return response.json()
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"Worker service isn't responding: {error}") from error


@app.delete("/api/trusted-hosts/{client_ip}")
def revoke_trusted_host(client_ip: str) -> dict[str, Any]:
    """Forget a trusted host so this worker refuses future jobs from that IP."""

    import httpx

    if _session["role"] != "worker":
        raise HTTPException(status_code=400, detail="This computer isn't in Worker mode")
    try:
        response = httpx.delete(f"{_local_worker_url()}/worker/trusted-hosts/{client_ip}", timeout=5.0)
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"Worker service isn't responding: {error}") from error
    if response.status_code >= 400:
        detail = response.json().get("detail", response.text) if response.content else response.reason_phrase
        raise HTTPException(status_code=response.status_code, detail=detail)
    return response.json()


@app.post("/api/pairing/{request_id}/{decision}")
def decide_pairing(request_id: str, decision: Literal["accept", "decline"]) -> dict[str, Any]:
    import httpx

    try:
        response = httpx.post(f"{_local_worker_url()}/worker/pairing/{request_id}/{decision}", timeout=5.0)
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"Worker service is not running: {error}") from error
    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=response.json().get("detail", response.text))
    return response.json()

"""Signing + URL plumbing shared by every endpoint module that talks to a worker."""

from __future__ import annotations

import os
from urllib.parse import urlsplit, urlunsplit

from fastapi import HTTPException

from .core import _node_secrets


CONNECT_APPROVAL_TIMEOUT_SECONDS = 120.0
DEFAULT_WORKER_PORT = 9000


def _signed_headers_for(node_id: str, method: str, url: str, body: bytes = b"") -> dict[str, str]:
    """Return HMAC headers for a host→worker call, or `{}` for workers we have no secret for.

    `url` can be a full URL; the signature only covers the path, which is what the worker
    sees. An empty dict means "fall back to IP ACL", which old workers still accept.
    """

    secret = _node_secrets.get(node_id)
    if not secret:
        return {}
    from ..signing import sign_request

    path = urlsplit(url).path or "/"
    return sign_request(secret, method, path, body)


def _normalize_worker_url(raw: str) -> str:
    """Accept "192.168.1.25", "192.168.1.25:9000" or a full URL."""

    value = raw.strip().rstrip("/")
    if "://" not in value:
        value = f"http://{value}"
    parsed = urlsplit(value)
    if not parsed.hostname:
        raise HTTPException(status_code=422, detail="Enter the other computer's address, e.g. 192.168.1.25")
    netloc = parsed.netloc if parsed.port else f"{parsed.netloc}:{DEFAULT_WORKER_PORT}"
    return urlunsplit((parsed.scheme, netloc, "", "", ""))


def _local_worker_url() -> str:
    return os.getenv("HAR_LOCAL_WORKER_URL", f"http://127.0.0.1:{DEFAULT_WORKER_PORT}")

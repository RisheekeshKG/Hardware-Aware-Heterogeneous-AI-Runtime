"""HMAC request signing shared between host (signer) and worker (verifier).

The audit flagged the worker's trust model as "IP-based ACL over plain HTTP, spoofable
on any shared LAN." That's accurate: anyone on your Wi-Fi who can ARP-spoof you is
indistinguishable to the worker from the real host. HMAC-signed requests close that:
once pairing accepts a host, the worker hands it a per-host 32-byte secret, and every
subsequent request from host to worker carries a timestamp + a signature of
`timestamp|METHOD|path|sha256(body)` under that secret.

Backward compatibility: a request without `X-HAR-Signature` falls back to the old IP
ACL on the worker side, so a mixed-version LAN keeps working while hosts update.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from typing import Mapping


HMAC_TIMESTAMP_HEADER = "X-HAR-Timestamp"
HMAC_SIGNATURE_HEADER = "X-HAR-Signature"
HMAC_CLOCK_SKEW_SECONDS = 60.0


def new_shared_secret() -> str:
    """A fresh per-host-worker secret, 32 bytes hex-encoded."""

    return secrets.token_hex(32)


def _canonical_message(timestamp: str, method: str, path: str, body: bytes) -> bytes:
    body_hash = hashlib.sha256(body or b"").hexdigest()
    return f"{timestamp}|{method.upper()}|{path}|{body_hash}".encode("utf-8")


def sign_request(secret: str, method: str, path: str, body: bytes) -> dict[str, str]:
    """Return `{X-HAR-Timestamp, X-HAR-Signature}` for the given request."""

    timestamp = str(int(time.time()))
    message = _canonical_message(timestamp, method, path, body)
    signature = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
    return {HMAC_TIMESTAMP_HEADER: timestamp, HMAC_SIGNATURE_HEADER: signature}


def verify_signature(
    secret: str,
    method: str,
    path: str,
    body: bytes,
    headers: Mapping[str, str],
    *,
    now: float | None = None,
    max_skew_seconds: float = HMAC_CLOCK_SKEW_SECONDS,
) -> bool:
    """Return True iff the request's timestamp is fresh AND the signature matches.

    Rejects on missing headers, bad timestamp, out-of-window timestamp, or a signature
    that doesn't match a constant-time compare. Returns False (never raises) so the
    caller can decide between 401 and the IP-ACL fallback.
    """

    timestamp_header = headers.get(HMAC_TIMESTAMP_HEADER) or headers.get(HMAC_TIMESTAMP_HEADER.lower())
    signature_header = headers.get(HMAC_SIGNATURE_HEADER) or headers.get(HMAC_SIGNATURE_HEADER.lower())
    if not timestamp_header or not signature_header:
        return False
    try:
        ts = int(timestamp_header)
    except ValueError:
        return False
    if abs((now if now is not None else time.time()) - ts) > max_skew_seconds:
        return False
    expected = hmac.new(secret.encode("utf-8"), _canonical_message(timestamp_header, method, path, body), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header)

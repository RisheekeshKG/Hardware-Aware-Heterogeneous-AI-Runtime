"""Tests for the HMAC request-signing scheme that replaces IP-only trust."""

import time

from har.runtime.signing import (
    HMAC_SIGNATURE_HEADER,
    HMAC_TIMESTAMP_HEADER,
    new_shared_secret,
    sign_request,
    verify_signature,
)


def test_shared_secret_is_hex_and_long_enough():
    secret = new_shared_secret()
    assert len(secret) == 64  # 32 bytes hex
    int(secret, 16)  # must parse as hex


def test_sign_and_verify_round_trip():
    secret = new_shared_secret()
    body = b'{"foo":"bar"}'
    headers = sign_request(secret, "POST", "/worker/scripts", body)
    assert HMAC_TIMESTAMP_HEADER in headers and HMAC_SIGNATURE_HEADER in headers
    assert verify_signature(secret, "POST", "/worker/scripts", body, headers)


def test_different_secret_fails_verification():
    body = b"ping"
    headers = sign_request(new_shared_secret(), "GET", "/worker/health", body)
    other_secret = new_shared_secret()
    assert not verify_signature(other_secret, "GET", "/worker/health", body, headers)


def test_tampered_body_fails_verification():
    secret = new_shared_secret()
    headers = sign_request(secret, "POST", "/x", b"original")
    assert not verify_signature(secret, "POST", "/x", b"tampered", headers)


def test_tampered_method_or_path_fails_verification():
    secret = new_shared_secret()
    headers = sign_request(secret, "POST", "/x", b"body")
    assert not verify_signature(secret, "GET", "/x", b"body", headers)
    assert not verify_signature(secret, "POST", "/y", b"body", headers)


def test_old_timestamp_rejected():
    secret = new_shared_secret()
    body = b"anything"
    headers = sign_request(secret, "POST", "/p", body)
    # Pretend the clock has moved forward beyond the allowed skew.
    now = time.time() + 1000.0
    assert not verify_signature(secret, "POST", "/p", body, headers, now=now)


def test_missing_headers_return_false_not_raise():
    secret = new_shared_secret()
    assert verify_signature(secret, "GET", "/p", b"", headers={}) is False
    assert verify_signature(secret, "GET", "/p", b"", headers={HMAC_TIMESTAMP_HEADER: "123"}) is False

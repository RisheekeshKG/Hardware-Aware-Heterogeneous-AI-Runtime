"""Per-shape latency cache used by the router to pick a device without re-measuring every call."""

from __future__ import annotations

import os
import sqlite3
import threading
from pathlib import Path
from typing import Iterable


def _default_db_path() -> Path:
    override = os.environ.get("HAR_CALIBRATION_DB")
    if override:
        return Path(override)
    home = Path(os.environ.get("HAR_HOME") or Path.home() / ".har")
    home.mkdir(parents=True, exist_ok=True)
    return home / "calibration.db"


class CalibrationCache:
    """A tiny sqlite-backed table of per-(call-shape, backend) median latency.

    Keys are opaque strings produced by the router from the call's shape fingerprint.
    """

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or _default_db_path()
        self._lock = threading.Lock()
        self._init()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    def _init(self) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS latency (
                    shape_key TEXT NOT NULL,
                    backend TEXT NOT NULL,
                    seconds REAL NOT NULL,
                    samples INTEGER NOT NULL,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY (shape_key, backend)
                )
                """
            )
            # Measured host↔device transfer bandwidth per backend. Written once per machine
            # when the router first sees a device; the hardcoded `_LOCAL_TRANSFER_BPS` guess
            # is only used as a fallback for backends we haven't measured yet.
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS bandwidth (
                    backend TEXT PRIMARY KEY,
                    bytes_per_second REAL NOT NULL,
                    bytes_sampled INTEGER NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )

    def get(self, shape_key: str, backend: str) -> float | None:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT seconds FROM latency WHERE shape_key = ? AND backend = ?",
                (shape_key, backend),
            ).fetchone()
        return row[0] if row else None

    def all_for(self, shape_key: str) -> dict[str, float]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                "SELECT backend, seconds FROM latency WHERE shape_key = ?",
                (shape_key,),
            ).fetchall()
        return {backend: seconds for backend, seconds in rows}

    def record(self, shape_key: str, backend: str, seconds: float) -> None:
        """Store a measurement, rolling in with the previous value if any (EWMA, alpha=0.5)."""

        import time

        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT seconds, samples FROM latency WHERE shape_key = ? AND backend = ?",
                (shape_key, backend),
            ).fetchone()
            if row is None:
                blended = seconds
                samples = 1
            else:
                blended = row[0] * 0.5 + seconds * 0.5
                samples = int(row[1]) + 1
            connection.execute(
                "REPLACE INTO latency (shape_key, backend, seconds, samples, updated_at) VALUES (?, ?, ?, ?, ?)",
                (shape_key, backend, blended, samples, time.time()),
            )
            connection.commit()

    def known_backends(self, shape_key: str, candidates: Iterable[str]) -> set[str]:
        measured = set(self.all_for(shape_key).keys())
        return measured.intersection(set(candidates))

    def get_bandwidth(self, backend: str) -> float | None:
        """Return the measured bytes/sec for this backend on this machine, or None if we haven't measured yet."""

        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT bytes_per_second FROM bandwidth WHERE backend = ?",
                (backend,),
            ).fetchone()
        return row[0] if row else None

    def record_bandwidth(self, backend: str, bytes_per_second: float, bytes_sampled: int) -> None:
        """Store a bandwidth measurement. Only called once per machine per backend (not EWMA'd —
        PCIe/unified-memory bandwidth is a hardware property, not a changing workload cost)."""

        import time

        with self._lock, self._connect() as connection:
            connection.execute(
                "REPLACE INTO bandwidth (backend, bytes_per_second, bytes_sampled, updated_at) VALUES (?, ?, ?, ?)",
                (backend, bytes_per_second, bytes_sampled, time.time()),
            )
            connection.commit()

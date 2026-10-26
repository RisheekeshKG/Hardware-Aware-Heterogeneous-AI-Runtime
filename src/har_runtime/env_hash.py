"""A deterministic fingerprint of this process's Python + installed packages.

Used by the host to warn before dispatching a script to a worker whose environment
doesn't match: that's the "silent ModuleNotFoundError on another machine" footgun
the critique called out. We can't force the environments to agree, but we can tell
the user something is off BEFORE they wait for a job to crash.
"""

from __future__ import annotations

import hashlib
import platform
import sys
from importlib import metadata


# Packages that materially affect how a routed workload will behave. We intentionally
# ignore everything else (console scripts, documentation deps, etc.) so a worker that
# only differs on pytest-timeout isn't flagged.
_KEY_PACKAGES = (
    "torch",
    "numpy",
    "psutil",
    "fastapi",
    "uvicorn",
    "httpx",
    "pydantic",
    "pynvml",
)


def _package_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    for name in _KEY_PACKAGES:
        try:
            versions[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            versions[name] = "absent"
    return versions


def env_fingerprint() -> dict[str, object]:
    """Full env summary: used to show the user WHAT differs, not just that something does."""

    versions = _package_versions()
    python = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    payload = {
        "python": python,
        "platform": platform.system().lower(),
        "machine": platform.machine().lower(),
        "packages": versions,
    }
    hashable = "|".join(
        [
            python,
            payload["platform"],
            payload["machine"],
            ",".join(f"{name}={version}" for name, version in sorted(versions.items())),
        ]
    )
    payload["hash"] = hashlib.sha256(hashable.encode("utf-8")).hexdigest()[:16]
    return payload

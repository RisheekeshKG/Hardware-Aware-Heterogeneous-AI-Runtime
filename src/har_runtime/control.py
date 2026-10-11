"""Local, allow-listed control API for frontend-assisted setup."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException

control_app = FastAPI(title="Hardware-Aware AI Runtime Local Control", version="0.1.0")
_project_root = Path(__file__).resolve().parents[2]
_setup_process: subprocess.Popen[str] | None = None


@control_app.get("/control/status")
def status() -> dict[str, Any]:
    running = _setup_process is not None and _setup_process.poll() is None
    return {"status": "ok", "setup_running": running, "project_root": str(_project_root)}


@control_app.post("/control/setup", status_code=202)
def setup() -> dict[str, str]:
    global _setup_process
    if _setup_process is not None and _setup_process.poll() is None:
        raise HTTPException(status_code=409, detail="Setup is already running")

    script = _project_root / "setup-windows-gpu.ps1"
    if not script.is_file():
        raise HTTPException(status_code=404, detail="setup-windows-gpu.ps1 was not found")

    _setup_process = subprocess.Popen(
        ["PowerShell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
        cwd=str(_project_root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    return {"status": "started"}


def run_control(host: str = "127.0.0.1", port: int = 9100) -> None:
    import uvicorn

    uvicorn.run(control_app, host=host, port=port, reload=False)

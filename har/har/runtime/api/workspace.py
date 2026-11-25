"""`/api/workspace*`: the script files you edit in the desktop app's Scripts page.

They are plain .py files in one folder on this computer (default `~/HAR/scripts`,
override with HAR_WORKSPACE_DIR), so they survive restarts and open in any editor.
Like every /api route except registration, this is reachable only from this computer.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, Field

from .core import app
from .schemas import validate_script_filename

MAX_FILE_BYTES = 1_000_000  # same limit as a script run's content

EXAMPLE_NAME = "example.py"
EXAMPLE = '''import har
import torch


@har.offload
def big_matmul(size: int) -> torch.Tensor:
    left = torch.randn(size, size)
    right = torch.randn(size, size)
    return left @ right


result = big_matmul(2048)
print("result shape:", tuple(result.shape))
'''


class FileContent(BaseModel):
    content: str = Field(max_length=MAX_FILE_BYTES)


class FileRename(BaseModel):
    new_name: str = Field(min_length=1, max_length=160)


def workspace_dir() -> Path:
    configured = os.getenv("HAR_WORKSPACE_DIR")
    return Path(configured).expanduser() if configured else Path.home() / "HAR" / "scripts"


def _file_path(name: str) -> Path:
    try:
        validate_script_filename(name)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return workspace_dir() / name


def _info(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "name": path.name,
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
    }


@app.get("/api/workspace")
def list_workspace() -> dict[str, Any]:
    """Every .py file in the folder. A new, empty folder gets one example to start from."""

    folder = workspace_dir()
    created = not folder.exists()
    folder.mkdir(parents=True, exist_ok=True)
    if created:
        (folder / EXAMPLE_NAME).write_text(EXAMPLE, encoding="utf-8", newline="")
    files = sorted((p for p in folder.glob("*.py") if p.is_file()), key=lambda p: p.name.lower())
    return {"path": str(folder), "files": [_info(p) for p in files]}


@app.get("/api/workspace/files/{name}")
def read_file(name: str) -> dict[str, Any]:
    path = _file_path(name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"{name} doesn't exist")
    # newline="" keeps the file's own line endings (Windows text mode would rewrite them).
    with path.open(encoding="utf-8", errors="replace", newline="") as handle:
        return {**_info(path), "content": handle.read()}


@app.put("/api/workspace/files/{name}")
def write_file(name: str, body: FileContent) -> dict[str, Any]:
    """Create or overwrite. Writes to a temp file first so a crash can't leave half a file."""

    path = _file_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.saving")
    temp.write_text(body.content, encoding="utf-8", newline="")  # save exactly what was typed
    os.replace(temp, path)
    return _info(path)


@app.post("/api/workspace/files/{name}/rename")
def rename_file(name: str, body: FileRename) -> dict[str, Any]:
    path = _file_path(name)
    target = _file_path(body.new_name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"{name} doesn't exist")
    if target.exists() and target != path:
        raise HTTPException(status_code=409, detail=f"{body.new_name} already exists")
    path.rename(target)
    return _info(target)


@app.delete("/api/workspace/files/{name}")
def delete_file(name: str) -> dict[str, Any]:
    path = _file_path(name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"{name} doesn't exist")
    path.unlink()
    return {"deleted": name}

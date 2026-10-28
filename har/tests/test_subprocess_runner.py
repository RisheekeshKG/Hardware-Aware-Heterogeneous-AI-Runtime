"""Tests for subprocess_runner — the OS-isolated script executor."""

import tempfile
from pathlib import Path

from har.runtime.subprocess_runner import run_script_in_subprocess


def _run(content: str, *, timeout: float = 5.0):
    with tempfile.TemporaryDirectory() as directory:
        return run_script_in_subprocess(
            filename="run.py",
            content=content,
            args=[],
            cwd=Path(directory),
            timeout_seconds=timeout,
        )


def test_prints_captured_and_exit_zero():
    result = _run("print('hello')")
    assert result["exit_code"] == 0
    assert not result["timed_out"]
    assert "hello" in result["stdout"]
    assert result["execute_seconds"] > 0


def test_raising_exception_lands_in_stderr_and_nonzero_exit():
    result = _run("raise RuntimeError('boom')")
    assert result["exit_code"] != 0
    assert not result["timed_out"]
    assert "boom" in result["stderr"]


def test_infinite_loop_hits_timeout_and_is_killed():
    result = _run("while True: pass", timeout=1.5)
    assert result["timed_out"], result
    # The runner only waits ~5 s past the limit for stragglers; a leaked grandchild would
    # make `execute_seconds` balloon past that.
    assert result["execute_seconds"] < 10, result
    assert "exceeded" in result["stderr"].lower()


def test_subprocess_cwd_is_the_temp_dir():
    with tempfile.TemporaryDirectory() as directory:
        result = run_script_in_subprocess(
            filename="where.py",
            content="import os; print(os.getcwd())",
            args=[],
            cwd=Path(directory),
            timeout_seconds=5,
        )
        assert result["exit_code"] == 0
        # Resolve both so macOS /var vs /private/var symlink doesn't fail the equality check.
        assert Path(result["stdout"].strip()).resolve() == Path(directory).resolve()

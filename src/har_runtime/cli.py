"""Command-line interface for discovery and benchmarks."""

from pathlib import Path
from typing import Optional

import typer

from .benchmark import run_matmul, run_workload
from .devices import BACKENDS, discover_devices
from .exporters import write_csv, write_json

def _exit_with_parent() -> None:
    """Exit when the desktop app that launched this process is gone.

    The app sets HAR_PARENT_PID; without this, a crashed or force-quit app
    would leave the runtime holding ports 8000/9000 and block the next launch.
    """

    import os
    import threading
    import time

    import psutil

    try:
        parent_pid = int(os.environ.get("HAR_PARENT_PID", ""))
    except ValueError:
        return

    def watch() -> None:
        while psutil.pid_exists(parent_pid):
            time.sleep(2)
        os._exit(0)

    threading.Thread(target=watch, daemon=True, name="har-parent-watch").start()


app = typer.Typer(help="Hardware-Aware Heterogeneous AI Runtime")
benchmark_app = typer.Typer(help="Run benchmark workloads")
app.add_typer(benchmark_app, name="benchmark")


@app.command("run-script")
def run_script(
    script: Path = typer.Argument(..., exists=True, dir_okay=False, readable=True),
    script_args: Optional[list[str]] = typer.Argument(None),
) -> None:
    """Internal: run a .py file via runpy. Used by the subprocess isolation path.

    `har execute script.py` is the user-facing entrypoint; `run-script` is what the
    host/worker spawns when it isolates a job in its own OS process. Kept intentionally
    minimal so that a crashing user script can only harm this subprocess.
    """

    import runpy
    import sys as _sys

    previous_argv = _sys.argv
    _sys.argv = [str(script), *(script_args or [])]
    try:
        runpy.run_path(str(script), run_name="__main__")
    finally:
        _sys.argv = previous_argv


@app.command()
def devices() -> None:
    """Discover CPU, Apple MPS, and NVIDIA CUDA backends."""

    for device in discover_devices():
        state = "available" if device.available else "unavailable"
        typer.echo(f"{device.backend}: {state} | {device.device_name}")
        if device.unavailable_reason:
            typer.echo(f"  reason: {device.unavailable_reason}")
        memory = device.memory
        if memory.available_bytes is not None:
            qualifier = "measured" if memory.measured else "estimated"
            typer.echo(f"  memory available: {memory.available_bytes} bytes ({qualifier})")


@app.command()
def execute(
    script: Path = typer.Argument(..., exists=True, dir_okay=False, readable=True, help="Python file to run"),
    args: Optional[list[str]] = typer.Argument(None, help="Arguments passed through to the script"),
    show_decisions: bool = typer.Option(True, "--show-decisions/--no-decisions", help="Print the router decisions after the script exits"),
) -> None:
    """Run a Python script with the HAR SDK pre-loaded, routing @har.offload calls across devices.

    The script runs in this process so @har.offload decorators dispatch through the HAR router.
    """

    import runpy
    import sys

    from har.decorator import _last_decisions  # type: ignore[attr-defined]

    previous_argv = sys.argv
    sys.argv = [str(script), *(args or [])]
    try:
        runpy.run_path(str(script), run_name="__main__")
    finally:
        sys.argv = previous_argv

    if show_decisions and _last_decisions:
        typer.echo("")
        typer.echo("HAR routing decisions:")
        for name, decision in _last_decisions.items():
            typer.echo(
                f"  {name}: {decision.backend} ({decision.device_name}) "
                f"in {decision.elapsed_seconds * 1000:.2f} ms"
                + (f", moved {decision.transfer_bytes} B" if decision.transfer_bytes else "")
                + f" — {decision.reason}"
            )


@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", help="API bind address"),
    port: int = typer.Option(8000, min=1, max=65535, help="API port"),
    advertise_url: str | None = typer.Option(None, help="Host URL workers should use"),
    role: str = typer.Option("host", help="Runtime role reported to the dashboard"),
) -> None:
    """Start the live API used by the dashboard."""

    import uvicorn
    from .api import configure_host_url, configure_role, start_discovery

    if role not in {"host", "worker", "standalone"}:
        raise typer.BadParameter("Role must be host, worker, or standalone")
    _exit_with_parent()
    configure_role(role)
    configure_host_url(advertise_url)
    if role == "host":
        start_discovery()
    uvicorn.run("har_runtime.api:app", host=host, port=port, reload=False)


@app.command()
def host(
    host: str = typer.Option("0.0.0.0", help="Host API bind address"),
    port: int = typer.Option(8000, min=1, max=65535, help="Host API port"),
    advertise_url: str | None = typer.Option(None, help="Host URL workers should use"),
) -> None:
    """Start this device as a Host. Runtime servers are hosts by default."""

    serve(host=host, port=port, advertise_url=advertise_url, role="host")


@app.command()
def worker(
    coordinator: str | None = typer.Option(None, help="Coordinator API URL; omit for standalone join mode"),
    host: str = typer.Option("0.0.0.0", help="Worker bind address"),
    port: int = typer.Option(9000, min=1, max=65535, help="Worker port"),
    advertise_url: str = typer.Option(..., help="URL the coordinator can reach, e.g. http://192.168.1.25:9000"),
    name: str | None = typer.Option(None, help="Human-readable node name"),
    node_id: str | None = typer.Option(None, help="Stable node identifier"),
    allow_connections: bool = typer.Option(True, "--allow-connections/--deny-connections", help="Accept host join requests"),
) -> None:
    """Start a real PyTorch worker and register it with a coordinator."""

    import uvicorn

    from .worker import configure_worker

    _exit_with_parent()
    configure_worker(
        coordinator=coordinator,
        base_url=advertise_url,
        name=name,
        node_id=node_id,
        allow_connections=allow_connections,
    )
    uvicorn.run("har_runtime.worker:worker_app", host=host, port=port, reload=False)


@benchmark_app.command("matmul")
def matmul(
    size: int = typer.Option(..., min=1, help="Square matrix dimension"),
    backend: str = typer.Option("cpu", help=f"Backend: {', '.join(BACKENDS)}"),
    warmup: int = typer.Option(3, min=0, help="Warm-up iterations"),
    iterations: int = typer.Option(10, min=1, help="Measured iterations"),
    seed: int = typer.Option(42, help="Random seed"),
    json_output: Optional[Path] = typer.Option(None, "--json", help="Write JSON result to this path"),
    csv_output: Optional[Path] = typer.Option(None, "--csv", help="Write CSV result to this path"),
) -> None:
    """Benchmark square matrix multiplication on an explicitly selected backend."""

    try:
        result = run_matmul(
            size=size,
            backend=backend,
            warmup_iterations=warmup,
            measured_iterations=iterations,
            seed=seed,
        )
    except (ValueError, RuntimeError) as error:
        raise typer.BadParameter(str(error)) from error

    typer.echo(f"backend: {result.backend}")
    typer.echo(f"device: {result.device.device_name}")
    typer.echo(f"size: {result.size}x{result.size}, dtype: {result.dtype}")
    typer.echo(f"correctness: {'passed' if result.correctness_passed else 'failed'}")
    typer.echo(f"median latency: {result.latency_seconds['median']:.6f} seconds")
    typer.echo(f"median throughput: {result.throughput_tflops['median']:.6f} TFLOP/s")
    if json_output:
        typer.echo(f"JSON: {write_json(result, json_output)}")
    if csv_output:
        typer.echo(f"CSV: {write_csv(result, csv_output)}")


@benchmark_app.command("image")
def image(
    backend: str = typer.Option("cpu", help=f"Backend: {', '.join(BACKENDS)}"),
    batch_size: int = typer.Option(8, min=1),
    image_size: int = typer.Option(32, min=4),
    warmup: int = typer.Option(3, min=0),
    iterations: int = typer.Option(10, min=1),
    seed: int = typer.Option(42),
) -> None:
    """Run the deterministic built-in image CNN workload."""

    result = run_workload(workload="image", backend=backend, batch_size=batch_size, image_size=image_size, warmup_iterations=warmup, measured_iterations=iterations, seed=seed)
    typer.echo(f"image inference on {result.device.device_name}: {result.metrics['median_images_per_second']:.3f} images/sec; correctness passed")


@benchmark_app.command("tree")
def tree(
    backend: str = typer.Option("cpu", help=f"Backend: {', '.join(BACKENDS)}"),
    depth: int = typer.Option(12, min=1, max=20),
    traversals: int = typer.Option(4096, min=1),
    warmup: int = typer.Option(3, min=0),
    iterations: int = typer.Option(10, min=1),
    seed: int = typer.Option(42),
) -> None:
    """Run the deterministic tensor-backed tree traversal workload."""

    result = run_workload(workload="tree", backend=backend, depth=depth, traversal_count=traversals, warmup_iterations=warmup, measured_iterations=iterations, seed=seed)
    typer.echo(f"tree traversal on {result.device.device_name}: {result.metrics['median_traversals_per_second']:.3f} traversals/sec; correctness passed")


@app.command()
def discover() -> None:
    """List HAR workers currently visible on the local network."""

    import time

    from .discovery import DiscoveryRegistry

    registry = DiscoveryRegistry()
    time.sleep(2.2)
    nodes = registry.list_nodes()
    if not nodes:
        typer.echo("No HAR workers discovered.")
        return
    for node in nodes:
        typer.echo(f"{node.get('node_id')}: {node.get('base_url')} | {node.get('name', 'worker')}")


@app.command()
def connect(
    host_url: str = typer.Option(..., "--host", help="Host API URL"),
    worker_url: str = typer.Option(..., "--worker", help="Worker API URL"),
    name: str | None = typer.Option(None, help="Optional worker name"),
    node_id: str = typer.Option("", help="Optional stable worker ID"),
) -> None:
    """Ask a worker to join a host without using the dashboard."""

    import httpx

    response = httpx.post(
        f"{worker_url.rstrip('/')}/worker/join",
        json={"coordinator": host_url.rstrip("/"), "name": name or "", "node_id": node_id},
        timeout=10.0,
    )
    if response.is_error:
        raise typer.ClickException(response.text or f"Worker rejected connection ({response.status_code})")
    typer.echo(response.text)


if __name__ == "__main__":
    app()

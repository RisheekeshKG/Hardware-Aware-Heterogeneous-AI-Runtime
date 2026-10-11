"""Command-line interface for discovery and benchmarks."""

from pathlib import Path
from typing import Optional

import typer

from .benchmark import run_matmul
from .devices import BACKENDS, discover_devices
from .exporters import write_csv, write_json

app = typer.Typer(help="Hardware-Aware Heterogeneous AI Runtime")
benchmark_app = typer.Typer(help="Run benchmark workloads")
app.add_typer(benchmark_app, name="benchmark")


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
def serve(
    host: str = typer.Option("127.0.0.1", help="API bind address"),
    port: int = typer.Option(8000, min=1, max=65535, help="API port"),
) -> None:
    """Start the live API used by the dashboard."""

    import uvicorn

    uvicorn.run("har_runtime.api:app", host=host, port=port, reload=False)


@app.command()
def control(
    host: str = typer.Option("127.0.0.1", help="Local control bind address"),
    port: int = typer.Option(9100, min=1, max=65535, help="Local control port"),
) -> None:
    """Start the localhost-only frontend setup control agent."""

    from .control import run_control

    run_control(host=host, port=port)


@app.command()
def worker(
    coordinator: str = typer.Option(..., help="Coordinator API URL, e.g. http://192.168.1.10:8000"),
    host: str = typer.Option("0.0.0.0", help="Worker bind address"),
    port: int = typer.Option(9000, min=1, max=65535, help="Worker port"),
    advertise_url: str = typer.Option(..., help="URL the coordinator can reach, e.g. http://192.168.1.25:9000"),
    name: str | None = typer.Option(None, help="Human-readable node name"),
    node_id: str | None = typer.Option(None, help="Stable node identifier"),
) -> None:
    """Start a real PyTorch worker and register it with a coordinator."""

    import uvicorn

    from .worker import configure_worker

    configure_worker(coordinator=coordinator, base_url=advertise_url, name=name, node_id=node_id)
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


if __name__ == "__main__":
    app()

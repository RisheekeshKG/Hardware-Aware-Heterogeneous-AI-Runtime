# Hardware-Aware Heterogeneous AI Runtime

Milestone 1 provides a local PyTorch benchmark foundation for CPU, Apple MPS,
and NVIDIA CUDA. It detects hardware at runtime and never silently changes an
explicitly requested backend.

## Installation

Python 3.10 or newer is required. From this directory:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e '.[test]'
```

PyTorch must be installed with the build appropriate for the machine. The
standard install normally includes CPU support; on NVIDIA machines install a
PyTorch build matching the desired CUDA version using the official PyTorch
selector before installing this package.

## CLI

```bash
har devices
har benchmark matmul --size 1024
har benchmark matmul --size 2048 --backend cpu
har benchmark matmul --size 1024 --backend mps --json results/mps.json --csv results/mps.csv
```

Valid backends are `cpu`, `mps`, and `cuda`. If MPS or CUDA is unavailable,
the command fails with an explicit error. Run `har benchmark matmul --help`
for all timing and reproducibility options.

## Tests

```bash
pytest
```

The CPU tests always run. MPS and CUDA smoke tests run when those backends are
actually available and are skipped otherwise.

## Running the same configuration on both laptops

Install the project and the appropriate PyTorch build independently on each
machine. The machines do not share memory in this milestone. Run the same
command and keep the exported files separate:

```bash
har benchmark matmul --size 1024 --warmup 3 --iterations 10 --seed 42 --backend mps \
  --json results/mac-mps-1024.json --csv results/mac-mps-1024.csv

har benchmark matmul --size 1024 --warmup 3 --iterations 10 --seed 42 --backend cuda \
  --json results/rtx3050-cuda-1024.json --csv results/rtx3050-cuda-1024.csv
```

On a machine without MPS or CUDA, use `--backend cpu`. Do not compare runs
unless the size, dtype, warm-up count, measured iteration count, and seed are
the same. The JSON records detailed metadata; the CSV is convenient for later
analysis.

## Measurements and limitations

Latency is measured with `time.perf_counter` around `torch.mm`, with backend
synchronization before and after each sample. Throughput is calculated from
the measured latency and the standard `2 * N^3` floating-point operation
count. CPU and CUDA free memory are reported from runtime APIs. MPS memory is
reported as an estimate because PyTorch exposes an allocator estimate rather
than direct free-memory telemetry. Missing metrics are recorded as unavailable
instead of being invented.

## Live Runtime Dashboard and Compute Nodes

The API and React dashboard are the Milestone 2 control surface. The dashboard
adjusts workload parameters and selects a compute node, but all displayed
device and benchmark values come from real runtime detection and PyTorch
execution. It does not simulate GPU availability or performance.

Start the Python API from this directory:

```bash
har serve
```

In another terminal, start the Vite dashboard:

```bash
cd web
npm install
npm run dev
```

Open `http://localhost:5173`. The API provides device discovery at
`GET /api/devices`, starts real matmul runs at `POST /api/runs`, and streams
iteration progress through `WS /api/runs/{id}/events`.

To expose a worker API on a Windows laptop on the same LAN, bind the API to
the laptop's network interface and use its address from the dashboard:

```bash
har serve --host 0.0.0.0 --port 8000
```

Then start Vite with `VITE_API_URL=http://<windows-laptop-ip>:8000 npm run dev`.
The API allows development CORS by default. For a narrower policy, set
`HAR_CORS_ORIGINS=http://<mac-ip>:5173` before starting the API. Only do this
on a trusted network and configure the Windows firewall for port 8000.
Authentication and job isolation are future work.

Start the worker on the Windows laptop after installing the same project and
the CUDA-compatible PyTorch build:

```powershell
har worker `
  --coordinator http://<mac-ip>:8000 `
  --advertise-url http://<windows-laptop-ip>:9000 `
  --name rtx-3050-worker `
  --node-id rtx-3050
```

The coordinator dashboard will show the worker under Compute fabric once its
heartbeat arrives. Select that node and `cuda` in the workload panel to run a
real CUDA benchmark on the laptop. The coordinator records the worker's node
identity, measured result, correctness status, and network round-trip time.

This milestone still does not include learned scheduling, tensor sharding,
custom kernels, or automatic multi-machine orchestration.

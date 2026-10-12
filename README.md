# Hardware-Aware Heterogeneous AI Runtime

HAR Runtime is a desktop-first benchmark workspace for CPU, Apple MPS, and
NVIDIA CUDA. It detects hardware at runtime and never silently changes an
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

Windows users should install the packaged desktop application. It includes
the same first-run runtime setup and does not require a Python environment or
PowerShell bootstrap script.

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

## Runtime Dashboard and Compute Nodes

The API and React dashboard are the control surface. The dashboard
adjusts workload parameters and selects a compute node, but all displayed
device and benchmark values come from real runtime detection and PyTorch
execution. It does not simulate GPU availability or performance.

The dashboard provides three deterministic workloads:

- `matmul`: dense matrix multiplication, reported in TFLOP/s.
- `image`: a built-in seeded CNN over generated image tensors, reported in images/second.
- `tree`: seeded tensor-backed binary-tree traversal, reported in traversals/second.

No external dataset or model download is included. The seed and workload
configuration are recorded with every result so runs can be repeated on each
node.

Start the Python API from this directory:

```bash
har host --host 0.0.0.0 --port 8000 --advertise-url http://<host-ip>:8000
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

For dashboard-based connection, start the remote machine as a standalone
worker first, then open Device fabric on the Host and use **Connect a worker**:

```powershell
har worker --advertise-url http://<worker-ip>:9000 --name gpu-worker
```

Enter only the worker URL in the dashboard. The worker keeps its automatic
hostname and stable node ID; after it registers and heartbeats, it appears in
the fabric. No device is marked connected before that handshake completes.

Workers advertise on the local network over UDP port `9471`. The Device fabric
radar refreshes discovered nodes automatically and shows their real hardware
inventory before connection. Allow UDP `9471` through the Windows firewall if
the worker does not appear; the worker HTTP port (normally `9000`) is still
needed for connection and workload traffic.

### Desktop app

The Vite dashboard also has a Tauri 2 desktop shell for macOS, Windows, and
Linux. On macOS, install the Rust toolchain and Xcode Command Line Tools first:

```bash
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

Confirm `cargo --version` works, start the API with `har serve`, then run from
`web/`:

```bash
npm run desktop:dev
```

Create a native installer with:

```bash
npm run desktop:build
```

The release workflow builds the platform-specific Python runtime and embeds it
in each installer. Users do not need Python, Rust, or terminal commands.

Create a release by pushing a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow produces normal macOS and Windows installers with the local
runtime included. The same app can also connect to remote LAN workers.

Every `har serve` instance starts as a Host and exposes `GET /api/session`.
Workers join by coordinator URL; no pairing code is required:

```powershell
har worker --coordinator http://<host-ip>:8000 --advertise-url http://<worker-ip>:9000 --name gpu-worker
```

Workers keep their own local server, but are assigned the Worker role for the host
session it joined. This makes the role session-based rather than permanently
binding a particular laptop to coordinator or worker behavior.

Each node also reports a hardware inventory to the Device fabric view:
hostname, operating system, OS release, architecture, processor, physical and
logical CPU counts, CPU frequency when available, total and available RAM,
Python version, PyTorch version, CUDA runtime, MPS build status, and CUDA GPU
name, memory, compute capability, and multiprocessor count when available.
Unavailable fields remain explicitly unavailable.

The current runtime does not include learned scheduling, tensor sharding,
custom kernels, or automatic multi-machine orchestration.

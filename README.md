# HAR Runtime

HAR Runtime is a hardware-aware compute workspace for running repeatable AI
benchmarks across CPU, Apple MPS, and NVIDIA CUDA devices. Use the desktop app
for a visual control room or the `har` command for headless machines, scripts,
and remote workers.

## Product Overview

HAR turns a group of machines on one trusted LAN into a small compute fabric:

- Inspect real hardware and runtime capabilities.
- Run deterministic `matmul`, `image`, and `tree` workloads.
- Compare latency, throughput, correctness, and network round-trip time.
- Connect remote workers explicitly instead of silently discovering or using them.
- Keep the same workflow on macOS, Windows, and Linux.

HAR does not pretend that hardware is available. If a requested backend is not
installed or supported, the run fails with an explicit reason.

## Desktop App

The packaged desktop app includes its Python runtime. Users do not need Python,
Rust, Node.js, or a terminal to run the application.

Each desktop app starts in **Host** mode by default. Change the role from the
Runtime role control:

- **Host** exposes the coordinator to the LAN and runs this machine's worker.
- **Worker** keeps the dashboard local and exposes this machine as a
  discoverable worker for another host.
- **Standalone** keeps the dashboard and services local without advertising a
  worker.

Changing the role restarts only the managed runtime services. A discovered
worker is never connected automatically. A host must explicitly select it and
request a connection.

## Headless CLI

Install the package in a virtual environment or with `pipx`:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install '.[test]'
```

The package installs the `har` command:

```bash
har devices
har benchmark matmul --size 2048 --backend cpu
har benchmark matmul --size 2048 --backend cuda --json results/cuda.json
har discover
```

Start a LAN host:

```bash
har host \
  --host 0.0.0.0 \
  --port 8000 \
  --advertise-url http://192.168.1.10:8000
```

Start a worker that waits for an explicit host connection:

```bash
har worker \
  --advertise-url http://192.168.1.20:9000 \
  --name gpu-worker
```

Connect the worker without a dashboard:

```bash
har connect \
  --host http://192.168.1.10:8000 \
  --worker http://192.168.1.20:9000 \
  --name gpu-worker
```

Or register it directly when provisioning a machine:

```bash
har worker \
  --coordinator http://192.168.1.10:8000 \
  --advertise-url http://192.168.1.20:9000 \
  --name gpu-worker \
  --node-id gpu-worker-01
```

Disable worker consent when a machine should be visible but not joinable:

```bash
har worker \
  --advertise-url http://192.168.1.20:9000 \
  --deny-connections
```

## Networking

HAR uses two protocols for two different jobs:

- UDP `9471` broadcasts worker discovery on the local network. It is fast,
  connectionless, and supports broadcast without knowing every machine first.
- TCP/HTTP `8000` carries host API requests, registration, heartbeats, and job
  routing.
- TCP/HTTP `9000` carries worker join requests, benchmark execution, and result
  polling.

UDP is never used for benchmark data or result delivery. TCP is used wherever
  ordering, delivery, and request/response errors matter.

On Windows, allow UDP `9471`, the host TCP port `8000`, and the worker TCP port
`9000` through the firewall when connecting across machines. Use HAR only on a
trusted network; authentication and job isolation are not included yet.

## Supported Workloads

- `matmul`: seeded dense matrix multiplication, reported in TFLOP/s.
- `image`: seeded tensor-backed image inference, reported in images/second.
- `tree`: seeded tensor-backed traversal, reported in traversals/second.

Runs record the workload, backend, seed, timing configuration, device identity,
correctness, and measured network round-trip time. Results can be exported as
JSON or CSV.

## Development

Run the test suite:

```bash
pytest
```

Run the dashboard locally:

```bash
har host --host 0.0.0.0 --advertise-url http://<host-ip>:8000
cd web
npm ci
npm run dev
```

Build the desktop shell:

```bash
cd web
npm run desktop:build
```

The release workflow creates macOS and Windows installers with the platform
runtime included. Windows uses Inno Setup because the CUDA-enabled onedir
runtime is too large for the legacy NSIS compiler data-block limits.

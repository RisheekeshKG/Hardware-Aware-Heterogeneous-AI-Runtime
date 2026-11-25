# HAR Runtime

A Python runtime that routes individual function calls across the devices on your
personal LAN. Decorate a function with `@har.offload`, run your script with `har
execute`, and HAR picks the device per call based on measured latency and transfer
cost — CPU on your laptop, MPS on a Mac, CUDA on a Windows gaming rig, whatever
is cheapest for the inputs you handed it.

HAR is a *dispatcher*, not a compiler. It assumes you already know how to write
PyTorch / numpy / arbitrary Python. It handles **where** the work runs.

> **Not Ray, not Dask, not Modal.** Those assume a cluster or cloud account. HAR
> assumes two to five personal machines on the same Wi-Fi. One liner install,
> no DevOps, no YAML.

---

## Install

One `pip install har` gets you everything — the `@har.offload` SDK, the
host/worker services as a subpackage, and the `har` CLI. The desktop app is a
separate installer because it bundles a Rust shell + React UI.

```bash
pip install -e har/          # SDK + services + `har` CLI
# or from PyPI once 1.x stabilises:  pip install har
```

For the desktop app, download the installer from
[GitHub Releases](https://github.com/RisheekeshKG/Hardware-Aware-Heterogeneous-AI-Runtime/releases)
or build it from source (see **Development** below).

### Desktop app (host or worker, with a UI)

Download the installer for your OS from
[GitHub Releases](https://github.com/RisheekeshKG/Hardware-Aware-Heterogeneous-AI-Runtime/releases).
The installer is about 50 MB and includes the HAR runtime. On first launch HAR installs
PyTorch into its own folder: about 150 MB on a Mac, about 2.8 GB for the CUDA build on
Windows with an NVIDIA GPU. That step needs internet once; no Python install is needed on
any machine.

The big PyTorch file is downloaded in 8 parallel pieces (several times faster where the
PyTorch CDN throttles single connections), continues where it stopped after a cancel or a
dropped connection, and is checked against its published sha256. Downloads are kept in the
app's `wheels` folder (Settings → PyTorch shows where), so Repair/Reinstall never download
it again. To set up another Windows PC without the 2.8 GB download, copy the `torch-….whl`
from that folder into the same folder on the new PC before installing; HAR checks the hash
and uses it.

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon) | `HAR Runtime_<version>_aarch64.dmg` | Not notarised yet — right-click → Open on first launch |
| Windows (x64) | `HAR Runtime_<version>_x64-setup.exe` | SmartScreen will warn until code signing is in place |

---

## Quick start

### 1. One machine, your Python script

```python
# demo.py
import torch
import har

@har.offload
def matmul(size: int) -> torch.Tensor:
    L = torch.randn(size, size)
    R = torch.randn(size, size)
    return L @ R

print(matmul(2048).shape)
```

```bash
har execute demo.py
```

HAR times the call on each available backend (CPU, MPS, CUDA), caches the
measurements per argument shape in `~/.har/calibration.db`, and picks the
cheapest device for next time. On exit it prints the routing decisions:

```
__main__.matmul: mps (Apple MPS) in 112.89 ms — cheapest measured option
```

### 2. Two machines on your LAN

- **Machine A** (your Mac): open the desktop app → **Devices → Role → Host**.
- **Machine B** (your Windows PC with the 3050): open the app → **Devices →
  Role → Worker**. Copy its LAN address, e.g. `http://192.168.1.42:9000`.
- On A: **Devices → Add device** → paste the address, click **Connect**. Or let
  LAN broadcast find B automatically and click **Connect** on the discovered row.
- On B: the Accept/Decline prompt appears. Click **Accept**.

A can now offload work to B. From any script running on A:

```python
import har

@har.offload           # Default policy: router picks between local CPU/MPS and B's CUDA
def embed(docs): ...
```

A per-shape calibration cache fills in after a few calls; from then on HAR
submits the batch to whichever device has the lowest measured latency plus
estimated transfer cost over the LAN.

---

## Core concepts

### Roles

Every HAR install is in one of three roles at a time:

| Role | What it does | Which ports are bound |
|---|---|---|
| **Host** | Dispatches work. Keeps the roster of connected workers. Owns the SDK's router. | `:8000` (API) |
| **Worker** | Accepts jobs from accepted hosts. Runs them in an OS-isolated subprocess with a timeout. | `:8000` (API, loopback-only control), `:9000` (worker service) |
| **Standalone** | Local-only; no LAN exposure. For when you just want the SDK on one laptop. | `:8000` (API, loopback-only) |

Role switches use a mutex-guarded `stop → spawn` cycle so overlapping clicks
can't leave orphan processes.

### Placement policy

Per-call routing uses this cost model:

```
cost(device, call) = measured_latency(device, shape) + transfer_bytes / bandwidth(device)
```

- First call for a given `(function, shape)` pair runs on the current device and
  records a sample.
- Subsequent calls pick the device with minimum cost. Hysteresis (10% default)
  prevents thrashing when two devices are nearly tied.
- Transfer bandwidth is approximated per-link: ~12 GB/s for CUDA (PCIe), ~40 GB/s
  for MPS (unified memory), gigabit for LAN.

Cache lives at `~/.har/calibration.db`. Blow it away to reset.

### Trust and auth

- Pairing is **human-gated**: a worker only accepts a host after the person at
  the worker machine clicks Accept.
- Accepted hosts land in `~/.har-runtime/trusted-hosts.json`. The worker's UI
  shows every trusted host and offers a per-host **Revoke** button.
- Every host→worker request is **HMAC-signed** with a per-host secret the worker
  minted on accept. 60-second freshness window, constant-time compare. See
  [`src/har_runtime/signing.py`](src/har_runtime/signing.py).
- Pre-HMAC hosts fall back to IP-based ACL so a mixed-version LAN keeps working
  during rollout. New installs always use HMAC.

### Script isolation

User scripts run in a dedicated OS subprocess, not a thread. That means:

- A crashing or hanging script can only harm its own process.
- Timeouts are enforced via `SIGKILL` on the whole process group (POSIX
  `killpg`, Windows `taskkill /F /T`) — grandchildren get killed too.
- Duration measurements come from `time.monotonic()` inside the subprocess, so
  wall-clock skew between host and worker can't poison the "Remote execute" number.
- Default timeout is 10 min; override per-run with `timeout_seconds` on the
  `ScriptRunRequest`.

---

## Architecture

```mermaid
flowchart LR
  subgraph UI_Local["UI (localhost loopback)"]
    UI[Tauri window<br/>polls every 3s]
  end

  subgraph Host["Host machine · 10.0.0.5"]
    direction TB
    HTauri[Rust shell<br/>parent] -->|spawn child| HAPI
    HAPI[har-runtime-server<br/>TCP :8000]
    HAPI --- HTPool["ThreadPool<br/>per-script subprocess"]
    HAPI --- HLocks["ROLE_SWITCH mutex<br/>_node_secrets"]
    HAPI --- HFS["~/.har/calibration.db<br/>~/.har-runtime/*.json"]
    HListen[UDP :9471<br/>discovery listener]
    HAPI --- HListen
  end

  subgraph Worker["Worker machine · 10.0.0.7"]
    direction TB
    WTauri[Rust shell] -->|spawn x2| WAPI
    WTauri -->|spawn x2| WJob
    WAPI[API proxy<br/>TCP :8000<br/>loopback-only control]
    WJob[Worker service<br/>TCP :9000]
    WJob --- WReg["_registration_loop<br/>heartbeat 5s"]
    WJob --- WBeacon["DiscoveryBeacon<br/>UDP broadcast 2s"]
    WJob --- WTrust["_trusted_hosts<br/>_host_secrets (HMAC)"]
  end

  UI -.->|HTTP loopback| HAPI
  HAPI ==>|TCP :9000<br/>register · heartbeat · jobs<br/>HMAC-signed| WJob
  WBeacon -.->|UDP :9471<br/>SO_BROADCAST| HListen
```

### Script execution lifecycle

```mermaid
sequenceDiagram
  autonumber
  participant User as `har execute foo.py`
  participant H as Host API :8000
  participant W as Worker :9000
  participant Sub as Isolated subprocess

  Note over User,H: idempotency_key dedupes retries
  User->>H: POST /api/scripts  → 202 Accepted
  H->>H: validate target node online<br/>(or 400 before creating record)

  Note over H,W: HMAC-signed, 60s freshness
  H->>W: POST /worker/scripts<br/>X-HAR-Timestamp, X-HAR-Signature
  W->>W: _require_trusted: verify signature<br/>(or IP ACL fallback)
  W->>Sub: subprocess.Popen(..., start_new_session=True)
  Note right of Sub: time.monotonic() start

  loop every 0.25s
    H->>W: GET /worker/scripts/{id} (signed)
    W-->>H: status
  end

  Note right of Sub: SIGKILL process group<br/>on timeout
  Sub-->>W: exit_code, stdout, execute_seconds
  W-->>H: snapshot with monotonic execute_seconds

  H-->>User: snapshot, timings, output
```

---

## Hardware support

| Backend | Runtime availability check | Memory source | Utilization probe |
|---|---|---|---|
| **CPU** | Always | `psutil.virtual_memory()` | `psutil.cpu_percent()` |
| **Apple MPS** | `torch.backends.mps.is_available()` | `torch.mps.recommended_max_memory()` minus `current_allocated_memory()` | *Not exposed by Apple without `sudo powermetrics`* |
| **NVIDIA CUDA** | `torch.cuda.is_available()` | `torch.cuda.mem_get_info()` | `pynvml.nvmlDeviceGetUtilizationRates()` with `nvidia-smi` fallback |

CPU detection reads the real brand and max frequency on each OS:

- macOS: `sysctl machdep.cpu.brand_string` + `hw.cpufrequency_max`
- Linux: `/proc/cpuinfo` `model name` + `cpu MHz`
- Windows: `Win32_Processor.Name` + `.MaxClockSpeed` (wmic first, PowerShell
  `Get-CimInstance` fallback for Windows 11 24H2+)

---

## CLI reference

```bash
har devices                           # list CPU/MPS/CUDA on this machine
har execute script.py [-- args]       # run script with SDK pre-loaded, print routing decisions
har host --advertise-url ...          # start as host
har worker --coordinator ...          # start as worker, auto-register with host
har discover                          # one-shot LAN scan
har connect --host ... --worker ...   # pair without the UI
har benchmark matmul --size 4096 --backend cuda   # built-in micro-benchmarks (dev tool)
```

`har --help` and `har <command> --help` have the full option list.

---

## Environment parity

Workers refuse jobs they can't actually run — or at least surface the mismatch
before the user wonders why nothing happened. The host can call
`/api/nodes/{id}/env-hash` and get:

```json
{
  "host":   { "python": "3.12.9", "packages": {"torch": "2.14.1", ...}, "hash": "..." },
  "worker": { "python": "3.12.9", "packages": {"torch": "2.11.0", ...}, "hash": "..." },
  "mismatches": ["torch: 2.14.1 / worker 2.11.0"],
  "compatible": false
}
```

HAR checks:
- Python major.minor.patch
- `torch`, `numpy`, `psutil`, `fastapi`, `uvicorn`, `httpx`, `pydantic`, `pynvml`

Future: block dispatch when `compatible == false` instead of just warning. Open
to feedback on which other packages should land in the key set.

---

## Development

```bash
python -m venv .venv
source .venv/bin/activate              # or .venv\Scripts\activate on Windows
pip install -e "har/[test]"             # SDK + services + test deps
cd har && pytest                        # ~100 tests, ~10 s
```

### Desktop app from source

```bash
./scripts/build-sidecar.sh              # PyInstaller runtime + bundled uv (Windows: build-sidecar.ps1)
cd desktop
npm ci
npm run desktop:dev                     # live-reload app
npm run desktop:build                   # app/installer in src-tauri/target/release/bundle/
```

`npm run lint` must pass; it catches a component used without an import.

### CI

[`ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and every PR, on macOS
and Windows (the two platforms HAR ships for):

- **Python tests**: `pytest` on Python 3.12, the version the app bundles.
- **Desktop app**: ESLint, the Vite build, and `cargo check` of the Rust shell (which has
  macOS- and Windows-only code paths).

[`release.yml`](.github/workflows/release.yml) runs on a `v*` tag: it runs CI, builds the
macOS `.dmg` and the Windows installer, and publishes them as a GitHub release.

---

## Status

### Working

- `@har.offload` SDK with per-shape calibration + hysteresis
- `har execute` CLI
- Host/Worker/Standalone roles, mutex-serialized switching
- LAN discovery via UDP broadcast, discovered-vs-connected dedupe
- Human-approved pairing, trusted-host revoke, HMAC-signed requests
- Subprocess isolation, SIGKILL-tree on timeout, monotonic durations
- Idempotency keys on script submission
- Live script output (SSE, resumes after a dropped connection) and Stop for running scripts
- Desktop app: an IDE-style Scripts page (files in `~/HAR/scripts`, tabs, autosave, ⌘↵ run,
  output console), per-computer device pages, Settings, first-launch PyTorch install with
  parallel, resumable downloads

### Deliberately not yet

| Gap | Why it's not shipped yet |
|---|---|
| Durable job queue | Scheduled; schema change is isolated to its own PR |
| Code-signed installers | Needs paid Apple Developer ID + Windows EV cert |
| mDNS discovery | UDP broadcast doesn't cross subnets; mDNS does, planned |
| Multi-host coordination | HAR assumes one host, many workers; multi-host election is out of scope for 1.x |

### Won't do

- Kubernetes integration. If you're at K8s scale you want
  [NVIDIA KAI Scheduler](https://github.com/NVIDIA/KAI-Scheduler), not HAR.
- Cloud offload. HAR is for machines you own.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HAR_IDLE_TIMEOUT_SECONDS` | `3600` (1 hour) | Host API and worker service exit via SIGTERM if there are no HTTP requests (excluding `/health`) and no running jobs for this many seconds. Prevents orphan processes from pinning ports 8000 / 9000 forever. Set to `0` to disable. |
| `HAR_RATE_LIMIT_PER_MIN` | `10` | Per-source-IP rate limit on job submission endpoints (`POST /api/scripts`, `POST /api/runs`, and the worker equivalents). Over the limit → `429 Too Many Requests` with `Retry-After`. Set to `0` to disable. |
| `HAR_RATE_LIMIT_WINDOW_SECONDS` | `60` | Sliding window the rate limiter counts across. |
| `HAR_CORS_ORIGINS` | Tauri + localhost | Comma-separated allowed origins for the host API. Defaults to the Vite dev server and the Tauri webview. |
| `HAR_CALIBRATION_DB` | `~/.har/calibration.db` | SQLite file holding per-shape latency measurements and per-backend measured bandwidths. Blow it away to reset the router's memory. |
| `HAR_WORKSPACE_DIR` | `~/HAR/scripts` | Folder of `.py` files the desktop app's Scripts page edits. |
| `HAR_HOME` | `~/.har` | Overrides the base directory for HAR's state files (calibration DB, per-worker trusted hosts, etc.). |

On SIGTERM (triggered either by the idle watchdog, the OS, or a `kill` from a terminal) the
server marks every queued / running job as failed with a clear reason, kills any tracked
subprocess trees, and lets uvicorn drain in-flight HTTP connections normally. No orphan
`python` processes and no "scripts stuck running" entries in the UI history.

## Networking summary

| Protocol | Port | Scope | Purpose |
|---|---|---|---|
| UDP | 9471 | LAN broadcast | Service discovery; never carries job data |
| TCP | 8000 | LAN (host), loopback (worker/standalone) | Host API, UI, control plane |
| TCP | 9000 | LAN | Worker jobs. HMAC-signed from paired hosts |

### Firewall

- **Linux** (`ufw`): `sudo ufw allow 9471/udp && sudo ufw allow 8000/tcp && sudo ufw allow 9000/tcp`
- **Windows**: allow inbound on UDP 9471, TCP 8000, TCP 9000
- **macOS**: no action needed by default

---

## Project layout

```
har/                                  # pip install har — the whole Python package
├── pyproject.toml
├── har-runtime-server.spec           # PyInstaller spec for the desktop app's runtime
├── har/
│   ├── __init__.py                   # public SDK: offload, devices, map, where_did_it_run
│   ├── decorator.py, router.py       # @offload + cost model with hysteresis
│   ├── calibration.py                # SQLite cache of measured latencies
│   ├── execute.py, inventory.py      # move tensors and run; discover CPU/MPS/CUDA
│   └── runtime/                      # host + worker services
│       ├── api/                      # host API (FastAPI, :8000), one module per area
│       ├── worker.py                 # worker service (FastAPI, :9000)
│       ├── cli.py                    # the `har` command
│       ├── subprocess_runner.py      # isolated script runs, stop, kill-tree
│       ├── torch_install.py          # first-launch PyTorch install (parallel, resumable)
│       └── …                         # signing, discovery, devices, benchmarks, shutdown
└── tests/

desktop/                              # the desktop app (Tauri: Rust shell + React UI)
├── src-tauri/                        # Rust shell: starts the runtime, installs PyTorch
└── src/                              # React UI — see docs/current-ui.md
    ├── App.jsx, state.jsx, api.js, helpers.js, ui.jsx
    ├── pages/                        # Overview, Scripts, Devices, Settings, Benchmarks, Setup
    └── styles/                       # theme.css (colours) + app.css

scripts/                              # build-sidecar.sh/.ps1, windows-installer.iss, offload_demo.py
docs/                                 # current-ui.md, style.md
.github/workflows/                    # ci.yml, release.yml
```

---

## License

TBD before 1.0 final. Expect MIT or Apache-2.0.

# HAR Runtime Console

## Product Context

HAR is a hardware-aware heterogeneous AI runtime. It executes tensor workloads across available compute devices such as CPU, Apple MPS, NVIDIA CUDA, and remote CUDA workers.

This is a systems/runtime product, not an LLM wrapper and not primarily a benchmark application. Benchmarking and profiling are supporting capabilities used to understand execution performance.

## Design Goal

Design a desktop-first runtime control console for a future Tauri application. The interface should feel like a serious developer tool for observing and controlling heterogeneous compute workloads.

The primary question the UI should answer is:

> What is running, where is it running, and what is the runtime doing with the available hardware?

## Main Navigation

Create four main product areas:

1. **Runtime**
   - Live overview of active workloads.
   - Runtime health.
   - Connected device count.
   - Current backend placement.
   - Recent execution activity.

2. **Workloads**
   - Launch a Python workload such as `python train.py`.
   - Choose a placement policy:
     - Auto-select
     - Prefer CUDA
     - Local only
   - Show queued, running, completed, and failed workloads.
   - Make workload execution the primary action.

3. **Compute Fabric**
   - Show local CPU, Apple MPS, and NVIDIA CUDA devices.
   - Show remote worker nodes.
   - Display online/offline state, utilization, memory, active workload, and capabilities.

4. **Traces**
   - Show operation timelines.
   - Show which backend ran each operation.
   - Show host/device transfer events.
   - Show latency and throughput as supporting profiling telemetry.

## Runtime Overview Screen

Create a strong overview screen with:

- Left navigation rail.
- HAR Runtime branding.
- Large heading: `Runtime Console`.
- Connection status indicator.
- Summary cards:
  - Active workloads
  - Devices online
  - Runtime health
  - Memory pressure
- Large active workload card showing:
  - Workload name, for example `image_pipeline.py`
  - Status: `RUNNING`
  - Operation graph size, for example `18 operations`
  - Placement policy: `AUTO`
  - Current backend: `CUDA`
  - Device name: `RTX 3050`
  - Progress bar
- Recent execution list.

## Workload Screen

Create a workload launch panel with:

- Python entrypoint field.
- Optional arguments field.
- Placement policy selector.
- Device preference selector.
- `Run with HAR` primary button.
- Workload queue with status badges.

Do not make matrix size, warmup passes, or benchmark iterations the main interaction. Those belong in profiling details later.

## Trace Screen

Create a trace view with:

- Horizontal operation timeline.
- Rows for operations such as:
  - `load_batch`
  - `matmul`
  - `relu`
  - `reduce`
- Backend color coding:
  - CPU: blue
  - MPS: violet
  - CUDA: green
  - Transfer: amber
- Operation detail panel showing duration, backend, tensor size, and transfer bytes.

## Visual Language

- Dark near-black background.
- Technical developer-tool aesthetic.
- Lime green as the primary runtime accent.
- Blue, violet, and amber for backend/transfer distinction.
- Thin borders and restrained shadows.
- Dense but readable information layout.
- Monospace typography for telemetry and technical values.
- Modern sans-serif typography for headings and navigation.
- Use compact status labels such as `IDLE`, `QUEUED`, `RUNNING`, `COMPLETED`, and `FAILED`.

## Design Constraints

- Desktop-first layout suitable for Tauri.
- Responsive enough for smaller windows.
- Avoid generic SaaS dashboard styling.
- Avoid charts dominating the interface.
- Avoid marketing language and AI/LLM imagery.
- Do not present fake benchmark numbers as real data; use clearly labeled sample data.
- Prioritize workload state, backend placement, device health, and execution traces.

## Expected Output

Create a polished multi-screen desktop UI concept for the HAR Runtime Console. Show the Runtime overview as the primary screen and include the Workloads, Compute Fabric, and Traces areas as connected views.

# Current HAR Runtime UI

## Current Product Presentation

The current application presents HAR as a benchmark control dashboard. It is a dark desktop-style React/Vite web interface with a left navigation rail and a central benchmark workspace.

## Layout

### Left Sidebar

- HAR logo and `runtime control` label.
- `Benchmark lab` as the active navigation item.
- `Device fabric` navigation item.
- `Result archive` navigation item.
- API connection status at the bottom.

### Main Header

- Eyebrow: `HARDWARE-AWARE AI RUNTIME / MILESTONE 2`.
- Main heading: `Benchmark lab`.
- Description: `Shape a workload. Measure the machine. Keep every number honest.`
- Live API status indicator.

### Local Machine Setup

- Shows frontend control status.
- Displays whether setup is ready, running, or unavailable.
- Includes a `Setup this PC` button for the approved CUDA setup flow.

### Compute Fabric

- Shows the local coordinator.
- Shows remote worker nodes.
- Displays online/offline state.
- Lists available CPU, MPS, or CUDA backends.
- Shows memory or workload readiness information.

### Workload Definition Panel

The main control panel is for a matrix multiplication benchmark.

Controls include:

- Compute node selector.
- Execution backend selector.
- Matrix dimension.
- Random seed.
- Warm-up passes.
- Measured passes.
- `Run on selected device` button.

While running, it shows measured iteration progress and the latest sample latency.

### Results Area

The results area contains metric cards for:

- Median latency.
- Median throughput.
- Correctness.
- Memory state.

It also contains a per-iteration latency bar chart.

### Recent Runs

The bottom section shows a table of recent benchmark runs with:

- Run ID.
- Backend.
- Workload size.
- Number of passes.
- Status.
- Median latency.

## Visual Style

- Dark near-black background.
- Lime green primary accent.
- Blue, green, purple, and orange metric accents.
- Thin borders and compact cards.
- Technical monospace labels and telemetry.
- Modern sans-serif headings.
- Dense developer-tool layout.

## Current Strengths

- Clearly communicates real device execution.
- Shows local and remote compute nodes.
- Has a strong technical visual identity.
- Provides live run progress.
- Makes benchmark measurements easy to compare.

## Current Limitations

- The interface feels like a benchmark application rather than a runtime.
- `Benchmark lab` is the dominant product concept.
- Matrix multiplication is the only visible workload.
- There is no workload/script launch flow.
- There is no operation graph or execution trace.
- Backend placement is shown as a selection, not as a runtime decision.
- The dashboard does not yet communicate scheduler behavior, transfers, or runtime orchestration.

## Redesign Direction

Keep the dark technical style and compute-fabric visibility, but reposition the product around:

- Runtime overview.
- Python workload execution.
- Backend placement.
- Device health.
- Operation traces.
- Profiling as a supporting capability rather than the primary experience.

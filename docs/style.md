# HAR Runtime Console Style Guide

## Design Character

HAR is a serious developer tool for heterogeneous compute. The interface should feel precise, operational, and observability-focused.

The visual language is:

- Dark technical console.
- Dense but readable.
- Data-first, not decorative.
- Calm during normal operation.
- High contrast during failures or resource pressure.
- Focused on workloads, placement, devices, and traces.

Avoid presenting HAR as a generic SaaS dashboard, an AI chatbot, or a benchmark-only application.

## Color Tokens

### Core

```css
--bg-root: #0b0d11;
--bg-sidebar: #0a0c10;
--bg-panel: #11151a;
--bg-panel-raised: #171c22;
--bg-input: #0c0f13;
--border-subtle: #252c33;
--border-strong: #35414d;
--text-primary: #e8edf1;
--text-secondary: #9aa6b2;
--text-muted: #687582;
--text-disabled: #46515c;
```

### Runtime Accent

```css
--accent-runtime: #d9ff72;
--accent-runtime-soft: #9fe870;
--accent-runtime-dark: #536f36;
```

Use lime for active navigation, primary actions, healthy runtime indicators, and selected states.

### Backend Colors

```css
--backend-cpu: #71c8ff;
--backend-mps: #c29cff;
--backend-cuda: #9fe870;
--backend-transfer: #ffbd72;
```

Backend colors must remain consistent across badges, traces, timelines, charts, and device cards.

### Status Colors

```css
--status-success: #91e3a5;
--status-running: #d9ff72;
--status-warning: #ffbd72;
--status-error: #ff9272;
--status-offline: #59646f;
```

## Typography

Use a modern sans-serif for structure and a monospace font for technical information.

```css
--font-ui: "Manrope", "Inter", sans-serif;
--font-mono: "DM Mono", "JetBrains Mono", monospace;
```

### Usage

- Page headings: UI font, bold, tight letter spacing.
- Section headings: UI font, semibold.
- Navigation: UI font, medium.
- Labels and eyebrow text: monospace, uppercase, letter spacing.
- IDs, backends, durations, memory values, and statuses: monospace.
- Body descriptions: UI font, secondary color, relaxed line height.

### Scale

```text
Page title:       32-48px
Section title:    18-22px
Card title:       14-16px
Body:             13-14px
Telemetry:        11-13px
Labels:           9-10px
```

## Layout

### Desktop

- Fixed left navigation rail: 220-240px.
- Main content max width: 1400px.
- Main horizontal padding: 40-72px.
- Use a 12px or 16px base gap.
- Prefer two-column layouts for control plus detail.
- Keep the active workload visually dominant.

### Responsive

- At 900px, collapse the sidebar to an icon rail.
- At 700px, stack control and detail panels.
- At 620px, use one-column cards and hide table headers.
- Never let telemetry overflow horizontally.

## Spacing

Use a compact 4px base system:

```text
4px   micro gap
8px   control gap
12px  card and grid gap
16px  standard panel padding
24px  large panel padding
32px  section separation
48px  page-level separation
```

## Surfaces and Borders

- Use near-black surfaces with subtle one-pixel borders.
- Use raised backgrounds only for active or selected content.
- Avoid heavy shadows and glassmorphism.
- Use lime inset borders for active navigation.
- Use colored top borders on summary metrics.
- Use border color, not background color alone, to communicate state.

## Navigation

Primary navigation:

1. Runtime
2. Workloads
3. Compute Fabric
4. Traces

Active navigation uses:

- `--bg-panel-raised` background.
- `--accent-runtime` left inset border.
- Runtime accent icon.
- Primary text color.

Inactive navigation uses muted text and no decorative emphasis.

## Buttons

### Primary

- Lime background.
- Dark text.
- Bold UI font.
- Used for `Run with HAR`, `Attach worker`, and other primary actions.

### Secondary

- Transparent or panel background.
- Strong border.
- Primary text.
- Used for `View trace`, `Inspect`, and non-destructive actions.

### Destructive

- Dark red background or red border.
- Error text color.
- Use only for stopping or removing workloads.

Buttons should be compact and operational. Avoid oversized marketing-style CTAs.

## Runtime Statuses

Use explicit labels rather than ambiguous icons:

```text
IDLE       muted gray
QUEUED     amber
RUNNING    lime
COMPLETED  green
FAILED     red
OFFLINE    gray
```

Status indicators may include a small glowing dot, but the text label is always required.

## Backend Badges

Backend badges use short uppercase labels:

```text
CPU       blue
MPS       violet
CUDA      green
TRANSFER  amber
```

Do not use color alone to communicate backend identity. Always include the label.

## Cards

Cards should have a clear hierarchy:

1. Small uppercase section label.
2. Main title or value.
3. Supporting technical detail.
4. Optional state or action aligned to the right.

Useful card types:

- Active workload card.
- Runtime health card.
- Device card.
- Metric card.
- Trace operation card.
- Recent workload row.

## Runtime Overview

The Runtime screen should prioritize:

1. Active workload.
2. Current placement and execution state.
3. Device health.
4. Recent workload history.

Do not put benchmark configuration fields on this screen.

## Workloads

The Workloads screen should prioritize:

- Python entrypoint.
- Runtime placement policy.
- Target device preference.
- Run state.
- Queue visibility.

Use language such as `Launch workload`, `Placement policy`, and `Run with HAR`.

Avoid language such as `Run benchmark` unless the user is explicitly in profiling mode.

## Traces

Trace views should make execution explainable:

- Every operation has a name and backend.
- Transfers are visually distinct from computation.
- Durations use monospace formatting.
- Missing telemetry is shown as `UNAVAILABLE`.
- Timeline density is preferred over decorative charts.

## Empty States

Empty states should explain the next meaningful action.

Good:

```text
No active workloads.
Launch a Python workload to inspect runtime placement here.
```

Bad:

```text
Nothing here yet.
```

## Errors and Warnings

- Keep errors inline near the affected action when possible.
- Use a persistent banner for API or runtime connection failures.
- Explain what is unavailable and what the user can do next.
- Never replace the entire interface with an error screen.
- Never fabricate device or performance data.

## Do

- Make runtime behavior visible.
- Show where work is running.
- Keep device state current and explicit.
- Use real technical terminology.
- Treat profiling as supporting evidence.
- Keep the interface useful when the backend is disconnected.

## Do Not

- Make benchmarks the home screen identity.
- Use AI/LLM imagery or chat metaphors.
- Use excessive gradients, rounded cards, or decorative charts.
- Hide backend placement behind generic labels.
- Show fake performance numbers without labeling sample data.
- Add UI controls for backend features that do not exist yet.

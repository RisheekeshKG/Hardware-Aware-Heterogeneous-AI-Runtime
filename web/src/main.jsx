import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

const API = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

const formatBytes = (bytes) => {
  if (bytes == null) return "Unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const formatLatency = (seconds) => {
  if (seconds == null) return "—";
  if (seconds < 0.001) return `${(seconds * 1e6).toFixed(1)} µs`;
  return `${(seconds * 1e3).toFixed(2)} ms`;
};

function App() {
  const [devices, setDevices] = useState([]);
  const [localHost, setLocalHost] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [nearby, setNearby] = useState([]);
  const [runs, setRuns] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [view, setView] = useState("benchmark");
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [runtimeRole, setRuntimeRole] = useState("host");
  const [changingRole, setChangingRole] = useState(false);
  const [form, setForm] = useState({
    workload: "matmul",
    size: 1024,
    batch_size: 8,
    image_size: 32,
    depth: 12,
    traversal_count: 4096,
    backend: "cpu",
    target_node: "local",
    warmup_iterations: 3,
    measured_iterations: 10,
    seed: 42,
  });
  const [error, setError] = useState("");
  const runtimeReadyRef = useRef(false);

  useEffect(() => {
    const loadRuntimeState = () =>
      Promise.all([
        fetch(`${API}/api/health`),
        fetch(`${API}/api/system`),
        fetch(`${API}/api/nodes`),
        fetch(`${API}/api/discovery`),
        fetch(`${API}/api/runs`),
        fetch(`${API}/api/runtime/role`),
      ])
        .then(async ([healthResponse, systemResponse, nodeResponse, discoveryResponse, runResponse, roleResponse]) => {
            if (
              !healthResponse.ok ||
              !systemResponse.ok ||
              !nodeResponse.ok ||
              !discoveryResponse.ok ||
              !runResponse.ok ||
              !roleResponse.ok
            )
              throw new Error(
                "Workspace unavailable. Start the runtime and try again.",
              );
            const system = await systemResponse.json();
            setError("");
            setLocalHost(system.host);
            setDevices(system.devices);
            setNodes(await nodeResponse.json());
            setNearby(await discoveryResponse.json());
            setRuns(await runResponse.json());
            setRuntimeRole((await roleResponse.json()).role || "host");
            runtimeReadyRef.current = true;
            setRuntimeReady(true);
          })
        .catch((err) => {
          if (runtimeReadyRef.current) setError(err.message);
        });
    loadRuntimeState();
    const refresh = window.setInterval(loadRuntimeState, 5000);
    return () => window.clearInterval(refresh);
  }, []);

  const changeRuntimeRole = async (event) => {
    const nextRole = event.target.value;
    setChangingRole(true);
    setError("");
    try {
      await invoke("set_runtime_role", { role: nextRole });
      setRuntimeRole(nextRole);
    } catch (err) {
      setError(`Could not change runtime role: ${err}`);
    } finally {
      setChangingRole(false);
    }
  };

  if (!runtimeReady) {
    return (
      <main className="startup-screen">
        <div className="startup-card">
          <div className="startup-spinner" />
          <div className="eyebrow">HAR Runtime</div>
          <h1>Starting local runtime</h1>
          <p>Loading the Host and Worker services. This can take about a minute on the first launch.</p>
          <span className="startup-status">Waiting for services to become ready...</span>
        </div>
      </main>
    );
  }

  const launchRun = async (event) => {
    event.preventDefault();
    setError("");
    setActiveRun(null);
    try {
      const response = await fetch(`${API}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          size: Number(form.size),
          warmup_iterations: Number(form.warmup_iterations),
          measured_iterations: Number(form.measured_iterations),
          seed: Number(form.seed),
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.detail || "Could not start benchmark");
      setActiveRun(data);
      setRuns((current) => [data, ...current]);
      const protocol = API.startsWith("https") ? "wss" : "ws";
      const socket = new WebSocket(
        `${protocol}://${new URL(API).host}/api/runs/${data.id}/events`,
      );
      const pollRun = async () => {
        const statusResponse = await fetch(`${API}/api/runs/${data.id}`);
        if (!statusResponse.ok) return;
        const currentRun = await statusResponse.json();
        setActiveRun(currentRun);
        setRuns((current) =>
          current.map((run) =>
            run.id === currentRun.id ? currentRun : run,
          ),
        );
        if (currentRun.status === "running") window.setTimeout(pollRun, 1000);
      };
      socket.onmessage = (message) => {
        const eventData = JSON.parse(message.data);
        setActiveRun((current) => ({
          ...current,
          status:
            eventData.type === "completed"
              ? "completed"
              : eventData.type === "failed"
                ? "failed"
                : "running",
          completed_iterations:
            eventData.completed_iterations ||
            current?.completed_iterations ||
            0,
          last_latency_seconds:
            eventData.latency_seconds || current?.last_latency_seconds,
          result: eventData.result || current?.result,
          error: eventData.error || current?.error,
        }));
        if (eventData.type === "completed" || eventData.type === "failed") {
          fetch(`${API}/api/runs/${data.id}`)
            .then((res) => res.json())
            .then((finalRun) => {
              setActiveRun(finalRun);
              setRuns((current) =>
                current.map((run) => (run.id === finalRun.id ? finalRun : run)),
              );
            });
          socket.close();
        }
      };
      socket.onerror = () => {
        socket.close();
        setError("");
        pollRun();
      };
    } catch (err) {
      setError(err.message);
    }
  };

  const update = (key) => (event) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));
  const availableDevices = (
    form.target_node === "local"
      ? devices
      : nodes.find((node) => node.node_id === form.target_node)?.capabilities ||
        []
  ).filter((device) => device.available);
  const completedRuns = runs.filter(
    (run) => run.status === "completed" && run.result,
  );
  const latestResult = activeRun?.result || completedRuns[0]?.result;
  const samples = latestResult?.samples_seconds || [];
  const metricValue =
    latestResult?.benchmark === "image"
      ? `${latestResult.metrics?.median_images_per_second?.toFixed(1) || "—"} img/s`
      : latestResult?.benchmark === "tree"
        ? `${latestResult.metrics?.median_traversals_per_second?.toFixed(0) || "—"} trav/s`
        : latestResult
          ? `${latestResult.throughput_tflops?.median?.toFixed(3) || "—"} TFLOP/s`
          : "—";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">H</span>
          <div>
            <strong>HAR</strong>
            <span>compute workspace</span>
          </div>
        </div>
        <div className="nav-label">Workspace</div>
        <button
          className={`nav-item ${view === "benchmark" ? "active" : ""}`}
          onClick={() => setView("benchmark")}
        >
          <span>◈</span> Benchmark lab
        </button>
        <button
          className={`nav-item ${view === "fabric" ? "active" : ""}`}
          onClick={() => setView("fabric")}
        >
          <span>⌁</span> Device fabric
        </button>
        <button
          className={`nav-item ${view === "archive" ? "active" : ""}`}
          onClick={() => setView("archive")}
        >
          <span>↗</span> Result archive
        </button>
        <div className="sidebar-foot">
          <span className="pulse-dot" /> {error ? "Needs attention" : "Ready"}
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div>
            <div className="eyebrow">HARDWARE-AWARE COMPUTE</div>
            <h1>
              {view === "fabric"
                ? "Device fabric"
                : view === "archive"
                  ? "Result archive"
                  : "Benchmark lab"}
            </h1>
            <p>
              {view === "fabric"
                ? "Find available machines and connect them to your workspace."
                : view === "archive"
                  ? "Review measured workloads and compare results."
                  : "Run a workload, inspect the machine, and keep the result."}
            </p>
          </div>
          <label className="role-picker">
            <span>Runtime role</span>
            <select value={runtimeRole} onChange={changeRuntimeRole} disabled={changingRole}>
              <option value="host">Host</option>
              <option value="worker">Worker</option>
              <option value="standalone">Standalone</option>
            </select>
          </label>
        </header>
        {error && <div className="error-banner">{error}</div>}
        {view === "fabric" && (
          <FabricPage
            localHost={localHost}
            devices={devices}
            nodes={nodes}
            nearby={nearby}
            onDiscoveryRefresh={async () => {
              const response = await fetch(`${API}/api/discovery`);
              setNearby(await response.json());
            }}
            onConnected={() =>
              setError("Join request sent. Waiting for worker heartbeat...")
            }
          />
        )}
        {view === "archive" && <ArchivePage runs={runs} />}
        <section className={view === "benchmark" ? "" : "view-hidden"}>
          <section className="device-strip">
            <div className="section-kicker">
              Available machines{" "}
              <span>
                · {nodes.filter((node) => node.status === "online").length + 1}{" "}
                ready
              </span>
            </div>
            <div className="node-grid">
              <div className="node-banner local">
                <div className="node-top">
                  <span className="device-led" />
                  <strong>{localHost?.hostname || "This machine"}</strong>
                  <span className="device-state">READY</span>
                </div>
                <div className="device-name">
                  Local machine ·{" "}
                  {devices
                    .filter((device) => device.available)
                    .map((device) => device.backend.toUpperCase())
                    .join(" / ")}
                </div>
                <HostDetails host={localHost} devices={devices} />
              </div>
              {nodes.map((node) => (
                <div
                  className={`node-banner ${node.status === "online" ? "available" : "offline"}`}
                  key={node.node_id}
                >
                  <div className="node-top">
                    <span
                      className={`device-led ${node.status !== "online" ? "muted" : ""}`}
                    />
                    <strong>{node.name}</strong>
                    <span className="device-state">
                      {node.status === "online" ? "READY" : "OFFLINE"}
                    </span>
                  </div>
                  <div className="device-name">
                    Remote machine ·{" "}
                    {node.capabilities
                      .filter((device) => device.available)
                      .map((device) => device.backend.toUpperCase())
                      .join(" / ") || "No available devices"}
                  </div>
                  <HostDetails host={node.host} devices={node.capabilities} />
                  <div className="node-meta">
                    {node.active_job
                      ? "Running a workload"
                      : "Available for work"}
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section className="workspace-grid">
            <form className="control-panel" onSubmit={launchRun}>
              <div className="panel-heading">
                <div>
                  <div className="section-kicker">Choose a workload</div>
                  <h2>
                    {form.workload === "matmul"
                      ? "Matrix multiplication"
                      : form.workload === "image"
                        ? "Image inference"
                        : "Tree traversal"}
                  </h2>
                </div>
              </div>
              <p className="panel-copy">
                Adjust the inputs, choose a machine, and start a measured run.
              </p>
              <label>
                Benchmark workload
                <select
                  value={form.workload}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      workload: event.target.value,
                    }))
                  }
                >
                  <option value="matmul">Matrix multiplication</option>
                  <option value="image">Image inference · built-in CNN</option>
                  <option value="tree">Tree traversal</option>
                </select>
              </label>
              <label>
                Compute node
                <select
                  value={form.target_node}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      target_node: event.target.value,
                      backend:
                        event.target.value === "local"
                          ? "cpu"
                          : nodes
                              .find(
                                (node) => node.node_id === event.target.value,
                              )
                              ?.capabilities.find((device) => device.available)
                              ?.backend || "cpu",
                    }))
                  }
                >
                  <option value="local">LOCAL · this machine</option>
                  {nodes.map((node) => (
                    <option
                      value={node.node_id}
                      key={node.node_id}
                      disabled={node.status !== "online"}
                    >
                      {node.name} · {node.status}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Execution backend
                <select value={form.backend} onChange={update("backend")}>
                  {availableDevices.map((device) => (
                    <option value={device.backend} key={device.backend}>
                      {device.backend.toUpperCase()} · {device.device_name}
                    </option>
                  ))}
                </select>
              </label>
              {form.workload === "matmul" && (
                <div className="field-row">
                  <label>
                    Matrix dimension
                    <input
                      type="number"
                      min="1"
                      max="16384"
                      value={form.size}
                      onChange={update("size")}
                    />
                    <span className="field-hint">N × N · float32</span>
                  </label>
                  <label>
                    Seed
                    <input
                      type="number"
                      value={form.seed}
                      onChange={update("seed")}
                    />
                  </label>
                </div>
              )}
              {form.workload === "image" && (
                <div className="field-row">
                  <label>
                    Batch size
                    <input
                      type="number"
                      min="1"
                      max="4096"
                      value={form.batch_size}
                      onChange={update("batch_size")}
                    />
                  </label>
                  <label>
                    Image size
                    <input
                      type="number"
                      min="4"
                      max="1024"
                      value={form.image_size}
                      onChange={update("image_size")}
                    />
                  </label>
                </div>
              )}
              {form.workload === "tree" && (
                <div className="field-row">
                  <label>
                    Tree depth
                    <input
                      type="number"
                      min="1"
                      max="20"
                      value={form.depth}
                      onChange={update("depth")}
                    />
                  </label>
                  <label>
                    Traversals
                    <input
                      type="number"
                      min="1"
                      max="1000000"
                      value={form.traversal_count}
                      onChange={update("traversal_count")}
                    />
                  </label>
                </div>
              )}
              <div className="field-row">
                <label>
                  Warm-up passes
                  <input
                    type="number"
                    min="0"
                    max="1000"
                    value={form.warmup_iterations}
                    onChange={update("warmup_iterations")}
                  />
                </label>
                <label>
                  Measured passes
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    value={form.measured_iterations}
                    onChange={update("measured_iterations")}
                  />
                </label>
              </div>
              <button
                className="run-button"
                type="submit"
                disabled={activeRun?.status === "running"}
              >
                <span>{activeRun?.status === "running" ? "◌" : "▶"}</span>
                {activeRun?.status === "running"
                  ? "Benchmark running"
                  : "Run on selected device"}
              </button>
              {activeRun?.status === "running" && (
                <div className="progress-wrap">
                  <div className="progress-label">
                    <span>Measured iterations</span>
                    <strong>
                      {activeRun.completed_iterations} /{" "}
                      {activeRun.request.measured_iterations}
                    </strong>
                  </div>
                  <div className="progress-track">
                    <div
                      style={{
                        width: `${(activeRun.completed_iterations / activeRun.request.measured_iterations) * 100}%`,
                      }}
                    />
                  </div>
                  <small>
                    Last sample {formatLatency(activeRun.last_latency_seconds)}
                  </small>
                </div>
              )}
            </form>
            <div className="results-column">
              <div className="metrics-grid">
                <Metric
                  label="Median latency"
                  value={formatLatency(latestResult?.latency_seconds?.median)}
                  accent="orange"
                />
                <Metric
                  label={
                    latestResult?.benchmark === "image"
                      ? "Image throughput"
                      : latestResult?.benchmark === "tree"
                        ? "Traversal throughput"
                        : "Median throughput"
                  }
                  value={metricValue}
                  accent="blue"
                />
                <Metric
                  label="Correctness"
                  value={
                    latestResult
                      ? latestResult.correctness_passed
                        ? "PASSED"
                        : "FAILED"
                      : "—"
                  }
                  accent="green"
                />
                <Metric
                  label="Memory state"
                  value={
                    latestResult
                      ? latestResult.device.memory.estimated
                        ? "ESTIMATED"
                        : "MEASURED"
                      : "—"
                  }
                  accent="purple"
                />
              </div>
              <div className="chart-card">
                <div className="card-heading">
                  <div>
                    <div className="section-kicker">Sample telemetry</div>
                    <h2>Per-iteration latency</h2>
                  </div>
                  {latestResult && (
                    <span className="chart-meta">
                      {latestResult.backend.toUpperCase()} /{" "}
                      {latestResult.benchmark}
                    </span>
                  )}
                </div>
                {samples.length ? (
                  <SampleChart samples={samples} />
                ) : (
                  <div className="empty-chart">
                    <span>⌁</span>
                    <p>Run a workload to stream real timing samples here.</p>
                  </div>
                )}
              </div>
            </div>
          </section>
          <section className="history-card">
            <div className="card-heading">
              <div>
                <div className="section-kicker">Experiment log</div>
                <h2>Recent runs</h2>
              </div>
              <span className="chart-meta">{runs.length} total</span>
            </div>
            {runs.length ? (
              <div className="run-table">
                <div className="table-head">
                  <span>Run</span>
                  <span>Backend</span>
                  <span>Workload</span>
                  <span>Status</span>
                  <span>Median</span>
                </div>
                {runs.slice(0, 6).map((run) => (
                  <button
                    className="table-row"
                    key={run.id}
                    onClick={() => setActiveRun(run)}
                  >
                    <span className="run-id">#{run.id}</span>
                    <span>{run.request.backend.toUpperCase()}</span>
                    <span>
                      {describeRun(run)} · {run.request.measured_iterations}{" "}
                      passes
                    </span>
                    <span className={`status ${run.status}`}>{run.status}</span>
                    <span>
                      {formatLatency(run.result?.latency_seconds?.median)}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-history">
                No experiments yet. Configure a workload to begin.
              </div>
            )}
          </section>
        </section>
      </main>
    </div>
  );
}

function Metric({ label, value, accent }) {
  return (
    <div className={`metric-card ${accent}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ScanNearbyButton({ onScan }) {
  const [scanning, setScanning] = useState(false);
  const scan = async () => {
    setScanning(true);
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      await onScan();
    } finally {
      setScanning(false);
    }
  };
  return (
    <button
      className={`scan-button floating-scan ${scanning ? "scanning" : ""}`}
      type="button"
      onClick={scan}
      disabled={scanning}
    >
      <span className="scan-icon">◌</span>
      {scanning ? "Scanning nearby..." : "Scan nearby"}
    </button>
  );
}

function SampleChart({ samples }) {
  const width = 760;
  const height = 230;
  const left = 58;
  const right = 18;
  const top = 18;
  const bottom = 35;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const median = [...samples].sort((a, b) => a - b)[
    Math.floor(samples.length / 2)
  ];
  const range = Math.max(max - min, max * 0.02, 1e-9);
  const y = (value) => top + (1 - (value - min) / range) * plotHeight;
  const x = (index) =>
    left +
    (samples.length === 1
      ? plotWidth / 2
      : (index * plotWidth) / (samples.length - 1));
  const points = samples
    .map((sample, index) => `${x(index)},${y(sample)}`)
    .join(" ");
  const gridValues = [max, min + range / 2, min];
  return (
    <div className="sample-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Per-iteration latency chart"
      >
        <defs>
          <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#d9ff72" stopOpacity=".18" />
            <stop offset="100%" stopColor="#d9ff72" stopOpacity="0" />
          </linearGradient>
        </defs>
        {gridValues.map((value, index) => (
          <g key={value}>
            <line
              x1={left}
              x2={width - right}
              y1={y(value)}
              y2={y(value)}
              className="chart-grid-line"
            />
            <text
              x={left - 10}
              y={y(value) + 4}
              textAnchor="end"
              className="chart-axis-label"
            >
              {formatLatency(value)}
            </text>
          </g>
        ))}
        <line
          x1={left}
          x2={width - right}
          y1={y(median)}
          y2={y(median)}
          className="median-line"
        />
        <text
          x={width - right}
          y={y(median) - 7}
          textAnchor="end"
          className="median-label"
        >
          median {formatLatency(median)}
        </text>
        <polygon
          points={`${left},${height - bottom} ${points} ${width - right},${height - bottom}`}
          fill="url(#chart-fill)"
        />
        <polyline points={points} className="latency-line" />
        {samples.map((sample, index) => (
          <g key={`${sample}-${index}`}>
            <circle
              cx={x(index)}
              cy={y(sample)}
              r="4.5"
              className="latency-point"
            >
              <title>{`Iteration ${index + 1}: ${formatLatency(sample)}`}</title>
            </circle>
            <text
              x={x(index)}
              y={height - 13}
              textAnchor="middle"
              className="chart-axis-label"
            >
              {index + 1}
            </text>
          </g>
        ))}
      </svg>
      <div className="chart-range">
        <span>min {formatLatency(min)}</span>
        <span>range zoomed to measured samples</span>
        <span>max {formatLatency(max)}</span>
      </div>
    </div>
  );
}

function FabricPage({
  localHost,
  devices,
  nodes,
  nearby,
  onDiscoveryRefresh,
  onConnected,
}) {
  const [workerUrl, setWorkerUrl] = useState("http://");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const connect = async (event) => {
    event.preventDefault();
    setConnecting(true);
    setConnectError("");
    try {
      const response = await fetch(`${API}/api/nodes/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worker_url: workerUrl }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.detail || "Could not connect worker");
      onConnected();
    } catch (error) {
      setConnectError(error.message);
    } finally {
      setConnecting(false);
    }
  };
  const connectNearby = async (node) => {
    setConnecting(true);
    setConnectError("");
    try {
      const response = await fetch(`${API}/api/discovery/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_id: node.node_id }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.detail || "Could not connect discovered worker");
      onConnected();
    } catch (error) {
      setConnectError(error.message);
    } finally {
      setConnecting(false);
    }
  };
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">RUNTIME TOPOLOGY</div>
          <h2>Device fabric</h2>
          <p>
            Every server starts as a host. Connected machines become workers for
            this session.
          </p>
        </div>
      </div>
      <section className="radar-card">
        <div className="card-heading">
          <div>
            <div className="section-kicker">LAN RADAR</div>
            <h2>Nearby runtime nodes</h2>
          </div>
          <div className="radar-heading-actions">
            <span className="chart-meta">{nearby.length} discovered</span>
            <ScanNearbyButton onScan={onDiscoveryRefresh} />
          </div>
        </div>
        {nearby.length ? (
          <div className="radar-grid">
            {nearby.map((node) => (
              <div className="radar-node" key={node.node_id}>
                <div className="node-top">
                  <span className="device-led" />
                  <strong>{node.name}</strong>
                  <span className="device-state">NEARBY</span>
                </div>
                <div className="device-name">
                  {node.source_ip} ·{" "}
                  {node.capabilities
                    .filter((device) => device.available)
                    .map((device) => device.backend.toUpperCase())
                    .join(" / ")}
                </div>
                <HostDetails host={node.host} devices={node.capabilities} />
                <button
                  className="connect-small"
                  type="button"
                  onClick={() => connectNearby(node)}
                  disabled={connecting}
                >
                  Connect
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-history">
            No runtime workers discovered on this LAN. Start a standalone worker
            and allow UDP discovery port 9471.
          </div>
        )}
      </section>
      <form className="connect-card" onSubmit={connect}>
        <div>
          <div className="section-kicker">Manual fallback</div>
          <h2>Connect by worker URL</h2>
          <p>Use this only when LAN discovery is blocked by the network.</p>
        </div>
        <div className="connect-fields">
          <label>
            Worker URL
            <input
              value={workerUrl}
              onChange={(event) => setWorkerUrl(event.target.value)}
              placeholder="http://192.168.1.25:9000"
            />
          </label>
        </div>
        {connectError && <div className="connect-error">{connectError}</div>}
        <button className="run-button" type="submit" disabled={connecting}>
          {connecting ? "Connecting..." : "Connect worker"}
        </button>
      </form>
      <div className="inventory-grid">
        <InventoryCard
          title="Host / local"
          role="HOST"
          host={localHost}
          devices={devices}
        />
      </div>
      {nodes.map((node) => (
        <InventoryCard
          key={node.node_id}
          title={node.name}
          role={node.role || "WORKER"}
          host={node.host}
          devices={node.capabilities}
          status={node.status}
        />
      ))}
    </div>
  );
}

function InventoryCard({ title, role, host, devices = [], status = "online" }) {
  const relevantDevices = visibleDevices(host, devices);
  const rename = async () => {
    const name = window.prompt("Name this device", title)?.trim();
    if (!name || role === "HOST") return;
    const nodes = await fetch(`${API}/api/nodes`).then((response) =>
      response.json(),
    );
    const node = nodes.find((item) => item.name === title);
    if (node) {
      await fetch(`${API}/api/nodes/${node.node_id}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      window.location.reload();
    }
  };
  return (
    <article className="inventory-card">
      <div className="inventory-head">
        <div>
          <span className="section-kicker">{role}</span>
          <h3>{title}</h3>
        </div>
        <span className={`status ${status}`}>{status}</span>
      </div>
      <HostDetails host={host} devices={relevantDevices} />
      <div className="inventory-backends">
        {relevantDevices.map((device) => (
          <span
            className={device.available ? "backend-chip ready" : "backend-chip"}
            key={device.backend}
          >
            {device.backend.toUpperCase()}{" "}
            {device.available ? "READY" : "OFFLINE"}
          </span>
        ))}
      </div>
      {role !== "HOST" && (
        <button className="rename-button" type="button" onClick={rename}>
          Rename device
        </button>
      )}
    </article>
  );
}

function ArchivePage({ runs }) {
  const completed = runs.filter((run) => run.result);
  const [runAId, setRunAId] = useState(completed[0]?.id || "");
  const [runBId, setRunBId] = useState(completed[1]?.id || "");
  useEffect(() => {
    if (!runAId && completed[0]) setRunAId(completed[0].id);
    if (!runBId && completed[1]) setRunBId(completed[1].id);
  }, [completed.length, runAId, runBId]);
  const runA = completed.find((run) => run.id === runAId);
  const runB = completed.find((run) => run.id === runBId);
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MEASURED HISTORY</div>
          <h2>Result archive</h2>
          <p>
            Compare completed workloads without mixing hardware or inventing
            missing values.
          </p>
        </div>
        <div className="summary-card">
          <span>COMPLETED RUNS</span>
          <strong>{completed.length}</strong>
          <small>stored in coordinator memory</small>
        </div>
      </div>
      <div className="archive-summary">
        <Metric label="Runs recorded" value={runs.length} accent="blue" />
        <Metric
          label="Correctness passes"
          value={
            completed.filter((run) => run.result.correctness_passed).length
          }
          accent="green"
        />
        <Metric
          label="Backends tested"
          value={new Set(completed.map((run) => run.result.backend)).size}
          accent="purple"
        />
      </div>
      <section className="compare-card">
        <div className="card-heading">
          <div>
            <div className="section-kicker">Experiment comparison</div>
            <h2>Compare two runs</h2>
          </div>
          <span className="chart-meta">Measured data only</span>
        </div>
        <div className="compare-selects">
          <label>
            Run A
            <select
              value={runAId}
              onChange={(event) => setRunAId(event.target.value)}
            >
              <option value="">Select a run</option>
              {completed.map((run) => (
                <option value={run.id} key={run.id}>
                  #{run.id} · {run.result.benchmark} · {run.result.backend}
                </option>
              ))}
            </select>
          </label>
          <label>
            Run B
            <select
              value={runBId}
              onChange={(event) => setRunBId(event.target.value)}
            >
              <option value="">Select a run</option>
              {completed.map((run) => (
                <option value={run.id} key={run.id}>
                  #{run.id} · {run.result.benchmark} · {run.result.backend}
                </option>
              ))}
            </select>
          </label>
        </div>
        {runA && runB ? (
          <ComparisonGrid runA={runA} runB={runB} />
        ) : (
          <div className="empty-history">
            Select two completed runs to compare their measured results.
          </div>
        )}
      </section>
      <section className="history-card">
        <div className="run-table">
          <div className="table-head">
            <span>Run</span>
            <span>Node / backend</span>
            <span>Workload</span>
            <span>Median latency</span>
            <span>Throughput</span>
          </div>
          {completed.length ? (
            completed.map((run) => (
              <div className="table-row archive-row" key={run.id}>
                <span className="run-id">#{run.id}</span>
                <span>
                  {run.node_id} / {run.result.backend}
                </span>
                <span>
                  {run.result.benchmark} · {run.result.size} ·{" "}
                  {run.result.dtype}
                </span>
                <span>{formatLatency(run.result.latency_seconds.median)}</span>
                <span>{archiveThroughput(run.result)}</span>
              </div>
            ))
          ) : (
            <div className="empty-history">No completed runs yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function ComparisonGrid({ runA, runB }) {
  const latencyA = runA.result.latency_seconds.median;
  const latencyB = runB.result.latency_seconds.median;
  const delta = ((latencyB - latencyA) / latencyA) * 100;
  return (
    <div className="comparison-grid">
      <ComparisonCell
        label="Workload"
        a={`${runA.result.benchmark} / ${runA.result.size}`}
        b={`${runB.result.benchmark} / ${runB.result.size}`}
      />
      <ComparisonCell
        label="Node / backend"
        a={`${runA.node_id} / ${runA.result.backend}`}
        b={`${runB.node_id} / ${runB.result.backend}`}
      />
      <ComparisonCell
        label="Median latency"
        a={formatLatency(latencyA)}
        b={formatLatency(latencyB)}
        delta={`${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`}
      />
      <ComparisonCell
        label="Throughput"
        a={archiveThroughput(runA.result)}
        b={archiveThroughput(runB.result)}
      />
    </div>
  );
}

function ComparisonCell({ label, a, b, delta }) {
  return (
    <div className="comparison-cell">
      <span>{label}</span>
      <div>
        <strong>{a}</strong>
        <b>Run A</b>
      </div>
      <div>
        <strong>{b}</strong>
        <b>Run B</b>
      </div>
      {delta && <small>{delta} latency change</small>}
    </div>
  );
}

function archiveThroughput(result) {
  if (result.benchmark === "image")
    return `${result.metrics?.median_images_per_second?.toFixed(1) || "—"} img/s`;
  if (result.benchmark === "tree")
    return `${result.metrics?.median_traversals_per_second?.toFixed(0) || "—"} trav/s`;
  return `${result.throughput_tflops?.median?.toFixed(3) || "—"} TFLOP/s`;
}

function describeRun(run) {
  const result = run.result;
  const request = run.request;
  if (result?.benchmark === "image" || request.workload === "image")
    return `Image CNN · batch ${result?.workload_config?.batch_size || request.batch_size} · ${result?.workload_config?.image_size || request.image_size}px`;
  if (result?.benchmark === "tree" || request.workload === "tree")
    return `Tree · depth ${result?.workload_config?.depth || request.depth} · ${result?.workload_config?.traversal_count || request.traversal_count} traversals`;
  return `Matmul · N=${result?.workload_config?.size || request.size}`;
}

function HostDetails({ host, devices = [] }) {
  if (!host)
    return <div className="host-details">Hardware inventory unavailable</div>;
  const gpu = devices.find(
    (device) => ["cuda", "mps"].includes(device.backend) && device.available,
  );
  const cpu =
    host.architecture?.processor || host.architecture?.machine || "Unavailable";
  return (
    <div className="host-details">
      <span>
        <b>OS</b> {host.os?.name || "Unavailable"} {host.os?.release || ""}
      </span>
      <span>
        <b>CPU</b> {cpu} · {host.cpu?.physical_cores ?? "?"}C/
        {host.cpu?.logical_cores ?? "?"}T
      </span>
      <span>
        <b>GPU</b> {gpu?.device_name || "Unavailable"}
      </span>
      <span>
        <b>Memory</b> {formatBytes(host.memory?.total_bytes)}
      </span>
    </div>
  );
}

function visibleDevices(host, devices) {
  if (host?.os?.name === "Darwin")
    return devices.filter((device) => device.backend !== "cuda");
  if (host?.os?.name === "Windows")
    return devices.filter((device) => device.backend !== "mps");
  return devices;
}

createRoot(document.getElementById("root")).render(<App />);

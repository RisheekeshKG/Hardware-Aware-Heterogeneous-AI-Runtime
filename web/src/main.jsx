import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const API = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'

const formatBytes = (bytes) => {
  if (bytes == null) return 'Unavailable'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

const formatLatency = (seconds) => {
  if (seconds == null) return '—'
  if (seconds < 0.001) return `${(seconds * 1e6).toFixed(1)} µs`
  return `${(seconds * 1e3).toFixed(2)} ms`
}

function App() {
  const [devices, setDevices] = useState([])
  const [runs, setRuns] = useState([])
  const [activeRun, setActiveRun] = useState(null)
  const [form, setForm] = useState({ size: 1024, backend: 'cpu', warmup_iterations: 3, measured_iterations: 10, seed: 42 })
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([fetch(`${API}/api/devices`), fetch(`${API}/api/runs`)]).then(async ([deviceResponse, runResponse]) => {
      if (!deviceResponse.ok || !runResponse.ok) throw new Error('Runtime API is not reachable')
      setDevices(await deviceResponse.json())
      setRuns(await runResponse.json())
    }).catch((err) => setError(err.message))
  }, [])

  const launchRun = async (event) => {
    event.preventDefault()
    setError('')
    setActiveRun(null)
    try {
      const response = await fetch(`${API}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, size: Number(form.size), warmup_iterations: Number(form.warmup_iterations), measured_iterations: Number(form.measured_iterations), seed: Number(form.seed) }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Could not start benchmark')
      setActiveRun(data)
      setRuns((current) => [data, ...current])
      const protocol = API.startsWith('https') ? 'wss' : 'ws'
      const socket = new WebSocket(`${protocol}://${new URL(API).host}/api/runs/${data.id}/events`)
      socket.onmessage = (message) => {
        const eventData = JSON.parse(message.data)
        setActiveRun((current) => ({ ...current, status: eventData.type === 'completed' ? 'completed' : eventData.type === 'failed' ? 'failed' : 'running', completed_iterations: eventData.completed_iterations || current?.completed_iterations || 0, last_latency_seconds: eventData.latency_seconds || current?.last_latency_seconds, result: eventData.result || current?.result, error: eventData.error || current?.error }))
        if (eventData.type === 'completed' || eventData.type === 'failed') {
          fetch(`${API}/api/runs/${data.id}`).then((res) => res.json()).then((finalRun) => { setActiveRun(finalRun); setRuns((current) => current.map((run) => run.id === finalRun.id ? finalRun : run)) })
          socket.close()
        }
      }
      socket.onerror = () => setError('Live event connection failed; the benchmark may still be running.')
    } catch (err) {
      setError(err.message)
    }
  }

  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const availableDevices = devices.filter((device) => device.available)
  const completedRuns = runs.filter((run) => run.status === 'completed' && run.result)
  const latestResult = activeRun?.result || completedRuns[0]?.result
  const samples = latestResult?.samples_seconds || []
  const maxSample = Math.max(...samples, 0.000001)

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">H</span><div><strong>HAR</strong><span>runtime control</span></div></div>
      <div className="nav-label">Workspace</div>
      <div className="nav-item active"><span>◈</span> Benchmark lab</div>
      <div className="nav-item"><span>⌁</span> Device fabric</div>
      <div className="nav-item"><span>↗</span> Result archive</div>
      <div className="sidebar-foot"><span className="pulse-dot" /> API {error ? 'attention' : 'connected'}<small>{API.replace('http://', '')}</small></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><div className="eyebrow">HARDWARE-AWARE AI RUNTIME / MILESTONE 2</div><h1>Benchmark lab</h1><p>Shape a workload. Measure the machine. Keep every number honest.</p></div><div className="connection"><span className="pulse-dot" /> LIVE API</div></header>
      {error && <div className="error-banner">{error}</div>}
      <section className="device-strip"><div className="section-kicker">Detected fabric <span>· {devices.filter((device) => device.available).length} available</span></div><div className="device-grid">{devices.map((device) => <div className={`device-card ${device.available ? 'available' : 'offline'}`} key={device.backend}><div className="device-top"><span className={`device-led ${device.available ? '' : 'muted'}`} /><strong>{device.backend.toUpperCase()}</strong><span className="device-state">{device.available ? 'READY' : 'OFFLINE'}</span></div><div className="device-name">{device.device_name}</div><div className="device-memory">{formatBytes(device.memory?.available_bytes)} <span>{device.memory?.estimated ? 'estimated free' : 'available'}</span></div></div>)}</div></section>
      <section className="workspace-grid">
        <form className="control-panel" onSubmit={launchRun}><div className="panel-heading"><div><div className="section-kicker">Workload definition</div><h2>Matrix multiplication</h2></div><span className="tag">REAL EXECUTION</span></div><p className="panel-copy">The workload is adjustable. The result is always sourced from the selected device.</p>
          <label>Execution backend<select value={form.backend} onChange={update('backend')}>{availableDevices.map((device) => <option value={device.backend} key={device.backend}>{device.backend.toUpperCase()} · {device.device_name}</option>)}</select></label>
          <div className="field-row"><label>Matrix dimension<input type="number" min="1" max="16384" value={form.size} onChange={update('size')} /><span className="field-hint">N × N · float32</span></label><label>Seed<input type="number" value={form.seed} onChange={update('seed')} /></label></div>
          <div className="field-row"><label>Warm-up passes<input type="number" min="0" max="1000" value={form.warmup_iterations} onChange={update('warmup_iterations')} /></label><label>Measured passes<input type="number" min="1" max="1000" value={form.measured_iterations} onChange={update('measured_iterations')} /></label></div>
          <button className="run-button" type="submit" disabled={activeRun?.status === 'running'}><span>{activeRun?.status === 'running' ? '◌' : '▶'}</span>{activeRun?.status === 'running' ? 'Benchmark running' : 'Run on selected device'}</button>
          {activeRun?.status === 'running' && <div className="progress-wrap"><div className="progress-label"><span>Measured iterations</span><strong>{activeRun.completed_iterations} / {activeRun.request.measured_iterations}</strong></div><div className="progress-track"><div style={{ width: `${(activeRun.completed_iterations / activeRun.request.measured_iterations) * 100}%` }} /></div><small>Last sample {formatLatency(activeRun.last_latency_seconds)}</small></div>}
        </form>
        <div className="results-column"><div className="metrics-grid"><Metric label="Median latency" value={formatLatency(latestResult?.latency_seconds?.median)} accent="orange" /><Metric label="Median throughput" value={latestResult ? `${latestResult.throughput_tflops.median.toFixed(3)} TFLOP/s` : '—'} accent="blue" /><Metric label="Correctness" value={latestResult ? (latestResult.correctness_passed ? 'PASSED' : 'FAILED') : '—'} accent="green" /><Metric label="Memory state" value={latestResult ? (latestResult.device.memory.estimated ? 'ESTIMATED' : 'MEASURED') : '—'} accent="purple" /></div>
          <div className="chart-card"><div className="card-heading"><div><div className="section-kicker">Sample telemetry</div><h2>Per-iteration latency</h2></div>{latestResult && <span className="chart-meta">{latestResult.backend.toUpperCase()} / N={latestResult.size}</span>}</div>{samples.length ? <div className="bar-chart">{samples.map((sample, index) => <div className="bar-column" key={`${sample}-${index}`}><div className="bar-value">{formatLatency(sample)}</div><div className="bar" style={{ height: `${Math.max((sample / maxSample) * 150, 12)}px` }} /><span>{index + 1}</span></div>)}</div> : <div className="empty-chart"><span>⌁</span><p>Run a workload to stream real timing samples here.</p></div>}</div>
        </div>
      </section>
      <section className="history-card"><div className="card-heading"><div><div className="section-kicker">Experiment log</div><h2>Recent runs</h2></div><span className="chart-meta">{runs.length} total</span></div>{runs.length ? <div className="run-table"><div className="table-head"><span>Run</span><span>Backend</span><span>Workload</span><span>Status</span><span>Median</span></div>{runs.slice(0, 6).map((run) => <button className="table-row" key={run.id} onClick={() => setActiveRun(run)}><span className="run-id">#{run.id}</span><span>{run.request.backend.toUpperCase()}</span><span>N={run.request.size} · {run.request.measured_iterations} passes</span><span className={`status ${run.status}`}>{run.status}</span><span>{formatLatency(run.result?.latency_seconds?.median)}</span></button>)}</div> : <div className="empty-history">No experiments yet. Configure a workload to begin.</div>}</section>
    </main>
  </div>
}

function Metric({ label, value, accent }) { return <div className={`metric-card ${accent}`}><span>{label}</span><strong>{value}</strong></div> }

createRoot(document.getElementById('root')).render(<App />)

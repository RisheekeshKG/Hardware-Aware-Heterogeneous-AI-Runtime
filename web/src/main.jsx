import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import './styles.css'

const API = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'
// The desktop app launches the runtime itself; give it time to boot before reporting a failure.
const RUNTIME_STARTUP_GRACE_MS = 20000
const navItems = [
  { id: 'runtime', label: 'Overview', icon: 'O' },
  { id: 'workloads', label: 'Tasks', icon: 'T' },
  { id: 'fabric', label: 'Devices', icon: 'D' },
  { id: 'traces', label: 'Activity', icon: 'A' },
  { id: 'benchmarks', label: 'Performance', icon: 'P' },
]

const formatBytes = (bytes) => {
  if (bytes == null) return 'Unavailable'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1 }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}

const formatDuration = (seconds) => {
  if (seconds == null) return 'Unavailable'
  if (seconds < 0.001) return `${(seconds * 1e6).toFixed(1)} us`
  return `${(seconds * 1e3).toFixed(2)} ms`
}

const formatDate = (value) => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unavailable'

function App() {
  const [runtimeSetup, setRuntimeSetup] = useState({ checking: true, installed: true, target: '', asset: '', error: '' })
  const [view, setView] = useState('runtime')
  const [runtime, setRuntime] = useState({ devices: [], nodes: [], runs: [] })
  const [scripts, setScripts] = useState([])
  const [selectedRunId, setSelectedRunId] = useState(null)
  const [trace, setTrace] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showLauncher, setShowLauncher] = useState(false)
  const [showScriptLauncher, setShowScriptLauncher] = useState(false)
  const [showConnect, setShowConnect] = useState(false)
  const [toast, setToast] = useState('')
  const [pairing, setPairing] = useState([])
  const connectedOnce = useRef(false)
  const startedAt = useRef(Date.now())

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) {
      setRuntimeSetup((current) => ({ ...current, checking: false }))
      return undefined
    }
    invoke('runtime_status')
      .then((status) => setRuntimeSetup({ ...status, checking: false, error: '' }))
      .catch((setupError) => setRuntimeSetup((current) => ({ ...current, checking: false, error: setupError.toString() })))
    return undefined
  }, [])

  const loadRuntime = async () => {
    try {
      const [runtimeResponse, scriptsResponse] = await Promise.all([fetch(`${API}/api/runtime`), fetch(`${API}/api/scripts`)] )
      if (!runtimeResponse.ok || !scriptsResponse.ok) throw new Error('Runtime API returned an error')
      const data = await runtimeResponse.json()
      setScripts(await scriptsResponse.json())
      fetch(`${API}/api/pairing`).then((response) => response.ok ? response.json() : []).then(setPairing).catch(() => setPairing([]))
      setRuntime(data)
      setError('')
      connectedOnce.current = true
      setSelectedRunId((current) => current || data.runs[0]?.id || null)
      setLoading(false)
    } catch (requestError) {
      const stillStarting = window.__TAURI_INTERNALS__ && !connectedOnce.current && Date.now() - startedAt.current < RUNTIME_STARTUP_GRACE_MS
      if (stillStarting) return
      setError(`${requestError.message}. Start the API with "har serve".`)
      setLoading(false)
    }
  }

  useEffect(() => {
    if (runtimeSetup.checking || !runtimeSetup.installed) return undefined
    loadRuntime()
    const refresh = window.setInterval(loadRuntime, 3000)
    return () => window.clearInterval(refresh)
  }, [runtimeSetup.checking, runtimeSetup.installed])

  useEffect(() => {
    if (!selectedRunId) { setTrace(null); return undefined }
    let cancelled = false
    fetch(`${API}/api/runs/${selectedRunId}/trace`)
      .then((response) => response.ok ? response.json() : null)
      .then((data) => { if (!cancelled) setTrace(data) })
      .catch(() => { if (!cancelled) setTrace(null) })
    return () => { cancelled = true }
  }, [selectedRunId, runtime.runs])

  const notify = (message) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2800)
  }

  const launchRun = async (request) => {
    const response = await fetch(`${API}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.detail || 'Could not start workload')
    setSelectedRunId(data.id)
    setShowLauncher(false)
    setView('runtime')
    notify(`Workload ${data.id} queued on ${request.backend.toUpperCase()}.`)
    await loadRuntime()
  }

  const launchScript = async (request) => {
    const response = await fetch(`${API}/api/scripts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.detail || 'Could not start Python file')
    setShowScriptLauncher(false)
    notify(`${data.filename} was sent to the task queue.`)
    await loadRuntime()
  }

  const selectedRun = runtime.runs.find((run) => run.id === selectedRunId) || runtime.runs[0] || null
  const activeRun = runtime.runs.find((run) => ['running', 'queued'].includes(run.status)) || selectedRun
  const pageLabel = navItems.find((item) => item.id === view)?.label || 'Runtime'

  if (runtimeSetup.checking || !runtimeSetup.installed) {
    return <RuntimeSetup status={runtimeSetup} onInstalled={(status) => { startedAt.current = Date.now(); setRuntimeSetup({ ...status, checking: false, error: '' }) }} />
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">H</div><div><strong>HAR</strong><span>runtime console</span></div></div>
      <div className="nav-group-label">Workspace</div>
      <nav className="main-nav" aria-label="Main navigation">{navItems.map((item) => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => setView(item.id)}><span className="nav-icon">{item.icon}</span><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-note"><span className="eyebrow">HAR STATUS</span><strong>{error ? 'Needs attention' : 'Ready to help'}</strong><span>{loading ? 'Checking your devices...' : 'Connected to this computer'}</span></div>
      <div className="connection-status"><span className={`status-dot ${error ? 'error' : ''}`} /><span>{error ? 'NOT CONNECTED' : 'CONNECTED'}</span><small>{loading ? 'Checking devices...' : `${runtime.devices.filter((device) => device.available).length} devices ready`}</small></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="breadcrumbs"><span>HAR</span><i>/</i><strong>{pageLabel}</strong></div><div className="topbar-actions"><span className="live-pill"><span className={`status-dot ${error ? 'error' : ''}`} /> {error ? 'Disconnected' : 'Live API'}</span><button className="icon-button" onClick={loadRuntime} aria-label="Refresh runtime">R</button></div></header>
      {runtimeSetup.update_available && <RuntimeUpdate status={runtimeSetup} onUpdated={(status) => { startedAt.current = Date.now(); connectedOnce.current = false; setRuntimeSetup({ ...status, checking: false, error: '' }); notify('Runtime updated.') }} />}
      {error && <div className="api-error"><span className="status-dot error" /><div><strong>HAR cannot connect right now</strong><span>Make sure the HAR service is running, then try again.</span></div><button onClick={loadRuntime}>Try again</button></div>}
      {view === 'runtime' && <RuntimeView devices={runtime.devices} nodes={runtime.nodes} runs={runtime.runs} activeRun={activeRun} onLaunch={() => setShowLauncher(true)} onNavigate={setView} onSelectRun={setSelectedRunId} />}
      {view === 'workloads' && <WorkloadsView runs={runtime.runs} scripts={scripts} onLaunch={() => setShowLauncher(true)} onScriptLaunch={() => setShowScriptLauncher(true)} onNavigate={setView} onSelectRun={setSelectedRunId} />}
      {view === 'fabric' && <FabricView devices={runtime.devices} nodes={runtime.nodes} onConnect={() => setShowConnect(true)} />}
      {view === 'traces' && <TracesView run={selectedRun} trace={trace} runs={runtime.runs} onSelectRun={setSelectedRunId} />}
      {view === 'benchmarks' && <BenchmarksView runs={runtime.runs} onNavigate={setView} onSelectRun={setSelectedRunId} />}
    </main>
    {showLauncher && <Launcher devices={runtime.devices} nodes={runtime.nodes} onClose={() => setShowLauncher(false)} onSubmit={launchRun} />}
    {showScriptLauncher && <ScriptLauncher nodes={runtime.nodes} onClose={() => setShowScriptLauncher(false)} onSubmit={launchScript} />}
    {showConnect && <ConnectDevice onClose={() => setShowConnect(false)} onConnected={async () => { setShowConnect(false); notify('Device connection requested.'); await loadRuntime() }} />}
    {pairing[0] && <PairingPrompt request={pairing[0]} onDecided={(decision) => { setPairing((current) => current.slice(1)); notify(decision === 'accept' ? 'Connection accepted. This computer will now take tasks from that host.' : 'Connection declined.'); loadRuntime() }} />}
    {toast && <div className="toast"><span className="status-dot" />{toast}</div>}
  </div>
}

function PairingPrompt({ request, onDecided }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const decide = async (decision) => {
    setBusy(true); setError('')
    try {
      const response = await fetch(`${API}/api/pairing/${request.id}/${decision}`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Could not answer the request')
      onDecided(decision)
    } catch (decideError) { setError(decideError.message); setBusy(false) }
  }
  const host = (() => { try { return new URL(request.coordinator).hostname } catch { return request.client_ip } })()
  return <div className="modal-backdrop"><div className="launcher-modal pairing-modal" role="alertdialog" aria-labelledby="pairing-title"><div className="modal-header"><div><div className="eyebrow">CONNECTION REQUEST</div><h2 id="pairing-title">Allow another computer to use this one?</h2></div></div><p>The HAR host at <strong>{host}</strong> wants to send tasks to this computer. Accepting lets it run Python files and benchmarks here. Only accept computers you trust.</p><div className="setup-detail"><span>Request from</span><strong>{request.client_ip}</strong></div>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => decide('decline')} disabled={busy}>Decline</button><button type="button" className="primary-button" onClick={() => decide('accept')} disabled={busy}>Accept <span>-&gt;</span></button></div></div></div>
}

function RuntimeUpdate({ status, onUpdated }) {
  const [updating, setUpdating] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const unlisten = listen('runtime-install-progress', (event) => setProgress(event.payload))
    return () => { unlisten.then((stop) => stop()) }
  }, [])
  const update = async () => {
    setUpdating(true); setError('')
    try {
      const updated = await invoke('install_runtime')
      await invoke('start_runtime')
      onUpdated(updated)
    } catch (updateError) {
      setError(updateError.toString())
      invoke('start_runtime').catch(() => {})
    } finally { setUpdating(false) }
  }
  const percent = progress?.total ? Math.round((progress.downloaded / progress.total) * 100) : null
  const label = !updating ? 'Update runtime' : progress?.stage === 'extracting' ? 'Unpacking...' : percent != null ? `Downloading ${percent}%` : 'Downloading...'
  return <div className="api-error runtime-update"><span className="status-dot" /><div><strong>Runtime update available</strong><span>{error || `This app needs runtime ${status.expected_version}; ${status.installed_version || 'an older version'} is installed. Tasks pause briefly while it restarts.`}</span></div><button onClick={update} disabled={updating}>{label}</button></div>
}

function RuntimeSetup({ status, onInstalled }) {
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(status.error || '')
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined
    const unlisten = listen('runtime-install-progress', (event) => setProgress(event.payload))
    return () => { unlisten.then((stop) => stop()) }
  }, [])
  const install = async () => {
    setInstalling(true)
    setProgress(null)
    setError('')
    try {
      const installed = await invoke('install_runtime')
      await invoke('start_runtime')
      onInstalled(installed)
    } catch (installError) {
      setError(installError.toString())
    } finally {
      setInstalling(false)
    }
  }
  const percent = progress?.total ? Math.min(100, (progress.downloaded / progress.total) * 100) : null
  const progressLabel = progress?.stage === 'extracting'
    ? 'Unpacking runtime...'
    : progress ? `${formatBytes(progress.downloaded)}${progress.total ? ` of ${formatBytes(progress.total)}` : ''}` : 'Contacting GitHub...'
  return <div className="runtime-setup"><div className="runtime-setup-card"><div className="brand"><div className="brand-mark">H</div><div><strong>HAR</strong><span>runtime console</span></div></div><div className="eyebrow">ONE-TIME SETUP</div><h1>Prepare this computer</h1><p>HAR will download the compute runtime matched to this computer. The desktop app stays small, and the runtime is reused after setup.</p><div className="setup-detail"><span>Detected target</span><strong>{status.target || 'This computer'}</strong></div><div className="setup-detail"><span>Download</span><strong>{progress?.asset || status.asset || 'Hardware-matched runtime'}</strong></div>{installing && <div className="setup-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent == null ? undefined : Math.round(percent)}><div className="setup-progress-track"><div className={`setup-progress-fill ${percent == null ? 'indeterminate' : ''}`} style={percent == null ? undefined : { width: `${percent}%` }} /></div><div className="setup-progress-meta"><span>{progressLabel}</span>{percent != null && progress?.stage !== 'extracting' && <strong>{percent.toFixed(0)}%</strong>}</div></div>}{error && <div className="form-error">{error}</div>}<button className="primary-button setup-button" onClick={install} disabled={installing}>{installing ? 'Installing runtime...' : error ? 'Try again' : 'Download runtime'}<span>-&gt;</span></button><small className="setup-footnote">{status.target === 'windows-x64-cuda' ? 'The NVIDIA CUDA runtime is a large download (about 2.5 GB). HAR falls back to the CPU runtime if it is unavailable.' : 'Download size depends on the detected hardware.'}</small></div></div>
}

function PageHeader({ eyebrow, title, description, action }) { return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div> }

function RuntimeView({ devices, nodes, runs, activeRun, onLaunch, onNavigate, onSelectRun }) {
  const availableDevices = devices.filter((device) => device.available)
  const onlineNodes = nodes.filter((node) => node.status === 'online' && node.name !== 'This device')
  const runningCount = runs.filter((run) => run.status === 'running').length
  const queuedCount = runs.filter((run) => run.status === 'queued').length
  return <>
    <PageHeader eyebrow="HAR" title="Overview" description="See what is running and which devices are available to help." action={<button className="primary-button" onClick={onLaunch}><span>+</span> Start a task</button>} />
    <section className="stat-grid"><StatCard label="Tasks in progress" value={String(runningCount + queuedCount).padStart(2, '0')} detail={`${runningCount} running · ${queuedCount} waiting`} accent="lime" /><StatCard label="Devices ready" value={String(availableDevices.length + onlineNodes.length).padStart(2, '0')} detail={`${availableDevices.length} on this computer · ${onlineNodes.length} elsewhere`} accent="blue" /><StatCard label="System status" value={devices.length ? 'Ready' : 'Waiting'} detail={devices.length ? 'Everything is responding' : 'Looking for devices'} accent="green" /><StatCard label="Finished tasks" value={String(runs.filter((run) => run.status === 'completed').length).padStart(2, '0')} detail="Completed successfully" accent="amber" /></section>
    <section className="runtime-grid"><ActiveWorkload run={activeRun} onTrace={() => { if (activeRun) { onSelectRun(activeRun.id); onNavigate('traces') } }} /><FabricSummary devices={devices} nodes={nodes} onOpen={() => onNavigate('fabric')} /></section>
    <section className="section-block"><div className="section-heading"><div><div className="eyebrow">RECENT ACTIVITY</div><h2>Recent tasks</h2></div><button className="text-button" onClick={() => onNavigate('workloads')}>View all <span>-&gt;</span></button></div>{runs.length ? <div className="workload-list">{runs.slice(0, 8).map((run) => <WorkloadRow key={run.id} run={run} onClick={() => { onSelectRun(run.id); onNavigate('traces') }} />)}</div> : <EmptyState title="No tasks yet" detail="Start a task to see its progress here." action="Start a task" onAction={onLaunch} />}</section>
  </>
}

function ActiveWorkload({ run, onTrace }) {
  if (!run) return <article className="panel active-workload-panel"><div className="eyebrow">CURRENT TASK</div><h2>Nothing is running</h2><p className="empty-copy">HAR is ready. Start a task to see its progress here.</p><button className="secondary-button" onClick={onTrace}>No activity yet</button></article>
  const total = run.request.measured_iterations || 1
  const progress = Math.round((run.completed_iterations / total) * 100)
  return <article className="panel active-workload-panel"><div className="panel-top"><div><div className="eyebrow">CURRENT TASK</div><h2>Matrix calculation</h2></div><StatusBadge status={run.status} /></div><div className="workload-meta"><span>{run.request.size} x {run.request.size} calculation</span><span>{run.request.measured_iterations} checks</span><span>{formatDate(run.created_at)}</span></div><div className="execution-line"><div className="execution-line-head"><span>Progress</span><strong>{run.last_latency_seconds ? formatDuration(run.last_latency_seconds) : 'Waiting'}</strong></div><div className="progress-track"><div style={{ width: `${progress}%` }} /></div><div className="execution-line-foot"><span>{run.completed_iterations} / {total} checks</span><span>{run.status}</span></div></div><div className="placement-grid"><Placement label="Choice" value={friendlyBackend(run.request.backend)} accent={run.request.backend} /><Placement label="Device" value={run.node_id === 'local' ? 'This computer' : run.node_id} /><Placement label="Result" value={run.result ? (run.result.correctness_passed ? 'Good' : 'Check failed') : 'Pending'} /></div><button className="secondary-button" onClick={onTrace}>See task details <span>-&gt;</span></button></article>
}

function FabricSummary({ devices, nodes, onOpen }) { const visibleNodes = nodes.filter((node) => node.name !== 'This device'); return <article className="panel fabric-summary"><div className="section-heading compact"><div><div className="eyebrow">YOUR DEVICES</div><h2>Device status</h2></div><span className="online-count"><span className="status-dot" /> {devices.filter((device) => device.available).length + visibleNodes.filter((node) => node.status === 'online').length} ready</span></div><div className="mini-devices">{devices.filter((device) => device.available).slice(0, 3).map((device) => <DeviceSummary key={device.backend} device={device} />)}{!devices.some((device) => device.available) && <div className="empty-copy">No devices are ready yet.</div>}</div><button className="secondary-button" onClick={onOpen}>See all devices <span>-&gt;</span></button></article> }
function DeviceSummary({ device }) { const memory = device.memory; return <div className="mini-device"><div className="mini-device-top"><BackendBadge backend={device.backend} /><span className="device-state online">online</span></div><strong>{device.device_name}</strong><div className="util-row"><span>{memory.measured ? 'Measured memory' : memory.estimated ? 'Estimated memory' : 'Memory unavailable'}</span><span>{formatBytes(memory.available_bytes)} free</span></div><div className="util-track"><div className={`backend-fill ${device.backend}`} style={{ width: memory.total_bytes && memory.available_bytes != null ? `${Math.min((memory.available_bytes / memory.total_bytes) * 100, 100)}%` : '0%' }} /></div></div> }

function WorkloadsView({ runs, scripts, onLaunch, onScriptLaunch, onNavigate, onSelectRun }) { return <><PageHeader eyebrow="TASKS" title="Tasks" description="Start a built-in calculation or run your own Python file." action={<div className="header-actions"><button className="secondary-button" onClick={onScriptLaunch}>Run Python file</button><button className="primary-button" onClick={onLaunch}><span>+</span> Start a task</button></div>} /><div className="workloads-layout"><section className="panel launch-card"><div className="eyebrow">GET STARTED</div><h2>Start a task</h2><p>Use a built-in calculation or send an approved Python file to a connected device.</p><button className="large-launch" onClick={onScriptLaunch}><span className="launch-icon">-&gt;</span><span><strong>Run a Python file</strong><small>Choose a file, device, and optional arguments</small></span><span className="arrow">+</span></button><div className="policy-note"><span className="status-dot" /><span>Files run in a temporary managed job folder.</span></div></section><section className="panel policy-card"><div className="eyebrow">BUILT-IN TASK</div><h2>Matrix calculation</h2><div className="policy-option selected"><span className="radio-dot" /><div><strong>Calculate and compare</strong><span>Run a verified calculation on an available device.</span></div><em>READY</em></div><div className="policy-note"><span className="status-dot preview" /><span>Python files run with the device's installed Python environment.</span></div></section></div><section className="section-block"><div className="section-heading"><div><div className="eyebrow">TASK HISTORY</div><h2>All tasks</h2></div><button className="text-button" onClick={() => onNavigate('traces')}>See activity <span>-&gt;</span></button></div>{runs.length || scripts.length ? <div className="workload-list">{runs.map((run) => <WorkloadRow key={run.id} run={run} onClick={() => { onSelectRun(run.id); onNavigate('traces') }} detailed />)}{scripts.map((script) => <ScriptRow key={script.id} script={script} />)}</div> : <EmptyState title="No tasks yet" detail="Your completed and in-progress tasks will appear here." action="Start a task" onAction={onLaunch} />}</section></> }

const roleOptions = [
  { id: 'host', label: 'Host', detail: 'Send tasks to this computer and to devices you add.' },
  { id: 'worker', label: 'Worker', detail: 'Let another computer running HAR send tasks here.' },
  { id: 'standalone', label: 'Standalone', detail: 'Use only this computer. Not reachable from the network.' },
]

function RolePanel() {
  const [role, setRole] = useState(null)
  const [hostUrl, setHostUrl] = useState('')
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return
    invoke('runtime_role').then(setRole).catch(() => {})
  }, [])
  useEffect(() => {
    if (!role) return
    fetch(`${API}/api/session`).then((response) => response.ok ? response.json() : {}).then((data) => setHostUrl(data.host_url || '')).catch(() => {})
  }, [role])
  if (!window.__TAURI_INTERNALS__ || !role) return null
  const change = async (next) => {
    if (next === role) return
    setSwitching(true); setError('')
    try { setRole(await invoke('set_runtime_role', { role: next })) } catch (roleError) { setError(roleError.toString()) } finally { setSwitching(false) }
  }
  // The worker service listens on port 9000 on the same LAN address the host API advertises.
  const workerAddress = hostUrl ? hostUrl.replace(/:\d+$/, ':9000') : ''
  const lanAddress = hostUrl ? hostUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, '') : ''
  return <section className="role-panel panel"><div className="role-panel-head"><div><span className="eyebrow">THIS COMPUTER'S ROLE</span><p>{roleOptions.find((option) => option.id === role)?.detail}</p>{lanAddress && <p className="role-ip">This PC's address: <code>{lanAddress}</code> <button className="link-button" onClick={() => navigator.clipboard?.writeText(lanAddress)}>Copy</button></p>}</div><div className="role-options" role="radiogroup" aria-label="Runtime role">{roleOptions.map((option) => <button key={option.id} role="radio" aria-checked={role === option.id} className={`role-option ${role === option.id ? 'active' : ''}`} onClick={() => change(option.id)} disabled={switching}>{option.label}</button>)}</div></div>{role === 'worker' && <div className="role-address"><span>On the other computer, choose <strong>Add device</strong> and enter</span><code>{workerAddress || 'http://<this-computer-IP>:9000'}</code>{workerAddress && <button className="secondary-button" onClick={() => navigator.clipboard?.writeText(workerAddress)}>Copy</button>}</div>}{error && <div className="form-error">{error}</div>}</section>
}

function FabricView({ devices, nodes, onConnect }) { const local = devices.filter((device) => device.available).map((device) => ({ ...device, kind: 'ON THIS COMPUTER', state: 'online', name: friendlyBackend(device.backend), detail: 'Ready to use' })); const remote = nodes.filter((node) => node.name !== 'This device').flatMap((node) => node.capabilities.filter((device) => device.available !== false).map((device) => ({ ...device, kind: `OTHER COMPUTER / ${node.name}`, state: node.status, name: friendlyBackend(device.backend), detail: node.status === 'online' ? 'Ready to use' : 'Not responding', node_id: node.node_id, memory: device.memory || {} }))); const all = [...local, ...remote]; return <><PageHeader eyebrow="DEVICES" title="Your devices" description="See which computers can help with your tasks." action={<button className="primary-button" onClick={onConnect}><span>+</span> Add device</button>} /><RolePanel /><div className="fabric-banner"><div><span className="status-dot" /><strong>{all.filter((device) => device.state === 'online').length} devices ready</strong><span>{all.length} available devices</span></div><span className="eyebrow">LIVE STATUS</span></div>{all.length ? <section className="device-grid">{all.map((device, index) => <DeviceCard key={`${device.name}-${index}`} device={device} />)}</section> : <EmptyState title="No devices found" detail="Start the HAR service and try again." action="Add device" onAction={onConnect} />}</> }

function TracesView({ run, trace, runs, onSelectRun }) { return <><PageHeader eyebrow="TASK DETAILS" title="Activity" description="See the steps HAR completed for a task." action={<select className="trace-select" value={run?.id || ''} onChange={(event) => onSelectRun(event.target.value)}><option value="">Choose a task</option>{runs.map((item) => <option key={item.id} value={item.id}>{item.id} / {friendlyBackend(item.request.backend)}</option>)}</select>} />{!run ? <EmptyState title="No task selected" detail="Start a task first, then choose it here." /> : <><div className="trace-toolbar"><div><span className="eyebrow">TASK</span><strong>{run.id} / Matrix calculation / {friendlyBackend(run.request.backend)}</strong></div><span className="trace-context"><StatusBadge status={run.status} /></span></div><section className="panel trace-panel">{trace?.operations?.length ? trace.operations.map((operation) => <TraceRow key={operation.name} operation={operation} />) : <div className="empty-state">Activity will appear when the task finishes.</div>}</section><div className="trace-footer"><div><span className="eyebrow">RESULT</span><strong>{run.result ? (run.result.correctness_passed ? 'Everything looks good' : 'Please check the result') : 'Still working'}</strong><span>{run.request.size} x {run.request.size} calculation / {run.request.measured_iterations} checks</span></div><div className="selected-metrics"><Metric label="Time" value={formatDuration(run.result?.latency_seconds?.median)} /><Metric label="Speed" value={run.result?.throughput_tflops?.median != null ? `${run.result.throughput_tflops.median.toFixed(3)} TFLOP/s` : 'Unavailable'} /><Metric label="Memory" value={run.result ? (run.result.device.memory.estimated ? 'Estimated' : 'Measured') : 'Pending'} /></div></div></>}</> }

function BenchmarksView({ runs, onNavigate, onSelectRun }) { const completed = runs.filter((run) => run.status === 'completed' && run.result); const latest = completed[0]; return <><PageHeader eyebrow="OPTIONAL" title="Performance" description="Compare how long your tasks take on different devices." action={<button className="secondary-button" onClick={() => onNavigate('traces')}>See task details <span>-&gt;</span></button>} />{latest ? <div className="benchmark-layout"><section className="panel benchmark-card"><div className="eyebrow">MOST RECENT RESULT</div><h2>Matrix calculation</h2><p>{friendlyBackend(latest.request.backend)} / {latest.request.size} x {latest.request.size}</p><div className="benchmark-metrics"><Metric label="Time" value={formatDuration(latest.result.latency_seconds.median)} /><Metric label="Speed" value={`${latest.result.throughput_tflops.median.toFixed(3)} TFLOP/s`} /><Metric label="Result" value={latest.result.correctness_passed ? 'Good' : 'Check'} /></div><button className="secondary-button" onClick={() => { onSelectRun(latest.id); onNavigate('traces') }}>See what happened <span>-&gt;</span></button></section><section className="panel benchmark-history"><div className="section-heading compact"><div><div className="eyebrow">HISTORY</div><h2>Previous results</h2></div><span className="chart-meta">{completed.length} results</span></div>{completed.slice(0, 8).map((run) => <button className="benchmark-session" key={run.id} onClick={() => { onSelectRun(run.id); onNavigate('traces') }}><div><strong>{friendlyBackend(run.request.backend)} / Matrix calculation</strong><span>{run.request.size} x {run.request.size} / {formatDate(run.created_at)}</span></div><b>{formatDuration(run.result.latency_seconds.median)}</b><StatusBadge status={run.status} /></button>)}</section></div> : <EmptyState title="No results yet" detail="Complete a task to compare its performance here." action="Open tasks" onAction={() => onNavigate('workloads')} />}</> }

function ScriptLauncher({ nodes, onClose, onSubmit }) {
  const [file, setFile] = useState(null)
  const [targetNode, setTargetNode] = useState('local')
  const [args, setArgs] = useState('')
  const [error, setError] = useState('')
  const chooseFile = async (event) => {
    const selected = event.target.files?.[0]
    if (!selected) return
    if (!selected.name.toLowerCase().endsWith('.py')) { setError('Choose a Python file ending in .py.'); return }
    setFile({ filename: selected.name, content: await selected.text() })
    setError('')
  }
  const submit = async (event) => {
    event.preventDefault()
    if (!file) { setError('Choose a Python file first.'); return }
    try { await onSubmit({ ...file, target_node: targetNode, args: args.trim() ? args.trim().split(/\s+/) : [] }) } catch (submitError) { setError(submitError.message) }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="launcher-modal" onSubmit={submit}><div className="modal-header"><div><div className="eyebrow">NEW TASK</div><h2>Run a Python file</h2></div><button type="button" className="close-button" onClick={onClose}>X</button></div><p>HAR copies the file to the selected computer and runs it in a temporary job folder.</p><label>Python file<input type="file" accept=".py,text/x-python" onChange={chooseFile} /></label>{file && <div className="selected-file"><span className="status-dot" />{file.filename}</div>}<label>Computer<select value={targetNode} onChange={(event) => setTargetNode(event.target.value)}><option value="local">This computer</option>{nodes.filter((node) => node.name !== 'This device').map((node) => <option key={node.node_id} value={node.node_id} disabled={node.status !== 'online'}>{node.name} / {node.status === 'online' ? 'ready' : 'not available'}</option>)}</select></label><label>Arguments <span className="optional">OPTIONAL</span><input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="--input data.csv" /></label><div className="advanced-note">The file runs with the Python packages already installed on that computer. No shell command is executed.</div>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Run file <span>-&gt;</span></button></div></form></div>
}

function ConnectDevice({ onClose, onConnected }) {
  const [workerUrl, setWorkerUrl] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState(false)
  const submit = async (event) => {
    event.preventDefault(); setError('')
    if (!workerUrl.trim()) { setError("Enter the address shown on the other computer's Devices page."); return }
    setWaiting(true)
    try {
      const response = await fetch(`${API}/api/nodes/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worker_url: workerUrl.trim(), name: name.trim() || null }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Could not connect this device')
      await onConnected()
    } catch (connectError) { setError(connectError.message) } finally { setWaiting(false) }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="launcher-modal" onSubmit={submit}><div className="modal-header"><div><div className="eyebrow">ADD DEVICE</div><h2>Connect another computer</h2></div><button type="button" className="close-button" onClick={onClose}>X</button></div><p>Open the HAR worker app on the other computer, then enter the address shown there.</p><label>Device address<input value={workerUrl} onChange={(event) => setWorkerUrl(event.target.value)} placeholder="192.168.1.25:9000" disabled={waiting} autoFocus /></label><label>Device name <span className="optional">OPTIONAL</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Office computer" /></label><div className="advanced-note">{waiting ? 'Waiting for someone to click Accept on the other computer (up to 2 minutes)...' : 'Set the other computer to Worker on its Devices page. After you connect, click Accept there.'}</div>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={waiting}>{waiting ? 'Waiting for approval...' : 'Connect device'} <span>-&gt;</span></button></div></form></div>
}

function Launcher({ devices, nodes, onClose, onSubmit }) { const available = devices.filter((device) => device.available); const [form, setForm] = useState({ backend: available[0]?.backend || 'cpu', size: 1024, warmup_iterations: 3, measured_iterations: 10, seed: 42, target_node: 'local' }); const [submitError, setSubmitError] = useState(''); const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value })); const submit = async (event) => { event.preventDefault(); setSubmitError(''); try { await onSubmit({ ...form, size: Number(form.size), warmup_iterations: Number(form.warmup_iterations), measured_iterations: Number(form.measured_iterations), seed: Number(form.seed) }) } catch (error) { setSubmitError(error.message) } }; return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="launcher-modal" onSubmit={submit}><div className="modal-header"><div><div className="eyebrow">NEW TASK</div><h2>Start a calculation</h2></div><button type="button" className="close-button" onClick={onClose}>X</button></div><p>Choose how much work to do and which device should handle it.</p><label>Computer<select value={form.target_node} onChange={update('target_node')}><option value="local">This computer</option>{nodes.map((node) => <option key={node.node_id} value={node.node_id} disabled={node.status !== 'online'}>{node.name} / {node.status === 'online' ? 'ready' : 'not available'}</option>)}</select></label><label>Processing device<select value={form.backend} onChange={update('backend')}>{available.map((device) => <option key={device.backend} value={device.backend}>{friendlyBackend(device.backend)}</option>)}</select></label><label>Amount of work<select value={form.size} onChange={update('size')}><option value="512">Small</option><option value="1024">Medium</option><option value="2048">Large</option></select></label><div className="advanced-note">HAR will choose the safe measurement settings automatically.</div>{submitError && <div className="form-error">{submitError}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Start task <span>-&gt;</span></button></div></form></div> }

function WorkloadRow({ run, onClick }) { const total = run.request.measured_iterations || 1; const progress = Math.round((run.completed_iterations / total) * 100); return <button className="workload-row" onClick={onClick}><div className="workload-id"><span className={`workload-pulse ${run.status}`} /><div><strong>Matrix calculation</strong><span>{run.request.size} x {run.request.size} · {formatDate(run.created_at)}</span></div></div><div className="row-placement"><BackendBadge backend={run.request.backend} /><span>{run.node_id === 'local' ? 'This computer' : run.node_id}</span></div><div className="row-progress"><div className="progress-track"><div style={{ width: `${progress}%` }} /></div><span>{run.status === 'completed' ? '100%' : `${progress}%`}</span></div><StatusBadge status={run.status} /><div className="row-time">{formatDate(run.updated_at)}</div></button> }
function ScriptRow({ script }) { return <div className="workload-row script-row"><div className="workload-id"><span className={`workload-pulse ${script.status}`} /><div><strong>{script.filename}</strong><span>Python file · {formatDate(script.created_at)}</span></div></div><div className="row-placement"><span>{script.target_node === 'local' ? 'This computer' : script.target_node}</span></div><div className="row-progress"><span>{script.status}</span></div><StatusBadge status={script.status} /><div className="row-time">{script.exit_code == null ? 'Running' : `Exit ${script.exit_code}`}</div></div> }
function DeviceCard({ device }) { const memory = device.memory || {}; return <article className={`panel device-card-large ${device.state}`}><div className="device-card-head"><div><BackendBadge backend={device.backend} /><span className="device-kind">{device.kind}</span></div><StatusBadge status={device.state} /></div><h2>{device.name}</h2><p>{device.detail}</p><div className="device-metrics"><Metric label="Status" value={device.available === false ? 'Not ready' : 'Ready'} /><Metric label="Free space" value={formatBytes(memory.available_bytes)} /></div><div className="util-track large"><div className={`backend-fill ${device.backend}`} style={{ width: memory.total_bytes && memory.available_bytes != null ? `${Math.min((memory.available_bytes / memory.total_bytes) * 100, 100)}%` : '0%' }} /></div><div className="device-workload"><span>SPACE INFORMATION</span><strong>{memory.estimated ? 'Estimated' : memory.measured ? 'Measured' : 'Not available'}</strong></div></article> }
function TraceRow({ operation }) { return <div className="trace-row"><div className="trace-label"><span className={`trace-dot ${operation.backend}`} /><div><strong>{operation.name}</strong><span>{operation.type}</span></div></div><div className="trace-lane"><div className={`trace-bar ${operation.backend}`} style={{ width: operation.duration_seconds ? '100%' : '40%' }}><span>{operation.backend.toUpperCase()}</span></div></div><div className="trace-value"><strong>{formatDuration(operation.duration_seconds)}</strong><span>{operation.measured ? 'Measured' : 'Unavailable'}</span></div></div> }
function Placement({ label, value, accent }) { return <div><span>{label}</span><strong className={accent || ''}>{value}</strong></div> }
function Metric({ label, value }) { return <div className="small-metric"><span>{label}</span><strong>{value}</strong></div> }
function StatCard({ label, value, detail, accent }) { return <div className={`stat-card ${accent}`}><span className="eyebrow">{label}</span><strong>{value}</strong><span>{detail}</span></div> }
function friendlyBackend(backend) { return { cpu: 'Computer processor', mps: 'Apple graphics', cuda: 'NVIDIA graphics', network: 'Another computer' }[backend] || backend }
function BackendBadge({ backend }) { return <span className={`backend-badge ${backend.toLowerCase()}`}>{friendlyBackend(backend)}</span> }
function StatusBadge({ status }) { return <span className={`status-badge ${status}`}><span className="status-dot" />{status}</span> }
function EmptyState({ title, detail, action, onAction }) { return <div className="empty-state"><strong>{title}</strong><span>{detail}</span>{action && <button className="secondary-button" onClick={onAction}>{action} <span>-&gt;</span></button>}</div> }

createRoot(document.getElementById('root')).render(<App />)

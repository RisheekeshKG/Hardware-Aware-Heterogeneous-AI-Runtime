import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import CodeMirror from '@uiw/react-codemirror'
import { python } from '@codemirror/lang-python'
import { oneDark } from '@codemirror/theme-one-dark'
import './styles.css'

const API = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'
// The desktop app launches the runtime itself; give it time to boot before reporting a failure.
const RUNTIME_STARTUP_GRACE_MS = 20000
const navItems = [
  { id: 'runtime', label: 'Overview', icon: 'O', group: 'workspace' },
  { id: 'workloads', label: 'Scripts', icon: 'S', group: 'workspace' },
  { id: 'fabric', label: 'Devices', icon: 'D', group: 'workspace' },
  { id: 'traces', label: 'Activity', icon: 'A', group: 'workspace' },
  { id: 'benchmarks', label: 'Benchmarks', icon: 'B', group: 'devtools' },
]
const navGroups = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'devtools', label: 'Dev tools' },
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

function Dropdown({ value, onChange, options, placeholder = 'Choose...', disabled = false, ariaLabel }) {
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(-1)
  const rootRef = useRef(null)
  const current = options.find((option) => option.value === value)
  useEffect(() => {
    if (!open) return undefined
    const close = (event) => { if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const enabledIndices = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0)
  const handleKey = (event) => {
    if (disabled) return
    if (!open && (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown')) { event.preventDefault(); setOpen(true); setFocused(enabledIndices[0] ?? -1); return }
    if (!open) return
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const pos = enabledIndices.indexOf(focused)
      const nextPos = pos === -1 ? 0 : (pos + direction + enabledIndices.length) % enabledIndices.length
      setFocused(enabledIndices[nextPos])
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const option = options[focused]
      if (option && !option.disabled) { onChange(option.value); setOpen(false) }
    }
  }
  return <div className={`dropdown ${disabled ? 'disabled' : ''} ${open ? 'open' : ''}`} ref={rootRef}>
    <button type="button" className="dropdown-trigger" onClick={() => !disabled && setOpen((state) => !state)} onKeyDown={handleKey} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}>
      <span className="dropdown-label">{current ? current.label : placeholder}</span>
      <span className="dropdown-chevron" aria-hidden>v</span>
    </button>
    {open && <ul className="dropdown-menu" role="listbox">
      {options.map((option, index) => <li key={option.value} role="option" aria-selected={option.value === value}>
        <button type="button" className={`dropdown-option ${option.value === value ? 'selected' : ''} ${option.disabled ? 'disabled' : ''} ${index === focused ? 'focused' : ''}`} onClick={() => { if (option.disabled) return; onChange(option.value); setOpen(false) }} disabled={option.disabled} onMouseEnter={() => setFocused(index)}>
          <span>{option.label}</span>
          {option.hint && <span className="dropdown-hint">{option.hint}</span>}
        </button>
      </li>)}
    </ul>}
  </div>
}

function RefreshButton({ onClick, title = 'Refresh' }) {
  return <button type="button" className="icon-button section-refresh" onClick={onClick} aria-label={title} title={title}>R</button>
}

function App() {
  const [runtimeSetup, setRuntimeSetup] = useState({ checking: true, installed: true, target: '', asset: '', error: '' })
  const [view, setView] = useState('runtime')
  const [runtime, setRuntime] = useState({ devices: [], nodes: [], runs: [] })
  const [scripts, setScripts] = useState([])
  const [selectedRunId, setSelectedRunId] = useState(null)
  const [selectedScriptId, setSelectedScriptId] = useState(null)
  const [cpuInfo, setCpuInfo] = useState({ brand: null, frequency_ghz: null })
  const [trace, setTrace] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showLauncher, setShowLauncher] = useState(false)
  const [showScriptLauncher, setShowScriptLauncher] = useState(false)
  const [showConnect, setShowConnect] = useState(false)
  const [toast, setToast] = useState('')
  const [pairing, setPairing] = useState([])
  const [trustedHosts, setTrustedHosts] = useState([])
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
    invoke('cpu_info').then((info) => info && setCpuInfo(info)).catch(() => {})
    return undefined
  }, [])

  const loadRuntime = async () => {
    try {
      const [runtimeResponse, scriptsResponse] = await Promise.all([fetch(`${API}/api/runtime`), fetch(`${API}/api/scripts`)] )
      if (!runtimeResponse.ok || !scriptsResponse.ok) throw new Error('Runtime API returned an error')
      const data = await runtimeResponse.json()
      setScripts(await scriptsResponse.json())
      fetch(`${API}/api/pairing`).then((response) => response.ok ? response.json() : []).then(setPairing).catch(() => setPairing([]))
      fetch(`${API}/api/trusted-hosts`).then((response) => response.ok ? response.json() : []).then(setTrustedHosts).catch(() => setTrustedHosts([]))
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

  const disconnectNode = async (node) => {
    const name = node?.name || node?.node_id
    if (!node?.node_id) return
    if (!window.confirm(`Disconnect ${name}? HAR will stop sending tasks to this device.`)) return
    try {
      const response = await fetch(`${API}/api/nodes/${encodeURIComponent(node.node_id)}`, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.detail || `HTTP ${response.status}`)
      }
      notify(`${name} disconnected.`)
      await loadRuntime()
    } catch (error) {
      notify(`Could not disconnect: ${error.message}`)
    }
  }

  const launchScript = async (request) => {
    const response = await fetch(`${API}/api/scripts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.detail || 'Could not start Python file')
    setShowScriptLauncher(false)
    setSelectedScriptId(data.id)
    setView('workloads')
    notify(`${data.filename} is running. Output will appear below.`)
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
      {navGroups.map((group) => <React.Fragment key={group.id}><div className={`nav-group-label ${group.id === 'devtools' ? 'devtools' : ''}`}>{group.label}</div><nav className="main-nav" aria-label={`${group.label} navigation`}>{navItems.filter((item) => item.group === group.id).map((item) => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => setView(item.id)}><span className="nav-icon">{item.icon}</span><span>{item.label}</span></button>)}</nav></React.Fragment>)}
      <div className="sidebar-spacer" />
      <div className="sidebar-note"><span className="eyebrow">HAR STATUS</span><strong>{error ? 'Needs attention' : 'Ready to help'}</strong><span>{loading ? 'Checking your devices...' : 'Connected to this computer'}</span></div>
      <div className="connection-status"><span className={`status-dot ${error ? 'error' : ''}`} /><span>{error ? 'NOT CONNECTED' : 'CONNECTED'}</span><small>{loading ? 'Checking devices...' : (() => { const machines = (runtime.devices.filter((d) => d.available).length ? 1 : 0) + runtime.nodes.filter((n) => n.name !== 'This device' && n.status === 'online').length; return `${machines} machine${machines === 1 ? '' : 's'} ready` })()}</small></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="breadcrumbs"><span>HAR</span><i>/</i><strong>{pageLabel}</strong></div><div className="topbar-actions"><span className="live-pill"><span className={`status-dot ${error ? 'error' : ''}`} /> {error ? 'Disconnected' : 'Live API'}</span><button className="icon-button" onClick={loadRuntime} aria-label="Refresh runtime">R</button></div></header>
      {runtimeSetup.update_available && <RuntimeUpdate status={runtimeSetup} onUpdated={(status) => { startedAt.current = Date.now(); connectedOnce.current = false; setRuntimeSetup({ ...status, checking: false, error: '' }); notify('Runtime updated.') }} />}
      {error && <div className="api-error"><span className="status-dot error" /><div><strong>HAR cannot connect right now</strong><span>Make sure the HAR service is running, then try again.</span></div><button onClick={loadRuntime}>Try again</button></div>}
      {view === 'runtime' && <RuntimeView devices={runtime.devices} nodes={runtime.nodes} runs={runtime.runs} activeRun={activeRun} cpuInfo={cpuInfo} onLaunch={() => setShowLauncher(true)} onNavigate={setView} onSelectRun={setSelectedRunId} />}
      {view === 'workloads' && <WorkloadsView scripts={scripts} selectedScriptId={selectedScriptId} onSelectScript={setSelectedScriptId} onScriptLaunch={() => setShowScriptLauncher(true)} devices={runtime.devices} nodes={runtime.nodes} cpuInfo={cpuInfo} onRefresh={loadRuntime} />}
      {view === 'fabric' && <FabricView devices={runtime.devices} nodes={runtime.nodes} cpuInfo={cpuInfo} trustedHosts={trustedHosts} onConnect={() => setShowConnect(true)} onDisconnect={disconnectNode} onRefresh={loadRuntime} onRevokeTrustedHost={async (ip) => { if (!window.confirm(`Revoke trust for ${ip}? HAR will refuse future jobs from this host.`)) return; try { const r = await fetch(`${API}/api/trusted-hosts/${encodeURIComponent(ip)}`, { method: 'DELETE' }); if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.detail || `HTTP ${r.status}`) } notify(`${ip} is no longer trusted.`); await loadRuntime() } catch (e) { notify(`Could not revoke: ${e.message}`) } }} />}
      {view === 'traces' && <TracesView scripts={scripts} selectedScriptId={selectedScriptId} onSelectScript={setSelectedScriptId} onScriptLaunch={() => setShowScriptLauncher(true)} devices={runtime.devices} nodes={runtime.nodes} cpuInfo={cpuInfo} onRefresh={loadRuntime} />}
      {view === 'benchmarks' && <BenchmarksView runs={runtime.runs} trace={trace} selectedRun={selectedRun} onLaunch={() => setShowLauncher(true)} onSelectRun={setSelectedRunId} onRefresh={loadRuntime} />}
    </main>
    {showLauncher && <Launcher devices={runtime.devices} nodes={runtime.nodes} cpuInfo={cpuInfo} onClose={() => setShowLauncher(false)} onSubmit={launchRun} />}
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

function RuntimeView({ devices, nodes, runs, activeRun, cpuInfo, onLaunch, onNavigate, onSelectRun }) {
  const availableDevices = devices.filter((device) => device.available)
  const onlineNodes = nodes.filter((node) => node.status === 'online' && node.name !== 'This device')
  const runningCount = runs.filter((run) => run.status === 'running').length
  const queuedCount = runs.filter((run) => run.status === 'queued').length
  return <>
    <PageHeader eyebrow="HAR" title="Overview" description="See what is running and which devices are available to help." action={<button className="primary-button" onClick={onLaunch}><span>+</span> Start a task</button>} />
    <section className="stat-grid"><StatCard label="Tasks in progress" value={String(runningCount + queuedCount).padStart(2, '0')} detail={`${runningCount} running · ${queuedCount} waiting`} accent="lime" /><StatCard label="Devices available" value={String((availableDevices.length ? 1 : 0) + onlineNodes.length).padStart(2, '0')} detail={`${availableDevices.length + onlineNodes.reduce((sum, node) => sum + node.capabilities.filter((capability) => capability.available !== false).length, 0)} runtimes across your machines`} accent="blue" /><StatCard label="System status" value={devices.length ? 'Ready' : 'Waiting'} detail={devices.length ? 'Everything is responding' : 'Looking for devices'} accent="green" /><StatCard label="Finished tasks" value={String(runs.filter((run) => run.status === 'completed').length).padStart(2, '0')} detail="Completed successfully" accent="amber" /></section>
    <section className="runtime-grid"><ActiveWorkload run={activeRun} onTrace={() => { if (activeRun) { onSelectRun(activeRun.id); onNavigate('traces') } }} /><FabricSummary devices={devices} nodes={nodes} cpuInfo={cpuInfo} onOpen={() => onNavigate('fabric')} /></section>
    <section className="section-block"><div className="section-heading"><div><div className="eyebrow">RECENT ACTIVITY</div><h2>Recent benchmark runs</h2></div><button className="text-button" onClick={() => onNavigate('benchmarks')}>Open benchmarks <span>-&gt;</span></button></div>{runs.length ? <div className="workload-list">{runs.slice(0, 8).map((run) => <WorkloadRow key={run.id} run={run} nodes={nodes} onClick={() => { onSelectRun(run.id); onNavigate('benchmarks') }} />)}</div> : <EmptyState title="No benchmark runs yet" detail="Benchmarks are optional dev tools. Scripts are the main workflow." action="Open scripts" onAction={() => onNavigate('workloads')} />}</section>
  </>
}

function ActiveWorkload({ run, onTrace }) {
  if (!run) return <article className="panel active-workload-panel"><div className="eyebrow">CURRENT TASK</div><h2>Nothing is running</h2><p className="empty-copy">HAR is ready. Start a task to see its progress here.</p><button className="secondary-button" onClick={onTrace}>No activity yet</button></article>
  const total = run.request.measured_iterations || 1
  const progress = Math.round((run.completed_iterations / total) * 100)
  return <article className="panel active-workload-panel"><div className="panel-top"><div><div className="eyebrow">CURRENT TASK</div><h2>Matrix calculation</h2></div><StatusBadge status={run.status} /></div><div className="workload-meta"><span>{run.request.size} x {run.request.size} calculation</span><span>{run.request.measured_iterations} checks</span><span>{formatDate(run.created_at)}</span></div><div className="execution-line"><div className="execution-line-head"><span>Progress</span><strong>{run.last_latency_seconds ? formatDuration(run.last_latency_seconds) : 'Waiting'}</strong></div><div className="progress-track"><div style={{ width: `${progress}%` }} /></div><div className="execution-line-foot"><span>{run.completed_iterations} / {total} checks</span><span>{run.status}</span></div></div><div className="placement-grid"><Placement label="Choice" value={friendlyBackend(run.request.backend)} accent={run.request.backend} /><Placement label="Device" value={run.node_id === 'local' ? 'This computer' : run.node_id} /><Placement label="Result" value={run.result ? (run.result.correctness_passed ? 'Good' : 'Check failed') : 'Pending'} /></div><button className="secondary-button" onClick={onTrace}>See task details <span>-&gt;</span></button></article>
}

function FabricSummary({ devices, nodes, cpuInfo, onOpen }) {
  const visibleNodes = nodes.filter((node) => node.name !== 'This device')
  const localAvailable = devices.filter((device) => device.available)
  const machinesReady = (localAvailable.length ? 1 : 0) + visibleNodes.filter((node) => node.status === 'online').length
  const runtimesReady = localAvailable.length + visibleNodes.filter((node) => node.status === 'online').reduce((sum, node) => sum + node.capabilities.filter((capability) => capability.available !== false).length, 0)
  return <article className="panel fabric-summary"><div className="section-heading compact"><div><div className="eyebrow">YOUR DEVICES</div><h2>Device status</h2></div><span className="online-count"><span className="status-dot" /> {machinesReady} device{machinesReady === 1 ? '' : 's'} · {runtimesReady} runtime{runtimesReady === 1 ? '' : 's'}</span></div><div className="mini-devices">{localAvailable.slice(0, 3).map((device) => <DeviceSummary key={device.backend} device={device} cpuInfo={cpuInfo} />)}{!localAvailable.length && <div className="empty-copy">No devices are ready yet.</div>}</div><button className="secondary-button" onClick={onOpen}>See all devices <span>-&gt;</span></button></article>
}
function DeviceSummary({ device, cpuInfo }) { const memory = device.memory; const label = device.backend === 'cpu' ? cpuLabel(device, cpuInfo) : device.device_name; return <div className="mini-device"><div className="mini-device-top"><BackendBadge backend={device.backend} /><span className="device-state online">online</span></div><strong>{label}</strong><div className="util-row"><span>{memory.measured ? 'Measured memory' : memory.estimated ? 'Estimated memory' : 'Memory unavailable'}</span><span>{formatBytes(memory.available_bytes)} free</span></div><div className="util-track"><div className={`backend-fill ${device.backend}`} style={{ width: memory.total_bytes && memory.available_bytes != null ? `${Math.min((memory.available_bytes / memory.total_bytes) * 100, 100)}%` : '0%' }} /></div></div> }

function WorkloadsView({ scripts, selectedScriptId, onSelectScript, onScriptLaunch, devices, nodes, cpuInfo, onRefresh }) {
  const selectedScript = scripts.find((script) => script.id === selectedScriptId) || null
  return <>
    <PageHeader eyebrow="SCRIPTS" title="Run Python" description="Write a Python script, pick a device, see what it printed and whether it finished cleanly." action={<button className="primary-button" onClick={onScriptLaunch}><span>+</span> New script</button>} />
    <section className="panel launch-card">
      <div className="eyebrow">GET STARTED</div>
      <h2>Write Python in HAR</h2>
      <p>Type your script, pick where it runs, see its stdout and exit code here. @har.offload-decorated functions get routed per call; the rest runs in-process.</p>
      <button className="large-launch" onClick={onScriptLaunch}><span className="launch-icon">-&gt;</span><span><strong>Write a new script</strong><small>Opens an in-app editor; you can also load an existing .py file to seed it</small></span><span className="arrow">+</span></button>
      <div className="policy-note"><span className="status-dot" /><span>Scripts run in a temporary job folder on the selected device.</span></div>
    </section>
    <section className="section-block">
      <div className="section-heading"><div><div className="eyebrow">SCRIPT HISTORY</div><h2>Your Python runs</h2></div>{scripts.length ? <span className="chart-meta">{scripts.length} run{scripts.length === 1 ? '' : 's'}</span> : null}</div>
      {scripts.length ? <div className="workload-list">{scripts.map((script) => <ScriptRow key={script.id} script={script} nodes={nodes} active={script.id === selectedScriptId} onClick={() => onSelectScript(script.id === selectedScriptId ? null : script.id)} />)}</div> : <EmptyState title="No Python runs yet" detail="Write a script to see output and status here." action="New script" onAction={onScriptLaunch} />}
      {selectedScript && <ScriptDetail script={selectedScript} onClose={() => onSelectScript(null)} onRefresh={onRefresh} devices={devices} nodes={nodes} cpuInfo={cpuInfo} />}
    </section>
  </>
}

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

function FabricView({ devices, nodes, cpuInfo, trustedHosts, onConnect, onDisconnect, onRefresh, onRevokeTrustedHost }) {
  const localAvailable = devices.filter((device) => device.available)
  const local = localAvailable.map((device) => ({ ...device, kind: 'ON THIS COMPUTER', state: 'online', name: deviceHeading(device, cpuInfo), detail: 'Ready to use' }))
  const remoteNodes = nodes.filter((node) => node.name !== 'This device')
  const remote = remoteNodes.flatMap((node) => node.capabilities.filter((device) => device.available !== false).map((device) => ({ ...device, kind: `OTHER COMPUTER / ${node.name}`, state: node.status, name: deviceHeading(device), detail: node.status === 'online' ? 'Ready to use' : 'Not responding', node_id: node.node_id, memory: device.memory || {} })))
  const all = [...local, ...remote]
  const machineCount = (localAvailable.length ? 1 : 0) + remoteNodes.length
  const machinesReady = (localAvailable.length ? 1 : 0) + remoteNodes.filter((node) => node.status === 'online').length
  const runtimesReady = all.filter((device) => device.state === 'online').length
  return <><PageHeader eyebrow="DEVICES" title="Your devices" description="See which computers can help with your tasks." action={<div className="header-actions">{onRefresh && <RefreshButton onClick={onRefresh} title="Refresh devices" />}<button className="primary-button" onClick={onConnect}><span>+</span> Add device</button></div>} /><RolePanel /><TrustedHostsPanel hosts={trustedHosts} onRevoke={onRevokeTrustedHost} /><div className="fabric-banner"><div><span className="status-dot" /><strong>{machinesReady} device{machinesReady === 1 ? '' : 's'} available</strong><span>{runtimesReady} runtime{runtimesReady === 1 ? '' : 's'} across {machineCount} machine{machineCount === 1 ? '' : 's'}</span></div><span className="eyebrow">LIVE STATUS</span></div>{all.length ? <section className="device-grid">{all.map((device, index) => <DeviceCard key={`${device.name}-${index}`} device={device} onDisconnect={onDisconnect} />)}</section> : <EmptyState title="No devices found" detail="Start the HAR service and try again." action="Add device" onAction={onConnect} />}</>
}

function TrustedHostsPanel({ hosts, onRevoke }) {
  if (!hosts || hosts.length === 0) return null
  return <section className="panel trusted-hosts-panel">
    <div className="section-heading compact">
      <div><div className="eyebrow">HOSTS CONNECTED TO THIS COMPUTER</div><h2>{hosts.length} host{hosts.length === 1 ? '' : 's'} can send tasks here</h2></div>
      <span className="eyebrow trusted-hosts-warn">AUDIT REGULARLY</span>
    </div>
    <p className="empty-copy">Each host below has previously been accepted and can run Python and benchmarks on this computer. Revoke any you don't recognize.</p>
    <div className="trusted-hosts-list">
      {hosts.map((host) => <div className="trusted-host-row" key={host.client_ip}>
        <div><strong>{host.client_ip}</strong><span>Trusted</span></div>
        <button type="button" className="secondary-button device-disconnect" onClick={() => onRevoke(host.client_ip)}>Revoke</button>
      </div>)}
    </div>
  </section>
}

function TracesView({ scripts, selectedScriptId, onSelectScript, onScriptLaunch, devices, nodes, cpuInfo, onRefresh }) {
  const selectedScript = scripts.find((script) => script.id === selectedScriptId) || scripts[0] || null
  return <>
    <PageHeader eyebrow="SCRIPT ACTIVITY" title="Activity" description="See what each Python run did: where it ran, how long it took, and its output." action={<div className="header-actions">{onRefresh && <RefreshButton onClick={onRefresh} title="Refresh" />}<Dropdown ariaLabel="Choose a script run" placeholder="Choose a script run" value={selectedScript?.id || ''} onChange={(next) => onSelectScript(next || null)} options={scripts.map((item) => ({ value: item.id, label: `${item.filename}  ·  ${formatDate(item.created_at)}` }))} /></div>} />
    {!selectedScript ? <EmptyState title="No script runs yet" detail="Write a script first, then its activity shows up here." action="New script" onAction={onScriptLaunch} /> : <ScriptDetail script={selectedScript} onRefresh={onRefresh} devices={devices} nodes={nodes} cpuInfo={cpuInfo} />}
  </>
}

function BenchmarksView({ runs, trace, selectedRun, onLaunch, onSelectRun, onRefresh }) { const completed = runs.filter((run) => run.status === 'completed' && run.result); const latest = completed[0]; return <><PageHeader eyebrow="DEV TOOLS" title="Benchmarks" description="Built-in matrix calculation used to compare backends. Not part of the main workflow." action={<div className="header-actions">{onRefresh && <RefreshButton onClick={onRefresh} title="Refresh benchmarks" />}<button className="primary-button" onClick={onLaunch}><span>+</span> Start benchmark</button></div>} />{latest ? <><div className="benchmark-layout"><section className="panel benchmark-card"><div className="eyebrow">MOST RECENT RESULT</div><h2>Matrix calculation</h2><p>{friendlyBackend(latest.request.backend)} / {latest.request.size} x {latest.request.size}</p><div className="benchmark-metrics"><Metric label="Time" value={formatDuration(latest.result.latency_seconds.median)} /><Metric label="Speed" value={`${latest.result.throughput_tflops.median.toFixed(3)} TFLOP/s`} /><Metric label="Result" value={latest.result.correctness_passed ? 'Good' : 'Check'} /></div><button className="secondary-button" onClick={() => onSelectRun(latest.id)}>See what happened <span>-&gt;</span></button></section><section className="panel benchmark-history"><div className="section-heading compact"><div><div className="eyebrow">HISTORY</div><h2>Previous results</h2></div><span className="chart-meta">{completed.length} results</span></div>{completed.slice(0, 8).map((run) => <button className="benchmark-session" key={run.id} onClick={() => onSelectRun(run.id)}><div><strong>{friendlyBackend(run.request.backend)} / Matrix calculation</strong><span>{run.request.size} x {run.request.size} / {formatDate(run.created_at)}</span></div><b>{formatDuration(run.result.latency_seconds.median)}</b><StatusBadge status={run.status} /></button>)}</section></div>{selectedRun && <section className="section-block"><div className="trace-toolbar"><div><span className="eyebrow">TRACE</span><strong>{selectedRun.id} / Matrix calculation / {friendlyBackend(selectedRun.request.backend)}</strong></div><span className="trace-context"><StatusBadge status={selectedRun.status} /></span></div><section className="panel trace-panel">{trace?.operations?.length ? trace.operations.map((operation) => <TraceRow key={operation.name} operation={operation} />) : <div className="empty-state">Operation details will appear when the run finishes.</div>}</section>{selectedRun.result && <div className="trace-footer"><div><span className="eyebrow">RESULT</span><strong>{selectedRun.result.correctness_passed ? 'Everything looks good' : 'Please check the result'}</strong><span>{selectedRun.request.size} x {selectedRun.request.size} calculation / {selectedRun.request.measured_iterations} checks</span></div><div className="selected-metrics"><Metric label="Time" value={formatDuration(selectedRun.result.latency_seconds?.median)} /><Metric label="Speed" value={selectedRun.result.throughput_tflops?.median != null ? `${selectedRun.result.throughput_tflops.median.toFixed(3)} TFLOP/s` : 'Unavailable'} /><Metric label="Memory" value={selectedRun.result.device.memory.estimated ? 'Estimated' : 'Measured'} /></div></div>}</section>}</> : <EmptyState title="No benchmark runs yet" detail="Start a matrix benchmark to compare how a backend handles the workload." action="Start benchmark" onAction={onLaunch} />}</> }

const DEFAULT_SCRIPT = `import har
import torch


@har.offload
def big_matmul(size: int) -> torch.Tensor:
    left = torch.randn(size, size)
    right = torch.randn(size, size)
    return left @ right


result = big_matmul(2048)
print("result shape:", tuple(result.shape))
`

function ScriptLauncher({ nodes, onClose, onSubmit }) {
  const [filename, setFilename] = useState('untitled.py')
  const [content, setContent] = useState(DEFAULT_SCRIPT)
  const [targetNode, setTargetNode] = useState('local')
  const [args, setArgs] = useState('')
  const [error, setError] = useState('')

  const loadFile = async (event) => {
    const selected = event.target.files?.[0]
    if (!selected) return
    if (!selected.name.toLowerCase().endsWith('.py')) { setError('Load a .py file.'); return }
    setFilename(selected.name)
    setContent(await selected.text())
    setError('')
  }

  const submit = async (event) => {
    event.preventDefault(); setError('')
    const name = filename.trim() || 'untitled.py'
    if (!name.toLowerCase().endsWith('.py')) { setError('Filename must end with .py.'); return }
    if (!content.trim()) { setError('Write some code first.'); return }
    try {
      await onSubmit({ filename: name, content, target_node: targetNode, args: args.trim() ? args.trim().split(/\s+/) : [] })
    } catch (submitError) { setError(submitError.message) }
  }

  const lineCount = content.split('\n').length
  const remoteNodes = nodes.filter((node) => node.name !== 'This device')

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="launcher-modal editor-modal" onSubmit={submit}>
    <div className="modal-header"><div><div className="eyebrow">NEW SCRIPT</div><h2>Write Python</h2></div><button type="button" className="close-button" onClick={onClose}>X</button></div>
    <p>Type Python here (or load a .py file to seed it). HAR copies the code to the selected computer and runs it in a temporary job folder.</p>
    <div className="editor-head">
      <label className="editor-filename">Filename<input value={filename} onChange={(event) => setFilename(event.target.value)} /></label>
      <label className="editor-load secondary-button" title="Load a .py file into the editor">Load file...<input type="file" accept=".py,text/x-python" onChange={loadFile} hidden /></label>
    </div>
    <label>Code <span className="editor-meta">{lineCount} line{lineCount === 1 ? '' : 's'} · {content.length} chars</span></label>
    <div className="code-editor-wrap">
      <CodeMirror
        value={content}
        height="380px"
        theme={oneDark}
        extensions={[python()]}
        onChange={(value) => setContent(value)}
        basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: false, autocompletion: true, bracketMatching: true, indentOnInput: true, highlightSelectionMatches: true }}
      />
    </div>
    <label>Computer<Dropdown ariaLabel="Target computer" value={targetNode} onChange={setTargetNode} options={[{ value: 'local', label: 'This computer' }, ...remoteNodes.map((node) => ({ value: node.node_id, label: node.name, disabled: node.status !== 'online', hint: node.status === 'online' ? null : 'not available' }))]} /></label>
    <label>Arguments <span className="optional">OPTIONAL</span><input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="--input data.csv" /></label>
    <div className="advanced-note">The script runs with the Python packages already installed on the selected computer. @har.offload-decorated functions get routed by HAR; everything else runs in-process as usual.</div>
    {error && <div className="form-error">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Run script <span>-&gt;</span></button></div>
  </form></div>
}

function ConnectDevice({ onClose, onConnected }) {
  const [workerUrl, setWorkerUrl] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [discovered, setDiscovered] = useState([])
  const [scanning, setScanning] = useState(false)
  const [scannedOnce, setScannedOnce] = useState(false)

  const scan = async () => {
    setScanning(true); setError('')
    try {
      const response = await fetch(`${API}/api/discovery`)
      if (!response.ok) throw new Error('Could not scan the network')
      setDiscovered(await response.json())
      setScannedOnce(true)
    } catch (scanError) { setError(scanError.message) } finally { setScanning(false) }
  }

  useEffect(() => { scan() }, [])

  const connectDiscovered = async (node) => {
    setWaiting(true); setError('')
    try {
      const response = await fetch(`${API}/api/discovery/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node_id: node.node_id, name: name.trim() || node.name || null }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.detail || 'Could not connect this device')
      await onConnected()
    } catch (connectError) { setError(connectError.message) } finally { setWaiting(false) }
  }

  const submit = async (event) => {
    event.preventDefault(); setError('')
    if (!workerUrl.trim()) { setError("Scan the network above, or type an address."); return }
    setWaiting(true)
    try {
      const response = await fetch(`${API}/api/nodes/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worker_url: workerUrl.trim(), name: name.trim() || null }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Could not connect this device')
      await onConnected()
    } catch (connectError) { setError(connectError.message) } finally { setWaiting(false) }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="launcher-modal connect-modal" onSubmit={submit}>
    <div className="modal-header"><div><div className="eyebrow">ADD DEVICE</div><h2>Connect another computer</h2></div><button type="button" className="close-button" onClick={onClose}>X</button></div>
    <p>HAR workers broadcast themselves on the LAN. Pick one from the scan below, or paste an address if you already know it.</p>

    <div className="section-heading compact" style={{ marginTop: 18 }}><div><span className="eyebrow">HAR USERS ON YOUR NETWORK</span></div><button type="button" className="text-button" onClick={scan} disabled={scanning}>{scanning ? 'Scanning...' : 'Rescan'}</button></div>
    {discovered.length ? <div className="discovered-list">{discovered.map((node) => <div className="discovered-row" key={node.node_id}><div><strong>{node.name || node.node_id}</strong><span>{node.base_url || node.address || node.node_id}</span></div><button type="button" className="secondary-button" onClick={() => connectDiscovered(node)} disabled={waiting}>Connect</button></div>)}</div> : <div className="empty-copy">{scannedOnce ? 'No HAR workers found on the LAN. Make sure the other computer is set to Worker.' : 'Scanning for HAR workers...'}</div>}

    <div className="section-heading compact" style={{ marginTop: 22 }}><div><span className="eyebrow">OR CONNECT BY ADDRESS</span></div></div>
    <label>Device address<input value={workerUrl} onChange={(event) => setWorkerUrl(event.target.value)} placeholder="192.168.1.25:9000" disabled={waiting} /></label>
    <label>Nickname <span className="optional">OPTIONAL</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Office computer" /></label>
    <div className="advanced-note">{waiting ? 'Waiting for someone to click Accept on the other computer (up to 2 minutes)...' : 'Set the other computer to Worker on its Devices page. After you connect, click Accept there.'}</div>
    {error && <div className="form-error">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={waiting || !workerUrl.trim()}>{waiting ? 'Waiting for approval...' : 'Connect by address'} <span>-&gt;</span></button></div>
  </form></div>
}

function backendsForTarget(targetNode, devices, nodes) {
  if (targetNode === 'local') return (devices || []).filter((device) => device.available)
  const node = (nodes || []).find((item) => item.node_id === targetNode)
  if (!node) return []
  return (node.capabilities || []).filter((capability) => capability.available !== false)
}
function Launcher({ devices, nodes, cpuInfo, onClose, onSubmit }) {
  const remoteNodes = (nodes || []).filter((node) => node.name !== 'This device')
  const [targetNode, setTargetNode] = useState('local')
  const availableBackends = backendsForTarget(targetNode, devices, nodes)
  const [form, setForm] = useState({ backend: availableBackends[0]?.backend || 'cpu', size: 1024, warmup_iterations: 3, measured_iterations: 10, seed: 42 })
  const [submitError, setSubmitError] = useState('')
  useEffect(() => {
    const first = availableBackends[0]?.backend
    if (first && !availableBackends.some((item) => item.backend === form.backend)) {
      setForm((current) => ({ ...current, backend: first }))
    }
  }, [targetNode, availableBackends.map((item) => item.backend).join(',')])
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const backendLabel = (backend) => backend.backend === 'cpu' && targetNode === 'local' ? cpuLabel(backend, cpuInfo) : (backend.device_name || friendlyBackend(backend.backend))
  const submit = async (event) => {
    event.preventDefault(); setSubmitError('')
    if (!form.backend) { setSubmitError('The selected computer has no available processing device.'); return }
    try { await onSubmit({ ...form, target_node: targetNode, size: Number(form.size), warmup_iterations: Number(form.warmup_iterations), measured_iterations: Number(form.measured_iterations), seed: Number(form.seed) }) } catch (error) { setSubmitError(error.message) }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="launcher-modal" onSubmit={submit}>
    <div className="modal-header"><div><div className="eyebrow">NEW TASK</div><h2>Start a calculation</h2></div><button type="button" className="close-button" onClick={onClose}>X</button></div>
    <p>Choose how much work to do and which device should handle it.</p>
    <label>Computer<Dropdown ariaLabel="Target computer" value={targetNode} onChange={setTargetNode} options={[{ value: 'local', label: 'This computer' }, ...remoteNodes.map((node) => ({ value: node.node_id, label: node.name, disabled: node.status !== 'online', hint: node.status === 'online' ? null : 'not available' }))]} /></label>
    <label>Processing device<Dropdown ariaLabel="Processing device" disabled={!availableBackends.length} value={form.backend} onChange={(next) => setForm((current) => ({ ...current, backend: next }))} placeholder="No devices on this computer" options={availableBackends.map((backend) => ({ value: backend.backend, label: backendLabel(backend) }))} /></label>
    <label>Amount of work<Dropdown ariaLabel="Amount of work" value={String(form.size)} onChange={(next) => setForm((current) => ({ ...current, size: next }))} options={[{ value: '512', label: 'Small' }, { value: '1024', label: 'Medium' }, { value: '2048', label: 'Large' }]} /></label>
    <div className="advanced-note">HAR will choose the safe measurement settings automatically.</div>
    {submitError && <div className="form-error">{submitError}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={!availableBackends.length}>Start task <span>-&gt;</span></button></div>
  </form></div>
}

function WorkloadRow({ run, onClick, nodes }) { const total = run.request.measured_iterations || 1; const progress = Math.round((run.completed_iterations / total) * 100); return <button className="workload-row" onClick={onClick}><div className="workload-id"><span className={`workload-pulse ${run.status}`} /><div><strong>Matrix calculation</strong><span>{run.request.size} x {run.request.size} · {formatDate(run.created_at)}</span></div></div><div className="row-placement"><BackendBadge backend={run.request.backend} /><span>{nodeLabel(run.node_id, nodes)}</span></div><div className="row-progress"><div className="progress-track"><div style={{ width: `${progress}%` }} /></div><span>{run.status === 'completed' ? '100%' : `${progress}%`}</span></div><StatusBadge status={run.status} /><div className="row-time">{formatDate(run.updated_at)}</div></button> }
function nodeLabel(nodeId, nodes) {
  if (!nodeId || nodeId === 'local') return 'This computer'
  const node = (nodes || []).find((item) => item.node_id === nodeId)
  return node?.name || nodeId
}
function scriptElapsed(script) {
  if (!script.created_at || !script.updated_at) return null
  const seconds = (new Date(script.updated_at) - new Date(script.created_at)) / 1000
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}
function scriptTimings(script) {
  const parse = (value) => value ? new Date(value).getTime() : null
  const created = parse(script.created_at)
  const started = parse(script.started_at)
  const finished = parse(script.finished_at)
  const updated = parse(script.updated_at)
  const toSec = (ms) => (Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null)
  const total = toSec((finished || updated || 0) - (created || 0))
  const queue = toSec((started || finished || updated || 0) - (created || 0))
  const execute = script.remote_execute_seconds != null
    ? script.remote_execute_seconds
    : toSec((finished || updated || 0) - (started || 0))
  const transport = total != null && execute != null && queue != null
    ? Math.max(total - execute - queue, 0)
    : null
  const isRemote = script.target_node && script.target_node !== 'local'
  return { total, queue, execute, transport: isRemote ? transport : 0, isRemote }
}
function formatSecondsShort(seconds) {
  if (seconds == null) return '-'
  if (seconds < 0.001) return `${(seconds * 1e6).toFixed(0)} µs`
  if (seconds < 1) return `${(seconds * 1e3).toFixed(1)} ms`
  return `${seconds.toFixed(2)} s`
}
function ScriptRow({ script, active, onClick, nodes }) {
  const elapsed = scriptElapsed(script)
  const argsText = script.args?.length ? script.args.join(' ') : ''
  return <button type="button" className={`workload-row script-row ${active ? 'active' : ''}`} onClick={onClick}>
    <div className="workload-id"><span className={`workload-pulse ${script.status}`} /><div><strong>{script.filename}</strong><span>{argsText ? `${argsText} · ` : ''}{formatDate(script.created_at)}</span></div></div>
    <div className="row-placement"><span>{nodeLabel(script.target_node, nodes)}</span></div>
    <div className="row-progress"><span>{elapsed != null ? `${elapsed.toFixed(2)} s` : (script.status === 'running' ? 'Running...' : '-')}</span></div>
    <StatusBadge status={script.status} />
    <div className="row-time">{script.exit_code == null ? (script.status === 'failed' ? 'Error' : script.status === 'running' ? 'Running' : 'Pending') : `Exit ${script.exit_code}`}</div>
  </button>
}
function targetMachine(script, devices, nodes) {
  if (!script) return null
  if (script.target_node === 'local') {
    return { name: 'This computer', backends: devices || [], status: 'online' }
  }
  const node = nodes?.find((item) => item.node_id === script.target_node)
  if (!node) return { name: script.target_node, backends: [], status: 'unknown' }
  return { name: node.name, backends: node.capabilities || [], status: node.status }
}
function backendLineLabel(backend, cpuInfo) {
  if (backend?.backend === 'cpu') return cpuLabel(backend, cpuInfo)
  return backend?.device_name || friendlyBackend(backend?.backend)
}
function ScriptDetail({ script, onClose, onRefresh, devices, nodes, cpuInfo }) {
  const elapsed = scriptElapsed(script)
  const hasOutput = Boolean(script.output && script.output.length)
  const machine = targetMachine(script, devices, nodes)
  const isLocal = script.target_node === 'local'
  const machineCpuInfo = isLocal ? cpuInfo : null
  return <section className="panel script-detail">
    <div className="section-heading compact"><div><div className="eyebrow">SCRIPT DETAIL</div><h2>{script.filename}</h2></div><div className="script-detail-actions"><StatusBadge status={script.status} />{onRefresh && <RefreshButton onClick={onRefresh} title="Refresh this script" />}{onClose && <button type="button" className="close-button" onClick={onClose} aria-label="Close script detail">X</button>}</div></div>
    <div className="placement-grid">
      <Placement label="Machine" value={machine?.name || '-'} />
      <Placement label="Started" value={formatDate(script.created_at)} />
      <Placement label="Total time" value={formatSecondsShort(scriptTimings(script).total)} />
      <Placement label={scriptTimings(script).isRemote ? 'Transport' : 'Overhead'} value={formatSecondsShort(scriptTimings(script).transport)} accent={scriptTimings(script).isRemote ? 'transfer' : ''} />
    </div>
    {(() => {
      const timings = scriptTimings(script)
      return <div className="timings-block"><div className="timings-head"><span className="eyebrow">TIMING BREAKDOWN</span></div><div className="timings-grid"><Metric label="Queue wait" value={formatSecondsShort(timings.queue)} /><Metric label={timings.isRemote ? 'Remote execute' : 'Execute'} value={formatSecondsShort(timings.execute)} /><Metric label="Transport" value={formatSecondsShort(timings.transport)} /><Metric label="Total" value={formatSecondsShort(timings.total)} /></div><div className="policy-note"><span className="status-dot preview" /><span>{timings.isRemote ? 'Transport covers host↔worker HTTP + polling. Remote execute comes from the worker’s own clock.' : 'Local runs have near-zero transport. Overhead is queue + runtime setup.'}</span></div></div>
    })()}
    {machine && machine.backends.length ? <div className="hardware-block"><div className="hardware-head"><span className="eyebrow">HARDWARE AVAILABLE ON TARGET</span>{machine.status && machine.status !== 'online' ? <StatusBadge status={machine.status} /> : null}</div><div className="hardware-list">{machine.backends.filter((b) => b.available !== false).map((backend) => <div className="hardware-row" key={backend.backend}><BackendBadge backend={backend.backend} /><div><strong>{backendLineLabel(backend, machineCpuInfo)}</strong><span>{backend.memory?.total_bytes != null ? `${formatBytes(backend.memory.available_bytes)} free / ${formatBytes(backend.memory.total_bytes)}` : (backend.memory?.unavailable_reason || 'Memory unavailable')}</span></div></div>)}</div><div className="policy-note"><span className="status-dot preview" /><span>The script picks which of these to use at runtime. HAR shows every backend available on the target.</span></div></div> : null}
    {script.args?.length ? <div className="script-args"><span className="eyebrow">ARGUMENTS</span><code>{script.args.join(' ')}</code></div> : null}
    {script.error ? <div className="form-error" style={{ marginTop: 14 }}>{script.error}</div> : null}
    <div className="script-output-head"><span className="eyebrow">OUTPUT (STDOUT + STDERR)</span><span>{hasOutput ? `${script.output.length} chars` : (script.status === 'running' ? 'Buffered until exit' : 'No output')}</span></div>
    <pre className="script-output">{hasOutput ? script.output : (script.status === 'running' ? 'Waiting for the script to finish. Output will appear here when it exits.' : (script.status === 'failed' ? (script.error || 'Script failed with no output.') : 'No output.'))}</pre>
  </section>
}
function DeviceCard({ device, onDisconnect }) {
  const memory = device.memory || {}
  const isRemote = typeof device.kind === 'string' && device.kind.startsWith('OTHER COMPUTER') && device.node_id
  return <article className={`panel device-card-large ${device.state}`}>
    <div className="device-card-head"><div><BackendBadge backend={device.backend} /><span className="device-kind">{device.kind}</span></div><div className="device-card-actions"><StatusBadge status={device.state} />{isRemote && onDisconnect && <button type="button" className="secondary-button device-disconnect" onClick={() => onDisconnect({ node_id: device.node_id, name: device.kind?.split('/').pop()?.trim() || device.node_id })}>Disconnect</button>}</div></div>
    <h2>{device.name}</h2>
    <p>{device.detail}</p>
    <div className="device-metrics"><Metric label="Status" value={device.available === false ? 'Not ready' : 'Ready'} /><Metric label="Free space" value={formatBytes(memory.available_bytes)} /></div>
    <div className="util-track large"><div className={`backend-fill ${device.backend}`} style={{ width: memory.total_bytes && memory.available_bytes != null ? `${Math.min((memory.available_bytes / memory.total_bytes) * 100, 100)}%` : '0%' }} /></div>
    <div className="device-workload"><span>SPACE INFORMATION</span><strong>{memory.estimated ? 'Estimated' : memory.measured ? 'Measured' : 'Not available'}</strong></div>
  </article>
}
function TraceRow({ operation }) { return <div className="trace-row"><div className="trace-label"><span className={`trace-dot ${operation.backend}`} /><div><strong>{operation.name}</strong><span>{operation.type}</span></div></div><div className="trace-lane"><div className={`trace-bar ${operation.backend}`} style={{ width: operation.duration_seconds ? '100%' : '40%' }}><span>{operation.backend.toUpperCase()}</span></div></div><div className="trace-value"><strong>{formatDuration(operation.duration_seconds)}</strong><span>{operation.measured ? 'Measured' : 'Unavailable'}</span></div></div> }
function Placement({ label, value, accent }) { return <div><span>{label}</span><strong className={accent || ''}>{value}</strong></div> }
function Metric({ label, value }) { return <div className="small-metric"><span>{label}</span><strong>{value}</strong></div> }
function StatCard({ label, value, detail, accent }) { return <div className={`stat-card ${accent}`}><span className="eyebrow">{label}</span><strong>{value}</strong><span>{detail}</span></div> }
function friendlyBackend(backend) { return { cpu: 'CPU', mps: 'Apple graphics', cuda: 'NVIDIA graphics', network: 'Another computer' }[backend] || backend }
function cpuLabel(device, cpuInfo) {
  const brand = cpuInfo?.brand || device?.details?.cpu_brand || device?.device_name || 'CPU'
  const ghz = cpuInfo?.frequency_ghz ?? device?.details?.frequency_ghz
  return ghz ? `${brand} @ ${ghz} GHz` : brand
}
function deviceHeading(device, cpuInfo) {
  if (device?.backend === 'cpu') return cpuLabel(device, cpuInfo)
  return device?.name || friendlyBackend(device?.backend)
}
function BackendBadge({ backend }) { return <span className={`backend-badge ${backend.toLowerCase()}`}>{friendlyBackend(backend)}</span> }
function StatusBadge({ status }) { return <span className={`status-badge ${status}`}><span className="status-dot" />{status}</span> }
function EmptyState({ title, detail, action, onAction }) { return <div className="empty-state"><strong>{title}</strong><span>{detail}</span>{action && <button className="secondary-button" onClick={onAction}>{action} <span>-&gt;</span></button>}</div> }

createRoot(document.getElementById('root')).render(<App />)

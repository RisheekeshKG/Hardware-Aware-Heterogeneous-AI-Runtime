import React, { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { API } from './api/client.js'
import { PairingPrompt } from './app/PairingPrompt.jsx'
import { RUNTIME_STARTUP_GRACE_MS, navGroups, navItems } from './app/navigation.js'
import { BenchmarksView } from './views/benchmarks/BenchmarksView.jsx'
import { Launcher } from './views/benchmarks/Launcher.jsx'
import { ConnectDevice } from './views/devices/ConnectDevice.jsx'
import { FabricView } from './views/devices/FabricView.jsx'
import { RuntimeView } from './views/overview/RuntimeView.jsx'
import { ScriptLauncher } from './views/scripts/ScriptLauncher.jsx'
import { TracesView } from './views/scripts/TracesView.jsx'
import { WorkloadsView } from './views/scripts/WorkloadsView.jsx'
import { RuntimeSetup } from './views/setup/RuntimeSetup.jsx'

export function App() {
  const [runtimeSetup, setRuntimeSetup] = useState({ checking: true, installed: true, torch_installed: true, error: '' })
  const [torchSetupSkipped, setTorchSetupSkipped] = useState(false)
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
  const [workerConnection, setWorkerConnection] = useState(null)
  const [sessionRole, setSessionRole] = useState(null)
  const lastConnectionStatus = useRef(null)
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
      fetch(`${API}/api/session`).then((response) => response.ok ? response.json() : null).then((data) => setSessionRole(data?.role || null)).catch(() => setSessionRole(null))
      fetch(`${API}/api/worker-connection`)
        // 404 means the installed runtime predates connection status.
        .then((response) => response.status === 404 ? { status: 'unsupported' } : response.ok ? response.json() : null)
        .then((connection) => {
          const previous = lastConnectionStatus.current
          const next = connection?.status || null
          if (previous && previous !== next) {
            if (next === 'connected') notify(`Connected to host ${connection.host_ip}. It can now send tasks to this computer.`)
            else if (next === 'unreachable' && previous === 'connected') notify(`Lost contact with host ${connection.host_ip}. Retrying...`)
            else if (next === 'disconnected') notify('The host disconnected this computer.')
          }
          lastConnectionStatus.current = next
          setWorkerConnection(connection)
        })
        .catch(() => setWorkerConnection(null))
      setRuntime(data)
      setError('')
      connectedOnce.current = true
      setSelectedRunId((current) => current || data.runs[0]?.id || null)
      setLoading(false)
    } catch (requestError) {
      const stillStarting = window.__TAURI_INTERNALS__ && !connectedOnce.current && Date.now() - startedAt.current < RUNTIME_STARTUP_GRACE_MS
      if (stillStarting) return
      setError(window.__TAURI_INTERNALS__
        ? `HAR's background service isn't answering (${requestError.message}). If this doesn't clear in a few seconds, restart the app.`
        : `${requestError.message}. Start the API with "har serve".`)
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

  if (runtimeSetup.checking || !runtimeSetup.installed || (!runtimeSetup.torch_installed && !torchSetupSkipped)) {
    return <RuntimeSetup status={runtimeSetup} onSkip={() => setTorchSetupSkipped(true)} onInstalled={(status) => { startedAt.current = Date.now(); connectedOnce.current = false; setRuntimeSetup({ ...status, checking: false, error: '' }); notify(`PyTorch ${status.torch_version || ''} installed.`) }} />
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">H</div><div><strong>HAR</strong><span>runtime console</span></div></div>
      {navGroups.map((group) => <React.Fragment key={group.id}><div className={`nav-group-label ${group.id === 'devtools' ? 'devtools' : ''}`}>{group.label}</div><nav className="main-nav" aria-label={`${group.label} navigation`}>{navItems.filter((item) => item.group === group.id).map((item) => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => setView(item.id)}><span className="nav-icon">{item.icon}</span><span>{item.label}</span></button>)}</nav></React.Fragment>)}
      <div className="sidebar-spacer" />
      <div className="sidebar-note"><span className="eyebrow">HAR STATUS</span><strong>{error ? 'Needs attention' : 'Ready to help'}</strong><span>{loading ? 'Checking your devices...' : workerConnection?.status === 'connected' ? `Working for host ${workerConnection.host_ip}` : 'Connected to this computer'}</span></div>
      <div className="connection-status"><span className={`status-dot ${error ? 'error' : ''}`} /><span>{error ? 'NOT CONNECTED' : 'CONNECTED'}</span><small>{loading ? 'Checking devices...' : (() => { const machines = (runtime.devices.filter((d) => d.available).length ? 1 : 0) + runtime.nodes.filter((n) => n.name !== 'This device' && n.status === 'online').length; return `${machines} machine${machines === 1 ? '' : 's'} ready` })()}</small></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="breadcrumbs"><span>HAR</span><i>/</i><strong>{pageLabel}</strong></div><div className="topbar-actions"><span className="live-pill"><span className={`status-dot ${error ? 'error' : ''}`} /> {error ? 'Disconnected' : 'Live API'}</span><button className="icon-button" onClick={loadRuntime} aria-label="Refresh runtime">R</button></div></header>
      {error && <div className="api-error"><span className="status-dot error" /><div><strong>HAR cannot connect right now</strong><span>{error}</span></div><button onClick={loadRuntime}>Try again</button></div>}
      {view === 'runtime' && <RuntimeView devices={runtime.devices} nodes={runtime.nodes} runs={runtime.runs} activeRun={activeRun} cpuInfo={cpuInfo} onLaunch={() => setShowLauncher(true)} onNavigate={setView} onSelectRun={setSelectedRunId} />}
      {view === 'workloads' && <WorkloadsView scripts={scripts} selectedScriptId={selectedScriptId} onSelectScript={setSelectedScriptId} onScriptLaunch={() => setShowScriptLauncher(true)} devices={runtime.devices} nodes={runtime.nodes} cpuInfo={cpuInfo} onRefresh={loadRuntime} />}
      {view === 'fabric' && <FabricView devices={runtime.devices} nodes={runtime.nodes} cpuInfo={cpuInfo} trustedHosts={trustedHosts} workerConnection={workerConnection} sessionRole={sessionRole} onConnect={() => setShowConnect(true)} onDisconnect={disconnectNode} onRefresh={loadRuntime} onRevokeTrustedHost={async (ip) => { if (!window.confirm(`Revoke trust for ${ip}? HAR will refuse future jobs from this host.`)) return; try { const r = await fetch(`${API}/api/trusted-hosts/${encodeURIComponent(ip)}`, { method: 'DELETE' }); if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.detail || `HTTP ${r.status}`) } notify(`${ip} is no longer trusted.`); await loadRuntime() } catch (e) { notify(`Could not revoke: ${e.message}`) } }} onStopServing={async () => { const host = workerConnection?.host_ip || 'this host'; if (!window.confirm(`Stop working for ${host}? HAR will stop auto-retrying every 5 seconds. You can accept a new host anytime.`)) return; try { const r = await fetch(`${API}/api/worker-connection/stop`, { method: 'POST' }); if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.detail || `HTTP ${r.status}`) } notify(`Stopped working for ${host}.`); await loadRuntime() } catch (e) { notify(`Could not stop: ${e.message}`) } }} />}
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

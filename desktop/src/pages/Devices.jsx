// Devices: your computers on the left, the selected one's details on the right; adding computers.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { backendTitle, computers, formatBytes, formatRelative, isActive, workloadLabel } from '../helpers.js'
import { ScriptRow } from '../pages/Scripts.jsx'
import { useAction, useNavigation, useRuntime, useToast } from '../state.jsx'
import { ArrowRightIcon, BackendBadge, Button, Field, IconButton, InfoList, MemoryBar, Modal, ModalActions, Pane, PencilIcon, PlusIcon, RefreshIcon, StatusBadge, Workspace } from '../ui.jsx'

const ROLE_NOTE = {
  host: 'This computer is the host and can send scripts to computers you add',
  worker: 'This computer is a worker: a host on your network sends scripts here',
  standalone: 'Standalone: only this computer, not reachable from the network',
}

export function DevicesPage() {
  const { devices, nodes, system, session, refresh } = useRuntime()
  const { deviceId, go, openModal } = useNavigation()
  const role = session?.role
  const list = computers(devices, nodes, system)
  const selected = list.find((computer) => computer.id === deviceId) || list[0]
  const canAdd = role !== 'worker' && role !== 'standalone'
  return <Workspace title="Devices" note={ROLE_NOTE[role] || ''} actions={<>
    <IconButton icon={<RefreshIcon />} label="Refresh" onClick={refresh} />
    <Button variant="text" onClick={() => go('settings')}>Change role</Button>
    {canAdd && <Button variant="primary" icon={<PlusIcon />} onClick={() => openModal('connect')}>Add device</Button>}
  </>}>
    <div className="workspace-split">
      <nav className="split-list" aria-label="Computers">
        <div className="split-list-head"><span className="eyebrow">COMPUTERS</span><span className="chart-meta">{list.length}</span></div>
        <ul className="row-list">{list.map((computer) => <li key={computer.id}>
          <button type="button" className={`list-row ${computer.status} ${computer.id === selected?.id ? 'active' : ''}`} aria-current={computer.id === selected?.id ? 'true' : undefined} onClick={() => go('devices', { deviceId: computer.id })}>
            <span className={`status-dot ${computer.status === 'online' ? '' : 'offline'}`} />
            <span className="list-row-main"><strong>{computer.name}</strong><span>{computer.isLocal ? 'This computer' : computer.status === 'online' ? 'Other computer' : 'Not responding'} · {computer.backends.map((backend) => backend.backend.toUpperCase()).join(' ')}</span></span>
          </button>
        </li>)}</ul>
        {canAdd && <button type="button" className="add-row" onClick={() => openModal('connect')}><PlusIcon /> Add another computer</button>}
      </nav>
      <div className="split-detail">{selected && <ComputerDetail key={selected.id} computer={selected} role={role} />}</div>
    </div>
  </Workspace>
}

function hostSummary(host) {
  if (!host) return null
  const os = host.os?.platform?.startsWith('macOS') ? 'macOS' : host.os?.name === 'Windows' ? 'Windows' : host.os?.name
  return [os, host.architecture?.machine, host.runtime?.python_version && `Python ${host.runtime.python_version}`].filter(Boolean).join(' · ')
}

function ComputerDetail({ computer, role }) {
  return <>
    <ComputerHeader computer={computer} />
    {computer.isLocal && role === 'worker' && <WorkerConnectionPane />}
    {computer.isLocal && role === 'worker' && <TrustedHostsPane />}
    <div className="pane-grid">
      <BackendsPane computer={computer} />
      <CurrentWorkPane computer={computer} />
    </div>
    <SystemPane computer={computer} />
    <EnvironmentPanel computer={computer} />
    <RecentScripts computer={computer} />
  </>
}

function ComputerHeader({ computer }) {
  const { go } = useNavigation()
  const { refresh } = useRuntime()
  const notify = useToast()
  const action = useAction()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(computer.name)
  const [saving, setSaving] = useState(false)

  const save = async (event) => {
    event.preventDefault()
    const next = name.trim()
    if (!next || next === computer.name) { setRenaming(false); return }
    setSaving(true)
    try {
      await api.renameNode(computer.id, next)
      notify(`Renamed to ${next}.`)
      setRenaming(false)
      await refresh()
    } catch (error) { notify(`Could not rename: ${error.message}`) } finally { setSaving(false) }
  }
  const disconnect = async () => {
    const done = await action({
      confirm: { title: `Disconnect ${computer.name}?`, message: 'HAR will stop sending tasks to it. Anything running there now is marked failed. You can add it again later.', confirmLabel: 'Disconnect' },
      run: () => api.disconnectNode(computer.id).catch((error) => { if (error.status !== 404) throw error }),
      success: `${computer.name} disconnected.`,
      failure: 'Could not disconnect',
    })
    if (done) go('devices', { deviceId: null })
  }

  return <div className="detail-head">
    <div className="detail-title">
      {renaming
        ? <form className="rename-form" onSubmit={save}>
            <input aria-label="New name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus disabled={saving} />
            <Button type="submit" variant="primary" disabled={saving || !name.trim()}>Save</Button>
            <Button onClick={() => { setRenaming(false); setName(computer.name) }} disabled={saving}>Cancel</Button>
          </form>
        : <h2>{computer.name}{!computer.isLocal && <IconButton icon={<PencilIcon />} label="Rename" className="inline-icon" onClick={() => { setName(computer.name); setRenaming(true) }} />}</h2>}
      <span>{[computer.isLocal ? 'This computer' : 'Other computer', hostSummary(computer.host), !computer.isLocal && computer.node?.base_url].filter(Boolean).join(' · ')}</span>
    </div>
    <div className="detail-actions">
      <StatusBadge status={computer.status} />
      {!computer.isLocal && <Button variant="danger" onClick={disconnect}>Disconnect</Button>}
    </div>
  </div>
}

function BackendsPane({ computer }) {
  const { cpuInfo } = useRuntime()
  return <Pane title="BACKENDS" meta={computer.backends.length}>
    {computer.backends.length ? <div className="backend-rows">{computer.backends.map((backend) => <div className="backend-row" key={backend.backend}>
      <BackendBadge backend={backend.backend} />
      <div className="backend-row-main">
        <strong>{backendTitle(backend, computer.isLocal ? cpuInfo : null)}</strong>
        <span>{backend.memory?.total_bytes != null ? `${formatBytes(backend.memory.available_bytes)} free of ${formatBytes(backend.memory.total_bytes)} · ${backend.memory.estimated ? 'estimated' : 'measured'}` : (backend.memory?.unavailable_reason || 'Memory unknown')}</span>
        <MemoryBar memory={backend.memory} backend={backend.backend} />
      </div>
    </div>)}</div> : <p className="pane-empty">This computer reported no usable backends.</p>}
  </Pane>
}

// Derived from the script and benchmark lists: the heartbeat's active_job is not reliable.
function CurrentWorkPane({ computer }) {
  const { scripts, runs } = useRuntime()
  const { go } = useNavigation()
  const target = (value) => (value || 'local') === computer.id
  const activeScripts = scripts.filter((script) => target(script.target_node) && isActive(script.status))
  const activeRuns = runs.filter((run) => target(run.node_id) && isActive(run.status))
  const count = activeScripts.length + activeRuns.length
  return <Pane title="RIGHT NOW" meta={count ? `${count} running` : 'idle'}>
    {count ? <ul className="row-list">
      {activeScripts.map((script) => <li key={script.id}><button type="button" className="list-row" onClick={() => go('scripts', { scriptId: script.id })}><span className={`workload-pulse ${script.status}`} /><span className="list-row-main"><strong>{script.filename}</strong><span>script</span></span><StatusBadge status={script.status} /></button></li>)}
      {activeRuns.map((run) => <li key={run.id}><button type="button" className="list-row" onClick={() => go('benchmarks', { runId: run.id })}><span className={`workload-pulse ${run.status}`} /><span className="list-row-main"><strong>{workloadLabel(run.request)}</strong><span>benchmark</span></span><StatusBadge status={run.status} /></button></li>)}
    </ul> : <p className="pane-empty">Nothing is running on {computer.isLocal ? 'this computer' : computer.name}.</p>}
    {!computer.isLocal && computer.node?.last_seen && <p className="detail-note">Last heard from {formatRelative(computer.node.last_seen)}.</p>}
  </Pane>
}

function SystemPane({ computer }) {
  const host = computer.host
  if (!host) return null
  const rows = [
    ['Hostname', host.hostname],
    ['Operating system', host.os?.platform || [host.os?.name, host.os?.release].filter(Boolean).join(' ')],
    ['Architecture', host.architecture?.machine],
    ['CPU cores', host.cpu?.logical_cores && `${host.cpu.logical_cores} logical${host.cpu.physical_cores ? ` · ${host.cpu.physical_cores} physical` : ''}`],
    ['Memory', host.memory?.total_bytes && `${formatBytes(host.memory.available_bytes)} free of ${formatBytes(host.memory.total_bytes)}`],
    ['Python', host.runtime?.python_version],
    ['PyTorch', host.runtime ? (host.runtime.pytorch_version || 'Not installed') : null],
    ['CUDA', host.runtime ? (host.runtime.cuda_runtime || 'Not available') : null],
  ].filter(([, value]) => value)
  return <Pane title="SYSTEM"><InfoList rows={rows} /></Pane>
}

// Remote: compare its Python packages with this host's. Fetched on open and on
// "Check again" only — the call waits on the other computer for up to 5 s.
function EnvironmentPanel({ computer }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' })
  const check = useCallback(() => {
    setState((current) => ({ ...current, loading: true, error: '' }))
    const request = computer.isLocal ? api.envHash() : api.nodeEnvHash(computer.id)
    request.then((data) => setState({ loading: false, data, error: '' })).catch((error) => setState({ loading: false, data: null, error: error.message }))
  }, [computer.id, computer.isLocal])
  useEffect(() => { check() }, [check])

  const { loading, data, error } = state
  const packages = computer.isLocal ? data?.packages : data?.worker?.packages
  const hostPackages = computer.isLocal ? null : data?.host?.packages
  const verdict = computer.isLocal ? null : data ? (data.compatible ? 'Matches this host' : `${data.mismatches.length} difference${data.mismatches.length === 1 ? '' : 's'}`) : null
  return <Pane title="PYTHON PACKAGES" meta={computer.isLocal ? 'used by HAR here' : verdict || 'compared with this host'} actions={<Button variant="text" onClick={check} disabled={loading}>{loading ? 'Checking…' : 'Check again'}</Button>}>
    {error && <div className="form-error">Could not check: {error}</div>}
    {!computer.isLocal && data && !data.compatible && <p className="detail-note warn">Scripts that work here may fail there. Install the same versions on both computers.</p>}
    {packages && <table className="env-table">
      <thead><tr><th>Package</th><th>{computer.isLocal ? 'Version' : computer.name}</th>{hostPackages && <th>This host</th>}</tr></thead>
      <tbody>
        <tr><td>python</td><td>{computer.isLocal ? data.python : data.worker.python}</td>{hostPackages && <td className={data.host.python !== data.worker.python ? 'mismatch' : ''}>{data.host.python}</td>}</tr>
        {Object.entries(packages).map(([name, version]) => <tr key={name}><td>{name}</td><td>{version}</td>{hostPackages && <td className={hostPackages[name] !== version ? 'mismatch' : ''}>{hostPackages[name] ?? 'absent'}</td>}</tr>)}
      </tbody>
    </table>}
  </Pane>
}

function RecentScripts({ computer }) {
  const { scripts } = useRuntime()
  const mine = scripts.filter((script) => (script.target_node || 'local') === computer.id).slice(0, 8)
  if (!mine.length) return null
  return <Pane title="RECENT SCRIPTS HERE" meta={mine.length}>
    <div className="script-list">{mine.map((script) => <ScriptRow key={script.id} script={script} />)}</div>
  </Pane>
}

export function AddDeviceDialog({ onClose }) {
  const { refresh } = useRuntime()
  const notify = useToast()
  const onConnected = async () => { onClose(); notify('Device connection requested.'); await refresh() }
  const [workerUrl, setWorkerUrl] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [discovered, setDiscovered] = useState([])
  const [scanning, setScanning] = useState(false)
  const [scannedOnce, setScannedOnce] = useState(false)

  const scan = useCallback(async () => {
    setScanning(true); setError('')
    try {
      setDiscovered(await api.discovery())
      setScannedOnce(true)
    } catch (scanError) { setError(`Could not scan the network: ${scanError.message}`) } finally { setScanning(false) }
  }, [])

  useEffect(() => { scan() }, [scan])

  const connectDiscovered = async (node) => {
    setWaiting(true); setError('')
    try {
      await api.connectDiscovered({ node_id: node.node_id, name: name.trim() || node.name || null })
      await onConnected()
    } catch (connectError) { setError(connectError.message) } finally { setWaiting(false) }
  }

  const submit = async (event) => {
    event.preventDefault(); setError('')
    if (!workerUrl.trim()) { setError("Scan the network above, or type an address."); return }
    setWaiting(true)
    try {
      await api.connectNode({ worker_url: workerUrl.trim(), name: name.trim() || null })
      await onConnected()
    } catch (connectError) { setError(connectError.message) } finally { setWaiting(false) }
  }

  return <Modal eyebrow="ADD DEVICE" title="Connect another computer" onClose={onClose} onSubmit={submit} className="connect-modal">
    <p>HAR workers broadcast themselves on the LAN. Pick one from the scan below, or paste an address if you already know it.</p>

    <div className="section-heading compact" style={{ marginTop: 18 }}><div><span className="eyebrow">HAR USERS ON YOUR NETWORK</span></div><Button variant="text" onClick={scan} disabled={scanning}>{scanning ? 'Scanning…' : 'Scan again'}</Button></div>
    {discovered.length ? <div className="discovered-list">{discovered.map((node) => <div className="discovered-row" key={node.node_id}><div><strong>{node.name || node.node_id}</strong><span>{node.base_url || node.address || node.node_id}</span></div><Button onClick={() => connectDiscovered(node)} disabled={waiting}>Connect</Button></div>)}</div> : <div className="empty-copy">{scannedOnce ? 'No HAR workers found on the LAN. Make sure the other computer is set to Worker.' : 'Scanning for HAR workers...'}</div>}

    <div className="section-heading compact" style={{ marginTop: 22 }}><div><span className="eyebrow">OR CONNECT BY ADDRESS</span></div></div>
    <Field label="Device address"><input value={workerUrl} onChange={(event) => setWorkerUrl(event.target.value)} placeholder="192.168.1.25:9000" disabled={waiting} spellCheck={false} /></Field>
    <Field label="Nickname" optional><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Office computer" /></Field>
    <div className="advanced-note">{waiting ? 'Waiting for someone to click Accept on the other computer (up to 2 minutes)...' : 'Set the other computer to Worker on its Devices page. After you connect, click Accept there.'}</div>
    {error && <div className="form-error">{error}</div>}
    <ModalActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={waiting || !workerUrl.trim()} iconAfter={<ArrowRightIcon />}>{waiting ? 'Waiting for approval…' : 'Connect by address'}</Button></ModalActions>
  </Modal>
}

function WorkerConnectionPane() {
  const { workerConnection: connection } = useRuntime()
  const action = useAction()
  if (!connection) return null
  const host = connection.host_ip
  const onStopServing = () => action({
    confirm: { title: `Stop working for ${host || 'this host'}?`, message: 'HAR stops reconnecting to it every 5 seconds. You can accept a new host at any time.', confirmLabel: 'Stop working for it' },
    run: api.stopServingHost,
    success: `Stopped working for ${host || 'this host'}.`,
    failure: 'Could not stop',
  })
  if (connection.status === 'unsupported') {
    return <Pane title="WORKING FOR"><p className="pane-empty">The installed runtime is older than this app, so it can't report which host is connected.</p></Pane>
  }
  const ago = (seconds) => seconds == null ? '' : seconds < 2 ? 'just now' : `${Math.round(seconds)}s ago`
  const jobs = connection.jobs_received ? ` · ${connection.jobs_received} task${connection.jobs_received === 1 ? '' : 's'} received${connection.running_jobs ? `, ${connection.running_jobs} running` : ''}` : ''
  const views = {
    connected: { dot: '', title: `Connected to host ${host}`, detail: `Last contact ${ago(connection.seconds_since_contact)}${jobs}.` },
    unreachable: { dot: 'error', title: `Can't reach host ${host}`, detail: `${connection.last_error ? `${connection.last_error}. ` : ''}Retrying every 5 seconds. Check that the host is running HAR and both computers are on the same network.` },
    waiting: { dot: 'warn', title: 'Waiting for a host', detail: "No host is connected yet. On the host, choose Add device and enter this computer's address." },
    disconnected: { dot: 'warn', title: 'The host disconnected this computer', detail: 'Add this computer again on the host to reconnect.' },
  }
  const view = views[connection.status] || views.waiting
  return <Pane title="WORKING FOR" actions={connection.coordinator ? <Button variant="text" className="danger-text" onClick={onStopServing}>Stop working for this host</Button> : null}>
    <div className="connection-line"><span className={`status-dot ${view.dot}`} /><div><strong>{view.title}</strong><span>{view.detail}</span></div></div>
  </Pane>
}

function TrustedHostsPane() {
  const { trustedHosts: hosts } = useRuntime()
  const action = useAction()
  if (!hosts || hosts.length === 0) return null
  const onRevoke = (ip) => action({
    confirm: { title: `Revoke trust for ${ip}?`, message: 'HAR will refuse any future tasks from that host until you accept it again.', confirmLabel: 'Revoke' },
    run: () => api.revokeTrustedHost(ip),
    success: `${ip} is no longer trusted.`,
    failure: 'Could not revoke',
  })
  return <Pane title="HOSTS THAT CAN SEND TASKS HERE" meta={hosts.length}>
    <p className="detail-note">Each of these was accepted before and can run Python on this computer. Revoke any you don't recognise.</p>
    <ul className="row-list">{hosts.map((host) => <li key={host.client_ip} className="host-row"><strong>{host.client_ip}</strong><Button variant="text" className="danger-text" onClick={() => onRevoke(host.client_ip)}>Revoke</Button></li>)}</ul>
  </Pane>
}

export function PairingPrompt({ request }) {
  const { dropPairing, refresh } = useRuntime()
  const notify = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const decide = async (decision) => {
    setBusy(true); setError('')
    try {
      await api.decidePairing(request.id, decision)
      dropPairing(request.id)
      notify(decision === 'accept' ? 'Connection accepted. This computer will now take tasks from that host.' : 'Connection declined.')
      refresh()
    } catch (decideError) { setError(decideError.message); setBusy(false) }
  }
  const host = (() => { try { return new URL(request.coordinator).hostname } catch { return request.client_ip } })()
  return <Modal role="alertdialog" eyebrow="CONNECTION REQUEST" title="Allow another computer to use this one?" className="pairing-modal">
    <p>The HAR host at <strong>{host}</strong> wants to send tasks to this computer. Accepting lets it run Python files and benchmarks here. Only accept computers you trust.</p>
    <div className="setup-detail"><span>Request from</span><strong>{request.client_ip}</strong></div>
    {error && <div className="form-error">{error}</div>}
    <ModalActions><Button onClick={() => decide('decline')} disabled={busy}>Decline</Button><Button variant="primary" onClick={() => decide('accept')} disabled={busy} iconAfter={<ArrowRightIcon />}>Accept</Button></ModalActions>
  </Modal>
}

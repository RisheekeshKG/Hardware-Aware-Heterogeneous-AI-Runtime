// Devices: one card per computer, a detail page for each, adding computers, worker connection.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { backendTitle, computers, formatBytes, formatRelative, isActive, workloadLabel } from '../helpers.js'
import { ScriptRow } from '../pages/Scripts.jsx'
import { useAction, useNavigation, useRuntime, useToast } from '../state.jsx'
import { ArrowRightIcon, BackendBadge, Button, EmptyState, Field, MemoryBar, Modal, ModalActions, PageHeader, PlusIcon, RefreshButton, SectionHeading, StatusBadge } from '../ui.jsx'

const ROLE_LINE = {
  host: 'This computer is the host: it runs scripts and can send them to computers you add.',
  worker: 'This computer is a worker: a host on your network can send scripts here.',
  standalone: 'This computer is standalone: it only runs its own scripts and is not reachable from the network.',
}

export function DevicesPage() {
  const { devices, nodes, system, session, refresh } = useRuntime()
  const { go, openModal } = useNavigation()
  const role = session?.role
  const list = computers(devices, nodes, system)
  const canAdd = role !== 'worker' && role !== 'standalone'
  return <>
    <PageHeader eyebrow="DEVICES" title="Devices" description="The computers HAR can send work to, and what each one can run on." action={<div className="header-actions"><RefreshButton onClick={refresh} title="Refresh devices" />{canAdd && <Button variant="primary" icon={<PlusIcon />} onClick={() => openModal('connect')}>Add device</Button>}</div>} />
    {role && <div className="role-summary"><span>{ROLE_LINE[role] || `Role: ${role}`}</span><Button variant="text" iconAfter={<ArrowRightIcon />} onClick={() => go('settings')}>Change role</Button></div>}
    {role === 'worker' && <WorkerConnectionPanel />}
    {role === 'worker' && <TrustedHostsPanel />}
    <section className="computer-grid">
      {list.map((computer) => <ComputerCard key={computer.id} computer={computer} footer={<Button variant="text" iconAfter={<ArrowRightIcon />} onClick={() => go('device', { deviceId: computer.id })}>Details</Button>} />)}
      {canAdd && list.length === 1 && <button type="button" className="add-computer-card" onClick={() => openModal('connect')}>
        <PlusIcon /><strong>Add another computer</strong><span>Set HAR to Worker on the other computer, then connect it here. Both must be on the same network.</span>
      </button>}
    </section>
  </>
}

function hostSummary(host) {
  if (!host) return null
  const os = host.os?.platform?.startsWith('macOS') ? 'macOS' : host.os?.name === 'Windows' ? 'Windows' : host.os?.name
  return [os, host.architecture?.machine, host.runtime?.python_version && `Python ${host.runtime.python_version}`].filter(Boolean).join(' · ')
}

// One card per computer, with one row per backend it can run on.
function ComputerCard({ computer, footer }) {
  const { cpuInfo } = useRuntime()
  const action = useAction()
  const disconnect = () => action({
    confirm: { title: `Disconnect ${computer.name}?`, message: 'HAR will stop sending tasks to it. Anything running there now is marked failed. You can add it again later.', confirmLabel: 'Disconnect' },
    run: () => api.disconnectNode(computer.id).catch((error) => { if (error.status !== 404) throw error }),
    success: `${computer.name} disconnected.`,
    failure: 'Could not disconnect',
  })
  return <article className={`panel computer-card ${computer.status}`}>
    <div className="computer-card-head">
      <div><span className="eyebrow">{computer.isLocal ? 'THIS COMPUTER' : 'OTHER COMPUTER'}</span><h2>{computer.name}</h2>{hostSummary(computer.host) && <p>{hostSummary(computer.host)}</p>}</div>
      <StatusBadge status={computer.status} />
    </div>
    <div className="backend-rows">
      {computer.backends.length ? computer.backends.map((backend) => <div className="backend-row" key={backend.backend}>
        <BackendBadge backend={backend.backend} />
        <div className="backend-row-main">
          <strong>{backendTitle(backend, computer.isLocal ? cpuInfo : null)}</strong>
          <span>{backend.memory?.total_bytes != null ? `${formatBytes(backend.memory.available_bytes)} free of ${formatBytes(backend.memory.total_bytes)}${backend.memory.estimated ? ' (estimate)' : ''}` : 'Memory unknown'}</span>
          <MemoryBar memory={backend.memory} backend={backend.backend} />
        </div>
      </div>) : <p className="empty-copy">No usable backends reported.</p>}
    </div>
    <div className="computer-card-foot">
      {!computer.isLocal && <Button variant="text" className="danger-text" onClick={disconnect}>Disconnect</Button>}
      {footer}
    </div>
  </article>
}

export function DeviceDetailPage() {
  const { deviceId, go } = useNavigation()
  const { devices, nodes, system } = useRuntime()
  const computer = computers(devices, nodes, system).find((item) => item.id === deviceId)
  if (!computer) {
    return <>
      <PageHeader eyebrow="DEVICES" title="Device not found" description="It was disconnected, or HAR restarted and it hasn't reconnected yet." />
      <EmptyState title="Nothing to show" detail="Go back to the device list to see what is connected now." action="Back to devices" onAction={() => go('devices')} />
    </>
  }
  return <>
    <PageHeader eyebrow={computer.isLocal ? 'THIS COMPUTER' : 'OTHER COMPUTER'} title={computer.name} description={hostSummary(computer.host) || (computer.isLocal ? '' : computer.node?.base_url)} action={<DeviceActions computer={computer} />} />
    <div className="device-detail-grid">
      <BackendsPanel computer={computer} />
      <CurrentWorkPanel computer={computer} />
    </div>
    <HostPanel computer={computer} />
    <EnvironmentPanel computer={computer} />
    <RecentScripts computer={computer} />
  </>
}

function DeviceActions({ computer }) {
  const { go } = useNavigation()
  const { refresh } = useRuntime()
  const notify = useToast()
  const action = useAction()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(computer.name)
  const [saving, setSaving] = useState(false)
  if (computer.isLocal) return <StatusBadge status={computer.status} />

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
    if (done) go('devices')
  }

  if (renaming) {
    return <form className="rename-form" onSubmit={save}>
      <input aria-label="New name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus disabled={saving} />
      <Button type="submit" variant="primary" disabled={saving || !name.trim()}>Save</Button>
      <Button onClick={() => { setRenaming(false); setName(computer.name) }} disabled={saving}>Cancel</Button>
    </form>
  }
  return <div className="header-actions">
    <StatusBadge status={computer.status} />
    <Button onClick={() => { setName(computer.name); setRenaming(true) }}>Rename</Button>
    <Button variant="danger" onClick={disconnect}>Disconnect</Button>
  </div>
}

function BackendsPanel({ computer }) {
  const { cpuInfo } = useRuntime()
  return <section className="panel device-panel">
    <SectionHeading compact eyebrow="BACKENDS" title={`${computer.backends.length} available`} />
    <div className="backend-rows">{computer.backends.length ? computer.backends.map((backend) => <div className="backend-row" key={backend.backend}>
      <BackendBadge backend={backend.backend} />
      <div className="backend-row-main">
        <strong>{backendTitle(backend, computer.isLocal ? cpuInfo : null)}</strong>
        <span>{backend.memory?.total_bytes != null ? `${formatBytes(backend.memory.available_bytes)} free of ${formatBytes(backend.memory.total_bytes)} · ${backend.memory.estimated ? 'estimated' : 'measured'}` : (backend.memory?.unavailable_reason || 'Memory unknown')}</span>
        <MemoryBar memory={backend.memory} backend={backend.backend} />
      </div>
    </div>) : <p className="empty-copy">This computer reported no usable backends.</p>}</div>
  </section>
}

// Derived from the script and benchmark lists: the heartbeat's active_job is not reliable.
function CurrentWorkPanel({ computer }) {
  const { scripts, runs } = useRuntime()
  const { go } = useNavigation()
  const target = (value) => (value || 'local') === computer.id
  const activeScripts = scripts.filter((script) => target(script.target_node) && isActive(script.status))
  const activeRuns = runs.filter((run) => target(run.node_id) && isActive(run.status))
  const count = activeScripts.length + activeRuns.length
  return <section className="panel device-panel">
    <SectionHeading compact eyebrow="RIGHT NOW" title={count ? `${count} running` : 'Idle'} />
    {count ? <ul className="work-list">
      {activeScripts.map((script) => <li key={script.id}><button type="button" onClick={() => go('scripts', { scriptId: script.id })}><span className={`workload-pulse ${script.status}`} /><strong>{script.filename}</strong><span>script · {script.status}</span></button></li>)}
      {activeRuns.map((run) => <li key={run.id}><button type="button" onClick={() => go('benchmarks', { runId: run.id })}><span className={`workload-pulse ${run.status}`} /><strong>{workloadLabel(run.request)}</strong><span>benchmark · {run.status}</span></button></li>)}
    </ul> : <p className="empty-copy">Nothing is running on {computer.isLocal ? 'this computer' : computer.name}.</p>}
    {!computer.isLocal && computer.node?.last_seen && <p className="detail-note">Last heard from {formatRelative(computer.node.last_seen)}.</p>}
  </section>
}

function HostPanel({ computer }) {
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
    ['Address', computer.isLocal ? null : computer.node?.base_url],
  ].filter(([, value]) => value)
  return <section className="panel settings-panel">
    <SectionHeading compact eyebrow="SYSTEM" title="Hardware and software" />
    <dl className="settings-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </section>
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
  return <section className="panel settings-panel">
    <SectionHeading compact eyebrow="PYTHON ENVIRONMENT" title={computer.isLocal ? 'Packages HAR uses' : verdict || 'Compared with this host'} action={<Button variant="text" onClick={check} disabled={loading}>{loading ? 'Checking…' : 'Check again'}</Button>} />
    {error && <div className="form-error">Could not check: {error}</div>}
    {!computer.isLocal && data && !data.compatible && <p className="detail-note warn">Scripts that work here may fail there. Install the same versions on both computers.</p>}
    {packages && <table className="env-table">
      <thead><tr><th>Package</th><th>{computer.isLocal ? 'Version' : computer.name}</th>{hostPackages && <th>This host</th>}</tr></thead>
      <tbody>
        <tr><td>python</td><td>{computer.isLocal ? data.python : data.worker.python}</td>{hostPackages && <td className={data.host.python !== data.worker.python ? 'mismatch' : ''}>{data.host.python}</td>}</tr>
        {Object.entries(packages).map(([name, version]) => <tr key={name}><td>{name}</td><td>{version}</td>{hostPackages && <td className={hostPackages[name] !== version ? 'mismatch' : ''}>{hostPackages[name] ?? 'absent'}</td>}</tr>)}
      </tbody>
    </table>}
  </section>
}

function RecentScripts({ computer }) {
  const { scripts } = useRuntime()
  const mine = scripts.filter((script) => (script.target_node || 'local') === computer.id).slice(0, 8)
  if (!mine.length) return null
  return <section className="section-block">
    <SectionHeading eyebrow="RECENT" title={`Scripts on ${computer.isLocal ? 'this computer' : computer.name}`} />
    <div className="script-list">{mine.map((script) => <ScriptRow key={script.id} script={script} />)}</div>
  </section>
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

function WorkerConnectionPanel() {
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
    return <section className="panel worker-connection"><span className="status-dot warn" /><div><strong>Connection status needs a newer runtime</strong><span>The installed runtime is older than this app, so it can't report which host is connected. Update the runtime to see it here.</span></div></section>
  }
  const ago = (seconds) => seconds == null ? '' : seconds < 2 ? 'just now' : `${Math.round(seconds)}s ago`
  const jobs = connection.jobs_received ? ` · ${connection.jobs_received} task${connection.jobs_received === 1 ? '' : 's'} received${connection.running_jobs ? `, ${connection.running_jobs} running` : ''}` : ''
  const views = {
    connected: { dot: '', title: `Connected to host ${host}`, detail: `Last contact ${ago(connection.seconds_since_contact)}${jobs}. This computer is ready to take tasks from it.` },
    unreachable: { dot: 'error', title: `Can't reach host ${host}`, detail: `${connection.last_error ? `${connection.last_error}. ` : ''}Retrying every 5 seconds. Check that the host is running HAR and both computers are on the same network.` },
    waiting: { dot: 'warn', title: 'Waiting for a host', detail: "No host is connected yet. On the host, choose Add device and enter this PC's address." },
    disconnected: { dot: 'warn', title: 'The host disconnected this computer', detail: 'It will stop sending tasks. Add this computer again on the host to reconnect.' },
  }
  const view = views[connection.status] || views.waiting
  const hasHost = Boolean(connection.coordinator)
  return <section className="panel worker-connection"><span className={`status-dot ${view.dot}`} /><div><span className="eyebrow">WORKING FOR</span><strong>{view.title}</strong><span>{view.detail}</span></div>{hasHost && <button type="button" className="secondary-button device-disconnect worker-stop-serving" onClick={onStopServing}>Stop working for this host</button>}</section>
}

function TrustedHostsPanel() {
  const { trustedHosts: hosts } = useRuntime()
  const action = useAction()
  if (!hosts || hosts.length === 0) return null
  const onRevoke = (ip) => action({
    confirm: { title: `Revoke trust for ${ip}?`, message: 'HAR will refuse any future tasks from that host until you accept it again.', confirmLabel: 'Revoke' },
    run: () => api.revokeTrustedHost(ip),
    success: `${ip} is no longer trusted.`,
    failure: 'Could not revoke',
  })
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

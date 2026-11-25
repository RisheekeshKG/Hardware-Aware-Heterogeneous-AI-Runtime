import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/endpoints.js'
import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { useToast } from '../../app/ToastProvider.jsx'
import { Button } from '../../components/Button.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { MemoryBar } from '../../components/MemoryBar.jsx'
import { PageHeader } from '../../components/PageHeader.jsx'
import { SectionHeading } from '../../components/SectionHeading.jsx'
import { BackendBadge, StatusBadge } from '../../components/badges.jsx'
import { useAction } from '../../hooks/useAction.js'
import { backendTitle, computers } from '../../lib/devices.js'
import { formatBytes, formatRelative } from '../../lib/format.js'
import { isActive, workloadLabel } from '../../lib/runs.js'
import { ScriptRow } from '../scripts/ScriptRow.jsx'
import { hostSummary } from './ComputerCard.jsx'

export function DeviceDetailView() {
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

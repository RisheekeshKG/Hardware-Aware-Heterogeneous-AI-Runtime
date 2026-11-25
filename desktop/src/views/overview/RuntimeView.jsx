import { EmptyState } from '../../components/EmptyState.jsx'
import { PageHeader } from '../../components/PageHeader.jsx'
import { BackendBadge, StatusBadge } from '../../components/badges.jsx'
import { Placement, StatCard } from '../../components/metrics.jsx'
import { cpuLabel, friendlyBackend } from '../../lib/devices.js'
import { formatBytes, formatDate, formatDuration } from '../../lib/format.js'
import { WorkloadRow } from '../benchmarks/WorkloadRow.jsx'

export function RuntimeView({ devices, nodes, runs, activeRun, cpuInfo, onLaunch, onNavigate, onSelectRun }) {
  const availableDevices = devices.filter((device) => device.available)
  const onlineNodes = nodes.filter((node) => node.status === 'online' && node.name !== 'This device')
  const runningCount = runs.filter((run) => run.status === 'running').length
  const queuedCount = runs.filter((run) => run.status === 'queued').length
  return <>
    <PageHeader eyebrow="HAR" title="Overview" description="See what is running and which devices are available to help." action={<button className="primary-button" onClick={onLaunch}><span>+</span> Start a task</button>} />
    <section className="stat-grid"><StatCard label="Tasks in progress" value={String(runningCount + queuedCount).padStart(2, '0')} detail={`${runningCount} running · ${queuedCount} waiting`} accent="lime" /><StatCard label="Devices available" value={String((availableDevices.length ? 1 : 0) + onlineNodes.length).padStart(2, '0')} detail={`${availableDevices.length + onlineNodes.reduce((sum, node) => sum + node.capabilities.filter((capability) => capability.available !== false).length, 0)} runtimes across your machines`} accent="blue" /><StatCard label="System status" value={devices.length ? 'Ready' : 'Waiting'} detail={devices.length ? 'Everything is responding' : 'Looking for devices'} accent="green" /><StatCard label="Finished tasks" value={String(runs.filter((run) => run.status === 'completed').length).padStart(2, '0')} detail="Completed successfully" accent="amber" /></section>
    <section className="runtime-grid"><ActiveWorkload run={activeRun} onTrace={() => { if (activeRun) { onSelectRun(activeRun.id); onNavigate('benchmarks') } }} /><FabricSummary devices={devices} nodes={nodes} cpuInfo={cpuInfo} onOpen={() => onNavigate('fabric')} /></section>
    <section className="section-block"><div className="section-heading"><div><div className="eyebrow">RECENT ACTIVITY</div><h2>Recent benchmark runs</h2></div><button className="text-button" onClick={() => onNavigate('benchmarks')}>Open benchmarks <span>-&gt;</span></button></div>{runs.length ? <div className="workload-list">{runs.slice(0, 8).map((run) => <WorkloadRow key={run.id} run={run} nodes={nodes} onClick={() => { onSelectRun(run.id); onNavigate('benchmarks') }} />)}</div> : <EmptyState title="No benchmark runs yet" detail="Benchmarks are optional dev tools. Scripts are the main workflow." action="Open scripts" onAction={() => onNavigate('workloads')} />}</section>
  </>
}

export function ActiveWorkload({ run, onTrace }) {
  if (!run) return <article className="panel active-workload-panel"><div className="eyebrow">CURRENT TASK</div><h2>Nothing is running</h2><p className="empty-copy">HAR is ready. Start a task to see its progress here.</p><button className="secondary-button" onClick={onTrace}>No activity yet</button></article>
  const total = run.request.measured_iterations || 1
  const progress = Math.round((run.completed_iterations / total) * 100)
  return <article className="panel active-workload-panel"><div className="panel-top"><div><div className="eyebrow">CURRENT TASK</div><h2>Matrix calculation</h2></div><StatusBadge status={run.status} /></div><div className="workload-meta"><span>{run.request.size} x {run.request.size} calculation</span><span>{run.request.measured_iterations} checks</span><span>{formatDate(run.created_at)}</span></div><div className="execution-line"><div className="execution-line-head"><span>Progress</span><strong>{run.last_latency_seconds ? formatDuration(run.last_latency_seconds) : 'Waiting'}</strong></div><div className="progress-track"><div style={{ width: `${progress}%` }} /></div><div className="execution-line-foot"><span>{run.completed_iterations} / {total} checks</span><span>{run.status}</span></div></div><div className="placement-grid"><Placement label="Choice" value={friendlyBackend(run.request.backend)} accent={run.request.backend} /><Placement label="Device" value={run.node_id === 'local' ? 'This computer' : run.node_id} /><Placement label="Result" value={run.result ? (run.result.correctness_passed ? 'Good' : 'Check failed') : 'Pending'} /></div><button className="secondary-button" onClick={onTrace}>See task details <span>-&gt;</span></button></article>
}

export function FabricSummary({ devices, nodes, cpuInfo, onOpen }) {
  const visibleNodes = nodes.filter((node) => node.name !== 'This device')
  const localAvailable = devices.filter((device) => device.available)
  const machinesReady = (localAvailable.length ? 1 : 0) + visibleNodes.filter((node) => node.status === 'online').length
  const runtimesReady = localAvailable.length + visibleNodes.filter((node) => node.status === 'online').reduce((sum, node) => sum + node.capabilities.filter((capability) => capability.available !== false).length, 0)
  return <article className="panel fabric-summary"><div className="section-heading compact"><div><div className="eyebrow">YOUR DEVICES</div><h2>Device status</h2></div><span className="online-count"><span className="status-dot" /> {machinesReady} device{machinesReady === 1 ? '' : 's'} · {runtimesReady} runtime{runtimesReady === 1 ? '' : 's'}</span></div><div className="mini-devices">{localAvailable.slice(0, 3).map((device) => <DeviceSummary key={device.backend} device={device} cpuInfo={cpuInfo} />)}{!localAvailable.length && <div className="empty-copy">No devices are ready yet.</div>}</div><button className="secondary-button" onClick={onOpen}>See all devices <span>-&gt;</span></button></article>
}
export function DeviceSummary({ device, cpuInfo }) { const memory = device.memory; const label = device.backend === 'cpu' ? cpuLabel(device, cpuInfo) : device.device_name; return <div className="mini-device"><div className="mini-device-top"><BackendBadge backend={device.backend} /><span className="device-state online">online</span></div><strong>{label}</strong><div className="util-row"><span>{memory.measured ? 'Measured memory' : memory.estimated ? 'Estimated memory' : 'Memory unavailable'}</span><span>{formatBytes(memory.available_bytes)} free</span></div><div className="util-track"><div className={`backend-fill ${device.backend}`} style={{ width: memory.total_bytes && memory.available_bytes != null ? `${Math.min((memory.available_bytes / memory.total_bytes) * 100, 100)}%` : '0%' }} /></div></div> }

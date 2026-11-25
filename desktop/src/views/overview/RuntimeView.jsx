import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { MemoryBar } from '../../components/MemoryBar.jsx'
import { PageHeader } from '../../components/PageHeader.jsx'
import { BackendBadge, StatusBadge } from '../../components/badges.jsx'
import { Placement, StatCard } from '../../components/metrics.jsx'
import { cpuLabel, friendlyBackend, machineSummary, plural } from '../../lib/devices.js'
import { formatBytes, formatDate, formatDuration } from '../../lib/format.js'
import { isActive } from '../../lib/runs.js'
import { WorkloadRow } from '../benchmarks/WorkloadRow.jsx'
import { ArrowRightIcon, PlusIcon } from '../../components/icons.jsx'

export function RuntimeView() {
  const { devices, nodes, runs } = useRuntime()
  const { go, openModal, runId } = useNavigation()
  const summary = machineSummary(devices, nodes)
  const runningCount = runs.filter((run) => run.status === 'running').length
  const queuedCount = runs.filter((run) => run.status === 'queued').length
  const selectedRun = runs.find((run) => run.id === runId) || runs[0] || null
  const activeRun = runs.find((run) => isActive(run.status)) || selectedRun
  const openRun = (run) => go('benchmarks', { runId: run.id })
  return <>
    <PageHeader eyebrow="HAR" title="Overview" description="See what is running and which devices are available to help." action={<button className="primary-button" onClick={() => openModal('benchmark')}><PlusIcon /> Start a task</button>} />
    <section className="stat-grid"><StatCard label="Tasks in progress" value={String(runningCount + queuedCount).padStart(2, '0')} detail={`${runningCount} running · ${queuedCount} waiting`} accent="lime" /><StatCard label="Devices available" value={String(summary.machinesReady).padStart(2, '0')} detail={`${summary.runtimesReady} runtimes across your machines`} accent="blue" /><StatCard label="System status" value={devices.length ? 'Ready' : 'Waiting'} detail={devices.length ? 'Everything is responding' : 'Looking for devices'} accent="green" /><StatCard label="Finished tasks" value={String(runs.filter((run) => run.status === 'completed').length).padStart(2, '0')} detail="Completed successfully" accent="amber" /></section>
    <section className="runtime-grid"><ActiveWorkload run={activeRun} onTrace={() => { if (activeRun) openRun(activeRun) }} /><FabricSummary /></section>
    <section className="section-block"><div className="section-heading"><div><div className="eyebrow">RECENT ACTIVITY</div><h2>Recent benchmark runs</h2></div><button className="text-button" onClick={() => go('benchmarks')}>Open benchmarks<ArrowRightIcon /></button></div>{runs.length ? <div className="workload-list">{runs.slice(0, 8).map((run) => <WorkloadRow key={run.id} run={run} onClick={() => openRun(run)} />)}</div> : <EmptyState title="No benchmark runs yet" detail="Benchmarks are optional dev tools. Scripts are the main workflow." action="Open scripts" onAction={() => go('workloads')} />}</section>
  </>
}

function ActiveWorkload({ run, onTrace }) {
  if (!run) return <article className="panel active-workload-panel"><div className="eyebrow">CURRENT TASK</div><h2>Nothing is running</h2><p className="empty-copy">HAR is ready. Start a task to see its progress here.</p><button className="secondary-button" onClick={onTrace}>No activity yet</button></article>
  const total = run.request.measured_iterations || 1
  const progress = Math.round((run.completed_iterations / total) * 100)
  return <article className="panel active-workload-panel"><div className="panel-top"><div><div className="eyebrow">CURRENT TASK</div><h2>Matrix calculation</h2></div><StatusBadge status={run.status} /></div><div className="workload-meta"><span>{run.request.size} x {run.request.size} calculation</span><span>{run.request.measured_iterations} checks</span><span>{formatDate(run.created_at)}</span></div><div className="execution-line"><div className="execution-line-head"><span>Progress</span><strong>{run.last_latency_seconds ? formatDuration(run.last_latency_seconds) : 'Waiting'}</strong></div><div className="progress-track"><div style={{ width: `${progress}%` }} /></div><div className="execution-line-foot"><span>{run.completed_iterations} / {total} checks</span><span>{run.status}</span></div></div><div className="placement-grid"><Placement label="Choice" value={friendlyBackend(run.request.backend)} accent={run.request.backend} /><Placement label="Device" value={run.node_id === 'local' ? 'This computer' : run.node_id} /><Placement label="Result" value={run.result ? (run.result.correctness_passed ? 'Good' : 'Check failed') : 'Pending'} /></div><button className="secondary-button" onClick={onTrace}>See task details<ArrowRightIcon /></button></article>
}

function FabricSummary() {
  const { devices, nodes, cpuInfo } = useRuntime()
  const { go } = useNavigation()
  const { localAvailable, machinesReady, runtimesReady } = machineSummary(devices, nodes)
  return <article className="panel fabric-summary"><div className="section-heading compact"><div><div className="eyebrow">YOUR DEVICES</div><h2>Device status</h2></div><span className="online-count"><span className="status-dot" /> {plural(machinesReady, 'device')} · {plural(runtimesReady, 'runtime')}</span></div><div className="mini-devices">{localAvailable.slice(0, 3).map((device) => <DeviceSummary key={device.backend} device={device} cpuInfo={cpuInfo} />)}{!localAvailable.length && <div className="empty-copy">No devices are ready yet.</div>}</div><button className="secondary-button" onClick={() => go('fabric')}>See all devices<ArrowRightIcon /></button></article>
}

function DeviceSummary({ device, cpuInfo }) { const memory = device.memory; const label = device.backend === 'cpu' ? cpuLabel(device, cpuInfo) : device.device_name; return <div className="mini-device"><div className="mini-device-top"><BackendBadge backend={device.backend} /><span className="device-state online">online</span></div><strong>{label}</strong><div className="util-row"><span>{memory.measured ? 'Measured memory' : memory.estimated ? 'Estimated memory' : 'Memory unavailable'}</span><span>{formatBytes(memory.available_bytes)} free</span></div><MemoryBar memory={memory} backend={device.backend} /></div> }

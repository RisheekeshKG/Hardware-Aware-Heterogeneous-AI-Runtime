import { useEffect, useState } from 'react'
import { api } from '../../api/endpoints.js'
import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { PageHeader } from '../../components/PageHeader.jsx'
import { RefreshButton } from '../../components/RefreshButton.jsx'
import { StatusBadge } from '../../components/badges.jsx'
import { Metric } from '../../components/metrics.jsx'
import { friendlyBackend } from '../../lib/devices.js'
import { formatDate, formatDuration } from '../../lib/format.js'
import { ArrowRightIcon, PlusIcon } from '../../components/icons.jsx'

// Refetch the trace only when the selected run or its status changes, not on every poll.
function useRunTrace(run) {
  const [trace, setTrace] = useState(null)
  const runId = run?.id
  const status = run?.status
  useEffect(() => {
    if (!runId) return undefined
    let cancelled = false
    api.runTrace(runId).then((data) => { if (!cancelled) setTrace(data) }).catch(() => { if (!cancelled) setTrace(null) })
    return () => { cancelled = true }
  }, [runId, status])
  return runId && trace?.run_id === runId ? trace : null
}

export function BenchmarksView() { const { runs, refresh: onRefresh } = useRuntime(); const { runId, selectRun: onSelectRun, openModal } = useNavigation(); const onLaunch = () => openModal('benchmark'); const selectedRun = runs.find((run) => run.id === runId) || runs[0] || null; const trace = useRunTrace(selectedRun); const completed = runs.filter((run) => run.status === 'completed' && run.result); const latest = completed[0]; return <><PageHeader eyebrow="DEV TOOLS" title="Benchmarks" description="Built-in matrix calculation used to compare backends. Not part of the main workflow." action={<div className="header-actions">{onRefresh && <RefreshButton onClick={onRefresh} title="Refresh benchmarks" />}<button className="primary-button" onClick={onLaunch}><PlusIcon /> Start benchmark</button></div>} />{latest ? <><div className="benchmark-layout"><section className="panel benchmark-card"><div className="eyebrow">MOST RECENT RESULT</div><h2>Matrix calculation</h2><p>{friendlyBackend(latest.request.backend)} / {latest.request.size} x {latest.request.size}</p><div className="benchmark-metrics"><Metric label="Time" value={formatDuration(latest.result.latency_seconds.median)} /><Metric label="Speed" value={`${latest.result.throughput_tflops.median.toFixed(3)} TFLOP/s`} /><Metric label="Result" value={latest.result.correctness_passed ? 'Good' : 'Check'} /></div><button className="secondary-button" onClick={() => onSelectRun(latest.id)}>See what happened<ArrowRightIcon /></button></section><section className="panel benchmark-history"><div className="section-heading compact"><div><div className="eyebrow">HISTORY</div><h2>Previous results</h2></div><span className="chart-meta">{completed.length} results</span></div>{completed.slice(0, 8).map((run) => <button className="benchmark-session" key={run.id} onClick={() => onSelectRun(run.id)}><div><strong>{friendlyBackend(run.request.backend)} / Matrix calculation</strong><span>{run.request.size} x {run.request.size} / {formatDate(run.created_at)}</span></div><b>{formatDuration(run.result.latency_seconds.median)}</b><StatusBadge status={run.status} /></button>)}</section></div>{selectedRun && <section className="section-block"><div className="trace-toolbar"><div><span className="eyebrow">TRACE</span><strong>{selectedRun.id} / Matrix calculation / {friendlyBackend(selectedRun.request.backend)}</strong></div><span className="trace-context"><StatusBadge status={selectedRun.status} /></span></div><section className="panel trace-panel">{trace?.operations?.length ? trace.operations.map((operation) => <TraceRow key={operation.name} operation={operation} />) : <div className="empty-state">Operation details will appear when the run finishes.</div>}</section>{selectedRun.result && <div className="trace-footer"><div><span className="eyebrow">RESULT</span><strong>{selectedRun.result.correctness_passed ? 'Everything looks good' : 'Please check the result'}</strong><span>{selectedRun.request.size} x {selectedRun.request.size} calculation / {selectedRun.request.measured_iterations} checks</span></div><div className="selected-metrics"><Metric label="Time" value={formatDuration(selectedRun.result.latency_seconds?.median)} /><Metric label="Speed" value={selectedRun.result.throughput_tflops?.median != null ? `${selectedRun.result.throughput_tflops.median.toFixed(3)} TFLOP/s` : 'Unavailable'} /><Metric label="Memory" value={selectedRun.result.device.memory.estimated ? 'Estimated' : 'Measured'} /></div></div>}</section>}</> : <EmptyState title="No benchmark runs yet" detail="Start a matrix benchmark to compare how a backend handles the workload." action="Start benchmark" onAction={onLaunch} />}</> }

export function TraceRow({ operation }) { return <div className="trace-row"><div className="trace-label"><span className={`trace-dot ${operation.backend}`} /><div><strong>{operation.name}</strong><span>{operation.type}</span></div></div><div className="trace-lane"><div className={`trace-bar ${operation.backend}`} style={{ width: operation.duration_seconds ? '100%' : '40%' }}><span>{operation.backend.toUpperCase()}</span></div></div><div className="trace-value"><strong>{formatDuration(operation.duration_seconds)}</strong><span>{operation.measured ? 'Measured' : 'Unavailable'}</span></div></div> }

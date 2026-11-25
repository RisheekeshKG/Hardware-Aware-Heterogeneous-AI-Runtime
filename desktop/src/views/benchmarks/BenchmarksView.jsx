import { useEffect, useState } from 'react'
import { api } from '../../api/endpoints.js'
import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { Button } from '../../components/Button.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { PageHeader } from '../../components/PageHeader.jsx'
import { RefreshButton } from '../../components/RefreshButton.jsx'
import { SectionHeading } from '../../components/SectionHeading.jsx'
import { BackendBadge, StatusBadge } from '../../components/badges.jsx'
import { PlusIcon } from '../../components/icons.jsx'
import { Metric } from '../../components/metrics.jsx'
import { backendTag, friendlyBackend, nodeLabel } from '../../lib/devices.js'
import { formatDate, formatDuration } from '../../lib/format.js'
import { benchmarkSpeed, isActive, workloadDetail, workloadLabel } from '../../lib/runs.js'

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

export function BenchmarksView() {
  const { runs, nodes, refresh } = useRuntime()
  const { runId, selectRun, openModal } = useNavigation()
  const selected = runs.find((run) => run.id === runId) || runs[0] || null
  const trace = useRunTrace(selected)
  const start = () => openModal('benchmark')
  return <>
    <PageHeader eyebrow="DEV TOOLS" title="Benchmarks" description="Built-in workloads for comparing backends. Useful for checking a new computer; not needed to run scripts." action={<div className="header-actions"><RefreshButton onClick={refresh} title="Refresh benchmarks" /><Button variant="primary" icon={<PlusIcon />} onClick={start}>Start benchmark</Button></div>} />
    {!runs.length ? <EmptyState title="No benchmark runs yet" detail="Pick a workload and a backend to see how fast that computer runs it." action="Start benchmark" onAction={start} /> : <>
      <div className="benchmark-layout">
        <section className="panel benchmark-history">
          <SectionHeading compact eyebrow="HISTORY" title="Runs" action={<span className="chart-meta">{runs.length}</span>} />
          {runs.slice(0, 12).map((run) => <button type="button" className={`benchmark-session ${run.id === selected?.id ? 'selected' : ''}`} key={run.id} onClick={() => selectRun(run.id)} aria-current={run.id === selected?.id ? 'true' : undefined}>
            <BackendBadge backend={run.request.backend} />
            <div><strong>{workloadLabel(run.request)}</strong><span>{workloadDetail(run.request)} · {nodeLabel(run.node_id, nodes)} · {formatDate(run.created_at)}</span></div>
            <b>{run.result ? formatDuration(run.result.latency_seconds?.median) : isActive(run.status) ? `${run.completed_iterations}/${run.request.measured_iterations}` : '-'}</b>
            <StatusBadge status={run.status} />
          </button>)}
        </section>
        {selected && <RunDetail run={selected} />}
      </div>
      {selected && <section className="section-block">
        <div className="trace-toolbar"><div><span className="eyebrow">TRACE</span><strong>{selected.id} · {workloadLabel(selected.request)} · {friendlyBackend(selected.request.backend)}</strong></div><StatusBadge status={selected.status} /></div>
        <section className="panel trace-panel">{trace?.operations?.length ? trace.operations.map((operation) => <TraceRow key={operation.name} operation={operation} />) : <div className="empty-copy">Timings appear when the run finishes.</div>}</section>
      </section>}
    </>}
  </>
}

function RunDetail({ run }) {
  const result = run.result
  const progress = Math.round((run.completed_iterations / (run.request.measured_iterations || 1)) * 100)
  return <section className="panel benchmark-card">
    <div className="eyebrow">SELECTED RUN</div>
    <h2>{workloadLabel(run.request)}</h2>
    <p>{friendlyBackend(run.request.backend)} · {workloadDetail(run.request)}</p>
    {result ? <div className="benchmark-metrics">
      <Metric label="Median time" value={formatDuration(result.latency_seconds?.median)} />
      <Metric label="Speed" value={benchmarkSpeed(run)} />
      <Metric label="Check" value={result.correctness_passed === false ? 'Mismatch' : 'Passed'} />
      <Metric label="Memory" value={result.device?.memory?.estimated ? 'Estimated' : 'Measured'} />
    </div> : isActive(run.status) ? <div className="execution-line">
      <div className="execution-line-head"><span>Progress</span><strong>{run.last_latency_seconds ? formatDuration(run.last_latency_seconds) : 'Warming up'}</strong></div>
      <div className="progress-track"><div style={{ width: `${progress}%` }} /></div>
      <div className="execution-line-foot"><span>{run.completed_iterations} / {run.request.measured_iterations} iterations</span><span>{run.status}</span></div>
    </div> : <div className="form-error">{run.error || 'This run failed.'}</div>}
  </section>
}

function TraceRow({ operation }) {
  return <div className="trace-row">
    <div className="trace-label"><span className={`trace-dot ${operation.backend}`} /><div><strong>{operation.name}</strong><span>{operation.type}</span></div></div>
    <div className="trace-lane"><div className={`trace-bar ${operation.backend}`} style={{ width: operation.duration_seconds ? '100%' : '40%' }}><span>{backendTag(operation.backend)}</span></div></div>
    <div className="trace-value"><strong>{formatDuration(operation.duration_seconds)}</strong><span>{operation.measured ? 'Measured' : 'Unavailable'}</span></div>
  </div>
}

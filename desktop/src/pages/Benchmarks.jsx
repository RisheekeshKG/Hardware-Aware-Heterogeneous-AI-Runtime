// Benchmarks (dev tool): built-in workloads for comparing backends.
import { useState } from 'react'
import { api } from '../api.js'
import { backendTag, backendTitle, backendsForTarget, benchmarkSpeed, computerOptions, formatDate, formatDuration, friendlyBackend, isActive, nodeLabel, workloadDetail, workloadLabel } from '../helpers.js'
import { useNavigation, useRuntime, useToast } from '../state.jsx'
import { ArrowRightIcon, BackendBadge, Button, Dropdown, EmptyState, Field, Metric, Modal, ModalActions, PageHeader, PlusIcon, RefreshButton, SectionHeading, StatusBadge } from '../ui.jsx'

export function BenchmarksPage() {
  const { runs, nodes, refresh } = useRuntime()
  const { runId, selectRun, openModal } = useNavigation()
  const selected = runs.find((run) => run.id === runId) || runs[0] || null
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

export function NewBenchmarkDialog({ onClose }) {
  const { devices, nodes, cpuInfo, refresh } = useRuntime()
  const { go } = useNavigation()
  const notify = useToast()
  const [targetNode, setTargetNode] = useState('local')
  const availableBackends = backendsForTarget(targetNode, devices, nodes)
  const [form, setForm] = useState({ workload: 'matmul', backend: availableBackends[0]?.backend || 'cpu', size: 1024, warmup_iterations: 3, measured_iterations: 10, seed: 42 })
  const [submitError, setSubmitError] = useState('')
  // Derived, not synced in an effect: switching computers falls back to its first backend.
  const backend = availableBackends.some((item) => item.backend === form.backend) ? form.backend : availableBackends[0]?.backend
  const onSubmit = async (request) => {
    const run = await api.startRun(request)
    onClose()
    go('benchmarks', { runId: run.id })
    notify(`Benchmark started on ${friendlyBackend(request.backend)}.`)
    await refresh()
  }
  const submit = async (event) => {
    event.preventDefault(); setSubmitError('')
    if (!backend) { setSubmitError('The selected computer has no available processing device.'); return }
    try { await onSubmit({ ...form, backend, target_node: targetNode, size: Number(form.size), warmup_iterations: Number(form.warmup_iterations), measured_iterations: Number(form.measured_iterations), seed: Number(form.seed) }) } catch (error) { setSubmitError(error.message) }
  }
  return <Modal eyebrow="NEW BENCHMARK" title="Start a benchmark" onClose={onClose} onSubmit={submit}>
    <p>Runs a built-in workload a few times and reports the median time, so you can compare backends.</p>
    <Field label="Computer"><Dropdown ariaLabel="Target computer" value={targetNode} onChange={setTargetNode} options={computerOptions(nodes)} /></Field>
    <Field label="Backend"><Dropdown ariaLabel="Processing device" disabled={!availableBackends.length} value={backend} onChange={(next) => setForm((current) => ({ ...current, backend: next }))} placeholder="No devices on this computer" options={availableBackends.map((item) => ({ value: item.backend, label: backendTitle(item, targetNode === 'local' ? cpuInfo : null), hint: backendTag(item.backend) }))} /></Field>
    <Field label="Workload"><Dropdown ariaLabel="Workload" value={form.workload} onChange={(next) => setForm((current) => ({ ...current, workload: next }))} options={[{ value: 'matmul', label: 'Matrix multiply', hint: 'raw compute' }, { value: 'image', label: 'Image model', hint: 'small CNN' }, { value: 'tree', label: 'Tree traversal', hint: 'branchy, CPU-like' }]} /></Field>
    {form.workload === 'matmul' && <Field label="Matrix size"><Dropdown ariaLabel="Matrix size" value={String(form.size)} onChange={(next) => setForm((current) => ({ ...current, size: next }))} options={[{ value: '512', label: '512 × 512' }, { value: '1024', label: '1024 × 1024' }, { value: '2048', label: '2048 × 2048' }]} /></Field>}
    <div className="advanced-note">3 warm-up runs, then 10 measured runs, with a fixed random seed.</div>
    {submitError && <div className="form-error">{submitError}</div>}
    <ModalActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={!availableBackends.length} iconAfter={<ArrowRightIcon />}>Start benchmark</Button></ModalActions>
  </Modal>
}

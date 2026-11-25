// Benchmarks (dev tool): built-in workloads for comparing backends.
import { useState } from 'react'
import { api } from '../api.js'
import { backendTag, backendTitle, backendsForTarget, benchmarkSpeed, computerOptions, formatDate, formatDuration, friendlyBackend, isActive, nodeLabel, workloadDetail, workloadLabel } from '../helpers.js'
import { useNavigation, useRuntime, useToast } from '../state.jsx'
import { ArrowRightIcon, BackendBadge, Button, Dropdown, EmptyState, Field, IconButton, InfoList, Metric, Modal, ModalActions, Pane, PlusIcon, RefreshIcon, StatusBadge, Workspace } from '../ui.jsx'

export function BenchmarksPage() {
  const { runs, nodes, refresh } = useRuntime()
  const { runId, selectRun, openModal } = useNavigation()
  const selected = runs.find((run) => run.id === runId) || runs[0] || null
  const start = () => openModal('benchmark')
  return <Workspace title="Benchmarks" note="Dev tool · built-in workloads for comparing backends" actions={<>
    <IconButton icon={<RefreshIcon />} label="Refresh" onClick={refresh} />
    <Button variant="primary" icon={<PlusIcon />} onClick={start}>Start benchmark</Button>
  </>}>
    {!runs.length
      ? <div className="workspace-scroll"><EmptyState title="No benchmark runs yet" detail="Pick a workload and a backend to see how fast that computer runs it." action="Start benchmark" onAction={start} /></div>
      : <div className="workspace-split">
          <nav className="split-list" aria-label="Benchmark runs">
            <div className="split-list-head"><span className="eyebrow">RUNS</span><span className="chart-meta">{runs.length}</span></div>
            <ul className="row-list">{runs.map((run) => <li key={run.id}>
              <button type="button" className={`list-row ${run.id === selected?.id ? 'active' : ''}`} aria-current={run.id === selected?.id ? 'true' : undefined} onClick={() => selectRun(run.id)}>
                <BackendBadge backend={run.request.backend} />
                <span className="list-row-main"><strong>{workloadLabel(run.request)}</strong><span>{workloadDetail(run.request)} · {nodeLabel(run.node_id, nodes)}</span></span>
                <span className="list-row-time">{run.result ? formatDuration(run.result.latency_seconds?.median) : isActive(run.status) ? `${run.completed_iterations}/${run.request.measured_iterations}` : run.status}</span>
              </button>
            </li>)}</ul>
          </nav>
          <div className="split-detail">{selected && <RunDetail run={selected} />}</div>
        </div>}
  </Workspace>
}

function RunDetail({ run }) {
  const { nodes } = useRuntime()
  const result = run.result
  const progress = Math.round((run.completed_iterations / (run.request.measured_iterations || 1)) * 100)
  return <>
    <div className="detail-head">
      <div className="detail-title"><h2>{workloadLabel(run.request)}</h2><span>{friendlyBackend(run.request.backend)} · {workloadDetail(run.request)} · {nodeLabel(run.node_id, nodes)} · {formatDate(run.created_at)}</span></div>
      <div className="detail-actions"><StatusBadge status={run.status} /></div>
    </div>
    {result ? <Pane title="RESULT">
      <div className="metric-grid">
        <Metric label="Median time" value={formatDuration(result.latency_seconds?.median)} />
        <Metric label="Speed" value={benchmarkSpeed(run)} />
        <Metric label="Check" value={result.correctness_passed === false ? 'Mismatch' : 'Passed'} />
        <Metric label="Memory" value={result.device?.memory?.estimated ? 'Estimated' : 'Measured'} />
      </div>
    </Pane> : isActive(run.status) ? <Pane title="PROGRESS" meta={`${run.completed_iterations} / ${run.request.measured_iterations} iterations`}>
      <div className="progress-track"><div style={{ width: `${progress}%` }} /></div>
      <p className="detail-note">{run.last_latency_seconds ? `Last iteration ${formatDuration(run.last_latency_seconds)}` : 'Warming up…'}</p>
    </Pane> : <Pane title="ERROR"><div className="form-error">{run.error || 'This run failed.'}</div></Pane>}
    <Pane title="SETTINGS"><InfoList rows={[
      ['Workload', workloadLabel(run.request)],
      ['Size', workloadDetail(run.request)],
      ['Backend', friendlyBackend(run.request.backend)],
      ['Warm-up runs', run.request.warmup_iterations],
      ['Measured runs', run.request.measured_iterations],
      ['Seed', run.request.seed],
    ]} /></Pane>
  </>
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

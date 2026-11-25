import { useState } from 'react'
import { api } from '../../api/endpoints.js'
import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { useToast } from '../../app/ToastProvider.jsx'
import { Dropdown } from '../../components/Dropdown.jsx'
import { backendTag, backendTitle, backendsForTarget, computerOptions, friendlyBackend } from '../../lib/devices.js'
import { Button } from '../../components/Button.jsx'
import { Field } from '../../components/Field.jsx'
import { Modal, ModalActions } from '../../components/Modal.jsx'
import { ArrowRightIcon } from '../../components/icons.jsx'

export function Launcher({ onClose }) {
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

import { useState } from 'react'
import { api } from '../../api/endpoints.js'
import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { useToast } from '../../app/ToastProvider.jsx'
import { Dropdown } from '../../components/Dropdown.jsx'
import { backendsForTarget, computerOptions, cpuLabel, friendlyBackend } from '../../lib/devices.js'
import { Button } from '../../components/Button.jsx'
import { Field } from '../../components/Field.jsx'
import { Modal, ModalActions } from '../../components/Modal.jsx'
import { ArrowRightIcon } from '../../components/icons.jsx'

export function Launcher({ onClose }) {
  const { devices, nodes, cpuInfo, refresh } = useRuntime()
  const { go, selectRun } = useNavigation()
  const notify = useToast()
  const [targetNode, setTargetNode] = useState('local')
  const availableBackends = backendsForTarget(targetNode, devices, nodes)
  const [form, setForm] = useState({ backend: availableBackends[0]?.backend || 'cpu', size: 1024, warmup_iterations: 3, measured_iterations: 10, seed: 42 })
  const [submitError, setSubmitError] = useState('')
  // Derived, not synced in an effect: switching computers falls back to its first backend.
  const backend = availableBackends.some((item) => item.backend === form.backend) ? form.backend : availableBackends[0]?.backend
  const onSubmit = async (request) => {
    const run = await api.startRun(request)
    selectRun(run.id)
    onClose()
    go('runtime')
    notify(`Workload ${run.id} queued on ${request.backend.toUpperCase()}.`)
    await refresh()
  }
  const backendLabel = (backend) => backend.backend === 'cpu' && targetNode === 'local' ? cpuLabel(backend, cpuInfo) : (backend.device_name || friendlyBackend(backend.backend))
  const submit = async (event) => {
    event.preventDefault(); setSubmitError('')
    if (!backend) { setSubmitError('The selected computer has no available processing device.'); return }
    try { await onSubmit({ ...form, backend, target_node: targetNode, size: Number(form.size), warmup_iterations: Number(form.warmup_iterations), measured_iterations: Number(form.measured_iterations), seed: Number(form.seed) }) } catch (error) { setSubmitError(error.message) }
  }
  return <Modal eyebrow="NEW BENCHMARK" title="Start a benchmark" onClose={onClose} onSubmit={submit}>
    <p>Choose how much work to do and which device should handle it.</p>
    <Field label="Computer"><Dropdown ariaLabel="Target computer" value={targetNode} onChange={setTargetNode} options={computerOptions(nodes)} /></Field>
    <Field label="Processing device"><Dropdown ariaLabel="Processing device" disabled={!availableBackends.length} value={backend} onChange={(next) => setForm((current) => ({ ...current, backend: next }))} placeholder="No devices on this computer" options={availableBackends.map((backend) => ({ value: backend.backend, label: backendLabel(backend) }))} /></Field>
    <Field label="Amount of work"><Dropdown ariaLabel="Amount of work" value={String(form.size)} onChange={(next) => setForm((current) => ({ ...current, size: next }))} options={[{ value: '512', label: 'Small' }, { value: '1024', label: 'Medium' }, { value: '2048', label: 'Large' }]} /></Field>
    <div className="advanced-note">HAR will choose the safe measurement settings automatically.</div>
    {submitError && <div className="form-error">{submitError}</div>}
    <ModalActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={!availableBackends.length} iconAfter={<ArrowRightIcon />}>Start benchmark</Button></ModalActions>
  </Modal>
}

import { useState, useEffect } from 'react'
import { Dropdown } from '../../components/Dropdown.jsx'
import { backendsForTarget, cpuLabel, friendlyBackend } from '../../lib/devices.js'

export function Launcher({ devices, nodes, cpuInfo, onClose, onSubmit }) {
  const remoteNodes = (nodes || []).filter((node) => node.name !== 'This device')
  const [targetNode, setTargetNode] = useState('local')
  const availableBackends = backendsForTarget(targetNode, devices, nodes)
  const [form, setForm] = useState({ backend: availableBackends[0]?.backend || 'cpu', size: 1024, warmup_iterations: 3, measured_iterations: 10, seed: 42 })
  const [submitError, setSubmitError] = useState('')
  useEffect(() => {
    const first = availableBackends[0]?.backend
    if (first && !availableBackends.some((item) => item.backend === form.backend)) {
      setForm((current) => ({ ...current, backend: first }))
    }
  }, [targetNode, availableBackends.map((item) => item.backend).join(',')])
  const backendLabel = (backend) => backend.backend === 'cpu' && targetNode === 'local' ? cpuLabel(backend, cpuInfo) : (backend.device_name || friendlyBackend(backend.backend))
  const submit = async (event) => {
    event.preventDefault(); setSubmitError('')
    if (!form.backend) { setSubmitError('The selected computer has no available processing device.'); return }
    try { await onSubmit({ ...form, target_node: targetNode, size: Number(form.size), warmup_iterations: Number(form.warmup_iterations), measured_iterations: Number(form.measured_iterations), seed: Number(form.seed) }) } catch (error) { setSubmitError(error.message) }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="launcher-modal" onSubmit={submit}>
    <div className="modal-header"><div><div className="eyebrow">NEW TASK</div><h2>Start a calculation</h2></div><button type="button" className="close-button" onClick={onClose}>X</button></div>
    <p>Choose how much work to do and which device should handle it.</p>
    <label>Computer<Dropdown ariaLabel="Target computer" value={targetNode} onChange={setTargetNode} options={[{ value: 'local', label: 'This computer' }, ...remoteNodes.map((node) => ({ value: node.node_id, label: node.name, disabled: node.status !== 'online', hint: node.status === 'online' ? null : 'not available' }))]} /></label>
    <label>Processing device<Dropdown ariaLabel="Processing device" disabled={!availableBackends.length} value={form.backend} onChange={(next) => setForm((current) => ({ ...current, backend: next }))} placeholder="No devices on this computer" options={availableBackends.map((backend) => ({ value: backend.backend, label: backendLabel(backend) }))} /></label>
    <label>Amount of work<Dropdown ariaLabel="Amount of work" value={String(form.size)} onChange={(next) => setForm((current) => ({ ...current, size: next }))} options={[{ value: '512', label: 'Small' }, { value: '1024', label: 'Medium' }, { value: '2048', label: 'Large' }]} /></label>
    <div className="advanced-note">HAR will choose the safe measurement settings automatically.</div>
    {submitError && <div className="form-error">{submitError}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={!availableBackends.length}>Start task <span>-&gt;</span></button></div>
  </form></div>
}

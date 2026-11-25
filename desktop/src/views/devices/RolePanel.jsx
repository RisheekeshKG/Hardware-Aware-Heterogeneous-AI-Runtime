import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { API } from '../../api/client.js'

export const roleOptions = [
  { id: 'host', label: 'Host', detail: 'Send tasks to this computer and to devices you add.' },
  { id: 'worker', label: 'Worker', detail: 'Let another computer running HAR send tasks here.' },
  { id: 'standalone', label: 'Standalone', detail: 'Use only this computer. Not reachable from the network.' },
]

export function RolePanel() {
  const [role, setRole] = useState(null)
  const [hostUrl, setHostUrl] = useState('')
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return
    invoke('runtime_role').then(setRole).catch(() => {})
  }, [])
  useEffect(() => {
    if (!role) return
    fetch(`${API}/api/session`).then((response) => response.ok ? response.json() : {}).then((data) => setHostUrl(data.host_url || '')).catch(() => {})
  }, [role])
  if (!window.__TAURI_INTERNALS__ || !role) return null
  const change = async (next) => {
    if (next === role) return
    setSwitching(true); setError('')
    try { setRole(await invoke('set_runtime_role', { role: next })) } catch (roleError) { setError(roleError.toString()) } finally { setSwitching(false) }
  }
  // The worker service listens on port 9000 on the same LAN address the host API advertises.
  const workerAddress = hostUrl ? hostUrl.replace(/:\d+$/, ':9000') : ''
  const lanAddress = hostUrl ? hostUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, '') : ''
  return <section className="role-panel panel"><div className="role-panel-head"><div><span className="eyebrow">THIS COMPUTER'S ROLE</span><p>{roleOptions.find((option) => option.id === role)?.detail}</p>{lanAddress && <p className="role-ip">This PC's address: <code>{lanAddress}</code> <button className="link-button" onClick={() => navigator.clipboard?.writeText(lanAddress)}>Copy</button></p>}</div><div className="role-options" role="radiogroup" aria-label="Runtime role">{roleOptions.map((option) => <button key={option.id} role="radio" aria-checked={role === option.id} className={`role-option ${role === option.id ? 'active' : ''}`} onClick={() => change(option.id)} disabled={switching}>{option.label}</button>)}</div></div>{role === 'worker' && <div className="role-address"><span>On the other computer, choose <strong>Add device</strong> and enter</span><code>{workerAddress || 'http://<this-computer-IP>:9000'}</code>{workerAddress && <button className="secondary-button" onClick={() => navigator.clipboard?.writeText(workerAddress)}>Copy</button>}</div>}{error && <div className="form-error">{error}</div>}</section>
}

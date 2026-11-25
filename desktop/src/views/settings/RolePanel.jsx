import { useEffect, useState } from 'react'
import { useConfirm } from '../../app/ConfirmProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { Button } from '../../components/Button.jsx'
import { SectionHeading } from '../../components/SectionHeading.jsx'
import { CopyIcon } from '../../components/icons.jsx'
import { isActive } from '../../lib/runs.js'
import { desktopInvoke, isDesktop } from '../../lib/tauri.js'

const ROLES = [
  { id: 'host', label: 'Host', detail: 'Runs scripts here and sends them to computers you add.' },
  { id: 'worker', label: 'Worker', detail: 'Lets a host on your network send scripts to this computer.' },
  { id: 'standalone', label: 'Standalone', detail: 'Only this computer. Not reachable from the network.' },
]

const copy = (text) => navigator.clipboard?.writeText(text)

export function RolePanel() {
  const { session, scripts, expectRestart } = useRuntime()
  const ask = useConfirm()
  const [role, setRole] = useState(null)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { desktopInvoke('runtime_role').then(setRole).catch(() => {}) }, [])
  const current = role || session?.role
  const hostUrl = session?.host_url || ''
  // The worker service listens on port 9000 on the same LAN address the host API advertises.
  const lanAddress = hostUrl ? hostUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, '') : ''
  const workerAddress = lanAddress ? `${lanAddress}:9000` : ''

  const change = async (next) => {
    if (next === current || switching) return
    const running = scripts.filter((script) => isActive(script.status)).length
    const ok = await ask({
      title: `Switch this computer to ${ROLES.find((item) => item.id === next).label}?`,
      message: running
        ? `HAR restarts to switch roles. ${running} running script${running === 1 ? '' : 's'} will be stopped.`
        : 'HAR restarts to switch roles. This takes a few seconds.',
      confirmLabel: 'Switch role',
      tone: running ? 'danger' : 'primary',
    })
    if (!ok) return
    setSwitching(true); setError('')
    expectRestart()
    try { setRole(await desktopInvoke('set_runtime_role', { role: next })) } catch (roleError) { setError(roleError.toString()) } finally { setSwitching(false) }
  }

  return <section className="panel settings-panel">
    <SectionHeading compact eyebrow="THIS COMPUTER'S ROLE" title={ROLES.find((item) => item.id === current)?.label || '…'} />
    <div className="role-cards" role="radiogroup" aria-label="Role">
      {ROLES.map((option) => <button key={option.id} type="button" role="radio" aria-checked={current === option.id} className={`role-card ${current === option.id ? 'active' : ''}`} onClick={() => change(option.id)} disabled={!isDesktop() || switching}>
        <strong>{option.label}</strong><span>{option.detail}</span>
      </button>)}
    </div>
    {!isDesktop() && <p className="detail-note">Switch roles in the HAR desktop app. In a browser this page is read-only.</p>}
    {switching && <p className="detail-note">Restarting HAR in the new role…</p>}
    {lanAddress && <div className="role-address"><span>This computer's address</span><code>{lanAddress}</code><Button variant="text" icon={<CopyIcon />} onClick={() => copy(lanAddress)}>Copy</Button></div>}
    {current === 'worker' && <div className="role-address"><span>On the host, choose <strong>Add device</strong> and enter</span><code>{workerAddress || '<this computer’s IP>:9000'}</code>{workerAddress && <Button variant="text" icon={<CopyIcon />} onClick={() => copy(workerAddress)}>Copy</Button>}</div>}
    {error && <div className="form-error">{error}</div>}
  </section>
}

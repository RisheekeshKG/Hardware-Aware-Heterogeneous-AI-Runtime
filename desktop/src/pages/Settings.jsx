// Settings: this computer's role, PyTorch, and installation details.
import { useCallback, useEffect, useState } from 'react'
import { API, api, appVersion, desktopInvoke, isDesktop } from '../api.js'
import { isActive } from '../helpers.js'
import { TorchInstallProgress, isBrokenTorch, useTorchInstall } from '../pages/Setup.jsx'
import { useConfirm, useNavigation, useRuntime, useToast } from '../state.jsx'
import { Button, CopyIcon, InfoList, Pane, Workspace } from '../ui.jsx'

export function SettingsPage() {
  return <Workspace title="Settings" note="How this computer takes part, and what HAR is running on">
    <div className="workspace-scroll narrow">
      <RolePanel />
      <PyTorchPanel />
      <AboutPanel />
    </div>
  </Workspace>
}

function AboutPanel() {
  const { session, system } = useRuntime()
  const { go } = useNavigation()
  const [version, setVersion] = useState(null)
  const [env, setEnv] = useState(null)
  useEffect(() => { appVersion().then(setVersion).catch(() => {}) }, [])
  useEffect(() => { api.envHash().then(setEnv).catch(() => {}) }, [])
  const runtime = system?.host?.runtime
  const rows = [
    ['HAR app', isDesktop() ? (version || '…') : 'Running in a browser'],
    ['Role', session?.role || '…'],
    ['Python', runtime?.python_version || '…'],
    ['PyTorch', runtime ? (runtime.pytorch_version || 'Not installed') : '…'],
    ['Apple GPU (MPS)', runtime ? (runtime.mps_built ? 'Built in' : 'Not available') : '…'],
    ['NVIDIA CUDA', runtime ? (runtime.cuda_runtime || 'Not available') : '…'],
    ['API address', API],
    ['Session', session?.session_id || '…'],
    ['Environment', env ? <>{env.hash} · {Object.values(env.packages).filter((v) => v !== 'absent').length} packages <button className="link-button" onClick={() => go('devices', { deviceId: 'local' })}>See packages</button></> : '…'],
  ]
  return <Pane title="ABOUT THIS INSTALLATION"><InfoList rows={rows} /></Pane>
}

const ROLES = [
  { id: 'host', label: 'Host', detail: 'Runs scripts here and sends them to computers you add.' },
  { id: 'worker', label: 'Worker', detail: 'Lets a host on your network send scripts to this computer.' },
  { id: 'standalone', label: 'Standalone', detail: 'Only this computer. Not reachable from the network.' },
]

const copy = (text) => navigator.clipboard?.writeText(text)

function RolePanel() {
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

  return <Pane title="THIS COMPUTER'S ROLE" meta={ROLES.find((item) => item.id === current)?.label || '…'}>
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
  </Pane>
}

function PyTorchPanel() {
  const { scripts, system, expectRestart, refresh } = useRuntime()
  const ask = useConfirm()
  const notify = useToast()
  const install = useTorchInstall({ onRestarting: expectRestart })
  // runtime_status starts the runtime and imports torch, so it's slow: fetched when
  // Settings opens and after an install, never on the poll.
  const [status, setStatus] = useState(null)
  const check = useCallback(() => {
    if (!isDesktop()) return
    setStatus(null)
    desktopInvoke('runtime_status').then(setStatus).catch((error) => setStatus({ check_error: error.toString() }))
  }, [])
  useEffect(() => { check() }, [check])

  const browserVersion = system?.host?.runtime?.pytorch_version
  const broken = isBrokenTorch(status)
  const missing = status && !status.check_error && !status.torch_installed && !broken
  const state = !isDesktop()
    ? (browserVersion ? `PyTorch ${browserVersion}` : 'Not installed')
    : !status ? 'Checking…' : status.check_error ? 'Could not check' : broken ? 'Fails to load' : missing ? 'Not installed' : `PyTorch ${status.torch_version}`

  const reinstall = async () => {
    const running = scripts.filter((script) => isActive(script.status)).length
    const ok = await ask({
      title: missing ? 'Install PyTorch?' : 'Reinstall PyTorch?',
      message: `HAR downloads it with its bundled installer (about 150 MB on a Mac, about 3 GB for CUDA on Windows), then restarts.${running ? ` ${running} running script${running === 1 ? '' : 's'} will be stopped by the restart.` : ''}`,
      confirmLabel: missing ? 'Install' : 'Reinstall',
      tone: running ? 'danger' : 'primary',
    })
    if (!ok) return
    const result = await install.install()
    if (!result) return
    expectRestart()
    notify(`PyTorch ${result.torch_version || ''} installed.`)
    setStatus(result)
    refresh()
  }

  return <Pane title="PYTORCH" meta={state} actions={isDesktop() && !install.installing ? <Button variant={missing || broken ? 'primary' : 'secondary'} onClick={reinstall} disabled={!status}>{missing ? 'Install PyTorch' : broken ? 'Repair PyTorch' : 'Reinstall'}</Button> : null}>
    <p className="detail-note">{isDesktop()
      ? <>HAR keeps its own copy of PyTorch, separate from any Python on this computer. Reinstalling fetches the newest build for this hardware.{status?.wheels_dir && <><br />Downloads are kept in <code>{status.wheels_dir}</code>. To skip the 2.8 GB CUDA download on another Windows PC, copy the <code>torch-…whl</code> file from here into the same folder there before installing.</>}</>
      : <>Install or repair PyTorch from the HAR desktop app. This browser is talking to <code>har serve</code>, which uses whatever PyTorch its Python has.</>}</p>
    {broken && <div className="form-error setup-error">{status.torch_error}</div>}
    {status?.check_error && <div className="form-error setup-error">{status.check_error}</div>}
    <TorchInstallProgress install={install} />
    {install.installing && <Button variant="text" onClick={install.cancel}>Cancel install</Button>}
    {install.error && <div className="form-error setup-error">{install.error}</div>}
  </Pane>
}

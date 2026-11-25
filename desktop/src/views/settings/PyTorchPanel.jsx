import { useCallback, useEffect, useState } from 'react'
import { useConfirm } from '../../app/ConfirmProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { useToast } from '../../app/ToastProvider.jsx'
import { Button } from '../../components/Button.jsx'
import { SectionHeading } from '../../components/SectionHeading.jsx'
import { isActive } from '../../lib/runs.js'
import { desktopInvoke, isDesktop } from '../../lib/tauri.js'
import { isBrokenTorch } from '../setup/RuntimeSetup.jsx'
import { TorchInstallProgress } from '../setup/TorchInstallProgress.jsx'
import { useTorchInstall } from '../setup/useTorchInstall.js'

export function PyTorchPanel() {
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

  return <section className="panel settings-panel">
    <SectionHeading compact eyebrow="PYTORCH" title={state} action={isDesktop() && !install.installing ? <Button variant={missing || broken ? 'primary' : 'secondary'} onClick={reinstall} disabled={!status}>{missing ? 'Install PyTorch' : broken ? 'Repair PyTorch' : 'Reinstall'}</Button> : null} />
    <p className="detail-note">{isDesktop()
      ? 'HAR keeps its own copy of PyTorch, separate from any Python on this computer. Reinstalling fetches the newest build for this hardware.'
      : <>Install or repair PyTorch from the HAR desktop app. This browser is talking to <code>har serve</code>, which uses whatever PyTorch its Python has.</>}</p>
    {broken && <div className="form-error setup-error">{status.torch_error}</div>}
    {status?.check_error && <div className="form-error setup-error">{status.check_error}</div>}
    <TorchInstallProgress install={install} />
    {install.installing && <Button variant="text" onClick={install.cancel}>Cancel install</Button>}
    {install.error && <div className="form-error setup-error">{install.error}</div>}
  </section>
}

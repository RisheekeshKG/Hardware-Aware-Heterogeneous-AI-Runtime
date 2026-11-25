// First launch: shown until PyTorch is installed. The installer is shared with Settings.
import { useEffect, useRef, useState } from 'react'
import { desktopInvoke, desktopListen, isDesktop } from '../api.js'
import { useNow, useToast } from '../state.jsx'
import { ArrowRightIcon, Brand, Button } from '../ui.jsx'

// Shows the first-launch screens (starting, runtime missing, install PyTorch) until the
// runtime is usable, then renders the app. In a plain browser there is nothing to check.
export function SetupGate({ children }) {
  const notify = useToast()
  const [status, setStatus] = useState({ checking: isDesktop(), installed: true, torch_installed: true, error: '' })
  const [skipped, setSkipped] = useState(false)

  useEffect(() => {
    if (!isDesktop()) return
    desktopInvoke('runtime_status')
      .then((next) => setStatus({ ...next, checking: false, error: '' }))
      .catch((error) => setStatus((current) => ({ ...current, checking: false, error: error.toString() })))
  }, [])

  const onFinish = (installed) => {
    if (!installed) { setSkipped(true); return }
    setStatus({ ...installed, checking: false, error: '' })
    notify(`PyTorch ${installed.torch_version || ''} installed.`)
  }

  if (status.checking || !status.installed || (!status.torch_installed && !skipped)) {
    return <SetupScreen status={status} onFinish={onFinish} />
  }
  return children
}

export const isBrokenTorch = (status) => Boolean(status?.torch_error) && !status.torch_error.includes("No module named 'torch'")

// onFinish(status) after a successful install, onFinish(null) when the person skips.
function SetupScreen({ status, onFinish }) {
  const install = useTorchInstall()

  if (status.checking) return <SetupCard eyebrow="STARTING" title="Starting HAR" />
  if (!status.installed) {
    return <SetupCard eyebrow="INSTALL PROBLEM" title="HAR's runtime is missing">
      <p>This copy of HAR doesn't include its compute runtime, so it can't start. Reinstall HAR from the latest installer.</p>
      {status.error && <div className="form-error">{status.error}</div>}
    </SetupCard>
  }

  const broken = isBrokenTorch(status)
  const run = async () => { const result = await install.install(); if (result) onFinish(result) }
  return <SetupCard eyebrow="ONE-TIME SETUP" title={broken ? 'Repair PyTorch' : 'Install PyTorch'}>
    <p>{broken ? "PyTorch is installed but failed to load, so HAR can't run work yet. Reinstalling usually fixes it." : "HAR runs your code with PyTorch. It isn't bundled with the app, so HAR installs it once into its own folder. This step needs an internet connection; after that HAR works offline."}</p>
    <div className="setup-detail"><span>Download</span><strong>About 150 MB on a Mac. On Windows with an NVIDIA GPU, about 3 GB (the CUDA build).</strong></div>
    {broken && <div className="setup-detail"><span>Load error</span><strong>{status.torch_error}</strong></div>}
    <TorchInstallProgress install={install} />
    {install.error && <div className="form-error setup-error">{install.error}</div>}
    <Button variant="primary" className="setup-button" onClick={run} disabled={install.installing} iconAfter={<ArrowRightIcon />}>{install.installing ? 'Installing PyTorch…' : install.error ? 'Try again' : broken ? 'Reinstall PyTorch' : 'Install PyTorch'}</Button>
    {install.installing
      ? <Button variant="text" className="setup-skip" onClick={install.cancel}>Cancel</Button>
      : <Button variant="text" className="setup-skip" onClick={() => onFinish(null)}>Skip for now</Button>}
  </SetupCard>
}

function SetupCard({ eyebrow, title, children }) {
  return <div className="runtime-setup"><div className="runtime-setup-card"><Brand /><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{children}</div></div>
}

const STALL_MS = 90000

// Runs the desktop app's `install_torch` (bundled uv) and tracks its progress from the
// `torch-install-log` events. Shared by first-launch setup and Settings.
//
// onRestarting fires once when uv reports "Installed N packages": the app is about to
// stop the runtime, swap the new packages in, and start it again.
export function useTorchInstall({ onRestarting } = {}) {
  const [installing, setInstalling] = useState(false)
  const [lines, setLines] = useState([])
  const [error, setError] = useState('')
  const [startedAt, setStartedAt] = useState(0)
  const [lastLineAt, setLastLineAt] = useState(0)
  const now = useNow(installing)
  const onRestartingRef = useRef(onRestarting)
  const announced = useRef(false)
  useEffect(() => { onRestartingRef.current = onRestarting }, [onRestarting])

  useEffect(() => desktopListen('torch-install-log', (event) => {
    setLines((current) => [...current.slice(-49), event.payload.line])
    setLastLineAt(Date.now())
  }), [])

  // uv prints "Resolved N packages", then "Prepared N packages" once downloads finish,
  // then "Installed N packages".
  const seen = (prefix) => lines.some((line) => line.startsWith(prefix))
  const installed = seen('Installed')
  const phase = installed ? 'Restarting HAR…' : seen('Prepared') ? 'Installing…' : seen('Resolved') ? 'Downloading PyTorch…' : 'Preparing…'

  useEffect(() => {
    if (installing && installed && !announced.current) {
      announced.current = true
      onRestartingRef.current?.()
    }
  }, [installing, installed])

  const install = async () => {
    const start = Date.now()
    announced.current = false
    setInstalling(true); setError(''); setLines([]); setStartedAt(start); setLastLineAt(start)
    try {
      return await desktopInvoke('install_torch')
    } catch (installError) {
      setError(installError.toString())
      return null
    } finally {
      setInstalling(false)
    }
  }
  const cancel = () => desktopInvoke('cancel_torch_install').catch(() => {})

  return {
    installing,
    phase,
    error,
    lastLine: lines[lines.length - 1] || '',
    elapsed: installing ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0,
    stalled: installing && now - lastLineAt > STALL_MS,
    install,
    cancel,
  }
}

export function TorchInstallProgress({ install }) {
  if (!install.installing) return null
  return <div className="setup-progress" role="progressbar" aria-busy="true" aria-label="Installing PyTorch">
    <div className="setup-progress-track"><div className="setup-progress-fill indeterminate" /></div>
    <div className="setup-progress-meta"><span>{install.phase}</span><strong>{install.elapsed}s</strong></div>
    {install.lastLine && <div className="setup-log">{install.lastLine}</div>}
    {install.stalled && <div className="setup-hint">Big downloads can take a few minutes. If this stays stuck, cancel and try again; finished downloads are kept.</div>}
  </div>
}

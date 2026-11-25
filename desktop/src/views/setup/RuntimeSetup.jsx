import { useState, useEffect } from 'react'
import { Brand } from '../../app/Sidebar.jsx'
import { desktopInvoke, desktopListen } from '../../lib/tauri.js'
import { ArrowRightIcon } from '../../components/icons.jsx'

// onFinish(status) after a successful install, onFinish(null) when the person skips.
export function RuntimeSetup({ status, onFinish }) {
  const [installing, setInstalling] = useState(false)
  const [lines, setLines] = useState([])
  const [error, setError] = useState('')
  const [installStartedAt, setInstallStartedAt] = useState(0)
  const [lastLineAt, setLastLineAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    return desktopListen('torch-install-log', (event) => { setLines((current) => [...current.slice(-49), event.payload.line]); setLastLineAt(Date.now()) })
  }, [])
  useEffect(() => {
    if (!installing) return undefined
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(tick)
  }, [installing])

  const brand = <Brand />
  if (status.checking) return <div className="runtime-setup"><div className="runtime-setup-card">{brand}<div className="eyebrow">STARTING</div><h1>Starting HAR</h1></div></div>
  if (!status.installed) return <div className="runtime-setup"><div className="runtime-setup-card">{brand}<div className="eyebrow">INSTALL PROBLEM</div><h1>HAR's runtime is missing</h1><p>This copy of HAR doesn't include its compute runtime, so it can't start. Reinstall HAR from the latest installer.</p>{status.error && <div className="form-error">{status.error}</div>}</div></div>

  const install = async () => {
    setInstalling(true); setError(''); setLines([]); setInstallStartedAt(Date.now()); setLastLineAt(Date.now()); setNow(Date.now())
    try { onFinish(await desktopInvoke('install_torch')) } catch (installError) { setError(installError.toString()) } finally { setInstalling(false) }
  }
  // uv prints "Resolved N packages", then "Prepared N packages" once downloads finish, then "Installed N packages".
  const seen = (prefix) => lines.some((line) => line.startsWith(prefix))
  const phase = seen('Installed') ? 'Restarting HAR...' : seen('Prepared') ? 'Installing...' : seen('Resolved') ? 'Downloading PyTorch...' : 'Preparing...'
  const broken = Boolean(status.torch_error) && !status.torch_error.includes("No module named 'torch'")
  return <div className="runtime-setup"><div className="runtime-setup-card">{brand}
    <div className="eyebrow">ONE-TIME SETUP</div>
    <h1>{broken ? 'Repair PyTorch' : 'Install PyTorch'}</h1>
    <p>{broken ? "PyTorch is installed but failed to load, so HAR can't run work yet. Reinstalling usually fixes it." : "HAR runs your code with PyTorch. It isn't bundled with the app, so HAR installs it once into its own folder. This step needs an internet connection; after that HAR works offline."}</p>
    <div className="setup-detail"><span>Download</span><strong>About 150 MB on a Mac. On Windows with an NVIDIA GPU, about 3 GB (the CUDA build).</strong></div>
    {broken && <div className="setup-detail"><span>Load error</span><strong>{status.torch_error}</strong></div>}
    {installing && <div className="setup-progress" role="progressbar" aria-busy="true" aria-label="Installing PyTorch"><div className="setup-progress-track"><div className="setup-progress-fill indeterminate" /></div><div className="setup-progress-meta"><span>{phase}</span><strong>{Math.max(0, Math.round((now - installStartedAt) / 1000))}s</strong></div>{lines.length > 0 && <div className="setup-log">{lines[lines.length - 1]}</div>}{now - lastLineAt > 90000 && <div className="setup-hint">Big downloads can take a few minutes. If this stays stuck, cancel and try again; finished downloads are kept.</div>}</div>}
    {error && <div className="form-error setup-error">{error}</div>}
    <button className="primary-button setup-button" onClick={install} disabled={installing}>{installing ? 'Installing PyTorch...' : error ? 'Try again' : broken ? 'Reinstall PyTorch' : 'Install PyTorch'}<ArrowRightIcon /></button>
    {installing ? <button className="text-button setup-skip" onClick={() => desktopInvoke('cancel_torch_install').catch(() => {})}>Cancel</button> : <button className="text-button setup-skip" onClick={() => onFinish(null)}>Skip for now</button>}
  </div></div>
}

import { Brand } from '../../app/Sidebar.jsx'
import { Button } from '../../components/Button.jsx'
import { ArrowRightIcon } from '../../components/icons.jsx'
import { TorchInstallProgress } from './TorchInstallProgress.jsx'
import { useTorchInstall } from './useTorchInstall.js'

export const isBrokenTorch = (status) => Boolean(status?.torch_error) && !status.torch_error.includes("No module named 'torch'")

// onFinish(status) after a successful install, onFinish(null) when the person skips.
export function RuntimeSetup({ status, onFinish }) {
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

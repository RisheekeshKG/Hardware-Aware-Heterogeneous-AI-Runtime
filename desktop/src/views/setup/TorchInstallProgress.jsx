export function TorchInstallProgress({ install }) {
  if (!install.installing) return null
  return <div className="setup-progress" role="progressbar" aria-busy="true" aria-label="Installing PyTorch">
    <div className="setup-progress-track"><div className="setup-progress-fill indeterminate" /></div>
    <div className="setup-progress-meta"><span>{install.phase}</span><strong>{install.elapsed}s</strong></div>
    {install.lastLine && <div className="setup-log">{install.lastLine}</div>}
    {install.stalled && <div className="setup-hint">Big downloads can take a few minutes. If this stays stuck, cancel and try again; finished downloads are kept.</div>}
  </div>
}

import { useEffect, useState } from 'react'
import { useToast } from '../../app/ToastProvider.jsx'
import { desktopInvoke, isDesktop } from '../../lib/tauri.js'
import { RuntimeSetup } from './RuntimeSetup.jsx'

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
    return <RuntimeSetup status={status} onFinish={onFinish} />
  }
  return children
}

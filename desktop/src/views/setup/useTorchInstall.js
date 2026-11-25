import { useEffect, useRef, useState } from 'react'
import { useNow } from '../../hooks/useNow.js'
import { desktopInvoke, desktopListen } from '../../lib/tauri.js'

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

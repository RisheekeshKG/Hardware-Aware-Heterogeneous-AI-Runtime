import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/endpoints.js'
import { desktopInvoke, isDesktop } from '../lib/tauri.js'
import { useToast } from './ToastProvider.jsx'

const RuntimeContext = createContext(null)
const POLL_MS = 3000
// The desktop app starts the runtime itself; give it time to boot before reporting a failure.
const STARTUP_GRACE_MS = 20000

const EMPTY = {
  devices: [],
  nodes: [],
  runs: [],
  scripts: [],
  session: null,
  pairing: [],
  trustedHosts: [],
  workerConnection: null,
}

function connectionChangeMessage(previous, next, connection) {
  if (!previous || previous === next) return null
  if (next === 'connected') return `Connected to host ${connection.host_ip}. It can now send tasks to this computer.`
  if (next === 'unreachable' && previous === 'connected') return `Lost contact with host ${connection.host_ip}. Retrying...`
  if (next === 'disconnected') return 'The host disconnected this computer.'
  return null
}

// The single source of runtime data. One 3 s poll, skipped while a request is still in
// flight or the window is hidden. Worker-only endpoints are fetched only in worker role.
//
// status: starting (no answer yet) · live · restarting (after expectRestart) · offline
export function RuntimeProvider({ children }) {
  const notify = useToast()
  const [data, setData] = useState(EMPTY)
  const [status, setStatus] = useState('starting')
  const [error, setError] = useState('')
  const [cpuInfo, setCpuInfo] = useState({ brand: null, frequency_ghz: null })
  // /api/system for this computer (hostname, OS, Python, PyTorch). Changes only on restart.
  const [system, setSystem] = useState(null)
  const inFlight = useRef(null)
  const statusRef = useRef('starting')
  const sessionRef = useRef(null)
  const graceUntil = useRef(Date.now() + STARTUP_GRACE_MS)
  const lastConnectionStatus = useRef(null)

  const setStatusBoth = useCallback((next) => { statusRef.current = next; setStatus(next) }, [])

  const poll = useCallback(() => {
    if (inFlight.current) return inFlight.current
    const run = (async () => {
      try {
        const needSession = !sessionRef.current || statusRef.current !== 'live'
        const [runtime, scripts, session] = await Promise.all([
          api.runtime(),
          api.scripts(),
          needSession ? api.session().catch(() => sessionRef.current) : sessionRef.current,
        ])
        sessionRef.current = session
        if (needSession) api.system().then(setSystem).catch(() => {})
        let worker = { pairing: [], trustedHosts: [], workerConnection: null }
        if (session?.role === 'worker') {
          const [pairing, trustedHosts, workerConnection] = await Promise.all([
            api.pairing().catch(() => []),
            api.trustedHosts().catch(() => []),
            // 404 means the installed runtime predates connection status.
            api.workerConnection().catch((requestError) => requestError.status === 404 ? { status: 'unsupported' } : null),
          ])
          worker = { pairing, trustedHosts, workerConnection }
          const next = workerConnection?.status || null
          const message = connectionChangeMessage(lastConnectionStatus.current, next, workerConnection)
          if (message) notify(message)
          lastConnectionStatus.current = next
        }
        setData({ devices: runtime.devices, nodes: runtime.nodes, runs: runtime.runs, scripts, session, ...worker })
        setError('')
        setStatusBoth('live')
      } catch (requestError) {
        const waiting = isDesktop() && statusRef.current !== 'live' && Date.now() < graceUntil.current
        if (waiting) return
        setError(isDesktop()
          ? `HAR's background service isn't answering (${requestError.message}). If this doesn't clear in a few seconds, restart the app.`
          : `${requestError.message}. Start the API with "har serve".`)
        setStatusBoth('offline')
      }
    })()
    inFlight.current = run
    run.finally(() => { inFlight.current = null })
    return run
  }, [notify, setStatusBoth])

  // After an action, wait out any poll that started before it, then fetch fresh data.
  const refresh = useCallback(async () => {
    if (inFlight.current) await inFlight.current
    return poll()
  }, [poll])

  // Role switches and PyTorch installs restart the runtime: suppress errors while it boots.
  const expectRestart = useCallback(() => {
    graceUntil.current = Date.now() + STARTUP_GRACE_MS
    sessionRef.current = null
    setError('')
    setStatusBoth('restarting')
  }, [setStatusBoth])

  useEffect(() => {
    poll()
    const timer = window.setInterval(() => { if (!document.hidden) poll() }, POLL_MS)
    const onVisible = () => { if (!document.hidden) poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [poll])

  useEffect(() => {
    desktopInvoke('cpu_info').then((info) => info && setCpuInfo(info)).catch(() => {})
  }, [])

  const dropPairing = useCallback((requestId) => {
    setData((current) => ({ ...current, pairing: current.pairing.filter((item) => item.id !== requestId) }))
  }, [])

  const value = useMemo(
    () => ({ ...data, cpuInfo, system, status, error, loading: status === 'starting', refresh, expectRestart, dropPairing }),
    [data, cpuInfo, system, status, error, refresh, expectRestart, dropPairing],
  )
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>
}

export const useRuntime = () => useContext(RuntimeContext)

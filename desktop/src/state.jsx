// Shared app state: live runtime data (one poll every 3 s), which page is open, toasts, confirm dialog.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api, desktopInvoke, isDesktop } from './api.js'
import { ConfirmDialog } from './ui.jsx'

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

const NavigationContext = createContext(null)

// Which page is open, what is selected on it, and which modal is up. Replaces the
// view / selectedRunId / selectedScriptId / show* state that used to live in App.
export function NavigationProvider({ children }) {
  const [state, setState] = useState({ page: 'overview', runId: null, scriptId: null, deviceId: null })
  const [modal, setModal] = useState(null)

  const go = useCallback((page, params = {}) => setState((current) => ({ ...current, ...params, page })), [])
  const selectRun = useCallback((runId) => setState((current) => ({ ...current, runId })), [])
  const selectScript = useCallback((scriptId) => setState((current) => ({ ...current, scriptId })), [])
  const openModal = useCallback((name) => setModal(name), [])
  const closeModal = useCallback(() => setModal(null), [])

  const value = useMemo(
    () => ({ ...state, modal, go, selectRun, selectScript, openModal, closeModal }),
    [state, modal, go, selectRun, selectScript, openModal, closeModal],
  )
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}

export const useNavigation = () => useContext(NavigationContext)

const ToastContext = createContext(() => {})
const TOAST_MS = 2800

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null)
  const timer = useRef(null)
  // Each new toast resets the timer; the old code let an earlier toast's timer
  // clear a newer message early.
  const notify = useCallback((message) => {
    window.clearTimeout(timer.current)
    setToast(message)
    timer.current = window.setTimeout(() => setToast(null), TOAST_MS)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return <ToastContext.Provider value={notify}>
    {children}
    {toast && <div className="toast" role="status"><span className="status-dot" />{toast}</div>}
  </ToastContext.Provider>
}

export const useToast = () => useContext(ToastContext)

const ConfirmContext = createContext(async () => false)

// `await confirm({ title, message, confirmLabel, tone })` → true/false. Replaces window.confirm,
// which can't be styled and blocks the whole webview.
export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null)
  const confirm = useCallback((options) => new Promise((resolve) => setRequest({ ...options, resolve })), [])
  const answer = (value) => { request.resolve(value); setRequest(null) }
  return <ConfirmContext.Provider value={confirm}>
    {children}
    {request && <ConfirmDialog title={request.title} message={request.message} confirmLabel={request.confirmLabel} tone={request.tone} onAnswer={answer} />}
  </ConfirmContext.Provider>
}

export const useConfirm = () => useContext(ConfirmContext)

// confirm → call → toast → refresh, the pattern every button that changes something follows.
// Returns the call's result, or null if it was cancelled or failed (the toast says why).
export function useAction() {
  const notify = useToast()
  const { refresh } = useRuntime()
  const ask = useConfirm()
  // `confirm` is { title, message, confirmLabel, tone } for the ConfirmDialog.
  return useCallback(async ({ confirm, run, success, failure = 'That did not work' }) => {
    if (confirm && !(await ask(confirm))) return null
    try {
      const result = await run()
      if (success) notify(typeof success === 'function' ? success(result) : success)
      await refresh()
      return result ?? true
    } catch (error) {
      notify(`${failure}: ${error.message}`)
      return null
    }
  }, [ask, notify, refresh])
}

// Re-render every `ms` while `active`, for live elapsed times. Idle when nothing is running.
export function useNow(active, ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(timer)
  }, [active, ms])
  return now
}

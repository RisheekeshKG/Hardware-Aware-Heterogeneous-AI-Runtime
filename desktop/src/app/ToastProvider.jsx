import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

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

import { createContext, useCallback, useContext, useState } from 'react'
import { ConfirmDialog } from '../components/ConfirmDialog.jsx'

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

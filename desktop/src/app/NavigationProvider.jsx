import { createContext, useCallback, useContext, useMemo, useState } from 'react'

const NavigationContext = createContext(null)

// Which page is open, what is selected on it, and which modal is up. Replaces the
// view / selectedRunId / selectedScriptId / show* state that used to live in App.
export function NavigationProvider({ children }) {
  const [state, setState] = useState({ page: 'runtime', runId: null, scriptId: null })
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

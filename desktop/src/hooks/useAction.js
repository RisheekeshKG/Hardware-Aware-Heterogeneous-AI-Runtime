import { useCallback } from 'react'
import { useRuntime } from '../app/RuntimeProvider.jsx'
import { useToast } from '../app/ToastProvider.jsx'

// confirm → call → toast → refresh, the pattern every button that changes something follows.
// Returns the call's result, or null if it was cancelled or failed (the toast says why).
export function useAction() {
  const notify = useToast()
  const { refresh } = useRuntime()
  return useCallback(async ({ confirm, run, success, failure = 'That did not work' }) => {
    if (confirm && !window.confirm(confirm)) return null
    try {
      const result = await run()
      if (success) notify(typeof success === 'function' ? success(result) : success)
      await refresh()
      return result ?? true
    } catch (error) {
      notify(`${failure}: ${error.message}`)
      return null
    }
  }, [notify, refresh])
}

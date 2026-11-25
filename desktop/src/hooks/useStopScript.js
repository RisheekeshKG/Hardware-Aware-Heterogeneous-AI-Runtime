import { useCallback } from 'react'
import { api } from '../api/endpoints.js'
import { useConfirm } from '../app/ConfirmProvider.jsx'
import { useRuntime } from '../app/RuntimeProvider.jsx'
import { useToast } from '../app/ToastProvider.jsx'

// Ask, then POST /api/scripts/{id}/stop. The run moves to "stopped" within a few seconds;
// the list shows "Stopping…" meanwhile (stop_requested).
export function useStopScript() {
  const ask = useConfirm()
  const notify = useToast()
  const { refresh } = useRuntime()
  return useCallback(async (script) => {
    const ok = await ask({
      title: `Stop ${script.filename}?`,
      message: script.status === 'queued'
        ? "It hasn't started yet, so it just won't run."
        : 'HAR sends it Ctrl-C (KeyboardInterrupt), then force-stops it and anything it started after 2 seconds. Output so far is kept.',
      confirmLabel: 'Stop script',
    })
    if (!ok) return
    try {
      await api.stopScript(script.id)
      notify(script.status === 'queued' ? `${script.filename} won't run.` : `Stopping ${script.filename}…`)
    } catch (error) {
      // A runtime from before Stop existed has no such route: FastAPI answers 404 "Not Found"
      // (a known run that's gone answers "Script run not found").
      if (error.status === 409) notify(`${script.filename} had already finished.`)
      else if (error.status === 405 || (error.status === 404 && error.message === 'Not Found')) notify("This HAR runtime can't stop scripts. Update HAR.")
      else if (error.status === 404) notify('That run is no longer available.')
      else notify(`Could not stop ${script.filename}: ${error.message}`)
    }
    await refresh()
  }, [ask, notify, refresh])
}

import { useState } from 'react'
import { api } from '../api/endpoints.js'
import { Button } from '../components/Button.jsx'
import { Modal, ModalActions } from '../components/Modal.jsx'
import { ArrowRightIcon } from '../components/icons.jsx'
import { useRuntime } from './RuntimeProvider.jsx'
import { useToast } from './ToastProvider.jsx'

export function PairingPrompt({ request }) {
  const { dropPairing, refresh } = useRuntime()
  const notify = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const decide = async (decision) => {
    setBusy(true); setError('')
    try {
      await api.decidePairing(request.id, decision)
      dropPairing(request.id)
      notify(decision === 'accept' ? 'Connection accepted. This computer will now take tasks from that host.' : 'Connection declined.')
      refresh()
    } catch (decideError) { setError(decideError.message); setBusy(false) }
  }
  const host = (() => { try { return new URL(request.coordinator).hostname } catch { return request.client_ip } })()
  return <Modal role="alertdialog" eyebrow="CONNECTION REQUEST" title="Allow another computer to use this one?" className="pairing-modal">
    <p>The HAR host at <strong>{host}</strong> wants to send tasks to this computer. Accepting lets it run Python files and benchmarks here. Only accept computers you trust.</p>
    <div className="setup-detail"><span>Request from</span><strong>{request.client_ip}</strong></div>
    {error && <div className="form-error">{error}</div>}
    <ModalActions><Button onClick={() => decide('decline')} disabled={busy}>Decline</Button><Button variant="primary" onClick={() => decide('accept')} disabled={busy} iconAfter={<ArrowRightIcon />}>Accept</Button></ModalActions>
  </Modal>
}

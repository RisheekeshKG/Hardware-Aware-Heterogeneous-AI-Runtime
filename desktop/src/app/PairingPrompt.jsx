import { useState } from 'react'
import { API } from '../api/client.js'

export function PairingPrompt({ request, onDecided }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const decide = async (decision) => {
    setBusy(true); setError('')
    try {
      const response = await fetch(`${API}/api/pairing/${request.id}/${decision}`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Could not answer the request')
      onDecided(decision)
    } catch (decideError) { setError(decideError.message); setBusy(false) }
  }
  const host = (() => { try { return new URL(request.coordinator).hostname } catch { return request.client_ip } })()
  return <div className="modal-backdrop"><div className="launcher-modal pairing-modal" role="alertdialog" aria-labelledby="pairing-title"><div className="modal-header"><div><div className="eyebrow">CONNECTION REQUEST</div><h2 id="pairing-title">Allow another computer to use this one?</h2></div></div><p>The HAR host at <strong>{host}</strong> wants to send tasks to this computer. Accepting lets it run Python files and benchmarks here. Only accept computers you trust.</p><div className="setup-detail"><span>Request from</span><strong>{request.client_ip}</strong></div>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => decide('decline')} disabled={busy}>Decline</button><button type="button" className="primary-button" onClick={() => decide('accept')} disabled={busy}>Accept <span>-&gt;</span></button></div></div></div>
}

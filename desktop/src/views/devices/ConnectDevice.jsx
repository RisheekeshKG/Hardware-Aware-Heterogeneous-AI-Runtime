import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/endpoints.js'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { useToast } from '../../app/ToastProvider.jsx'
import { Button } from '../../components/Button.jsx'
import { Field } from '../../components/Field.jsx'
import { Modal, ModalActions } from '../../components/Modal.jsx'
import { ArrowRightIcon } from '../../components/icons.jsx'

export function ConnectDevice({ onClose }) {
  const { refresh } = useRuntime()
  const notify = useToast()
  const onConnected = async () => { onClose(); notify('Device connection requested.'); await refresh() }
  const [workerUrl, setWorkerUrl] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [discovered, setDiscovered] = useState([])
  const [scanning, setScanning] = useState(false)
  const [scannedOnce, setScannedOnce] = useState(false)

  const scan = useCallback(async () => {
    setScanning(true); setError('')
    try {
      setDiscovered(await api.discovery())
      setScannedOnce(true)
    } catch (scanError) { setError(`Could not scan the network: ${scanError.message}`) } finally { setScanning(false) }
  }, [])

  useEffect(() => { scan() }, [scan])

  const connectDiscovered = async (node) => {
    setWaiting(true); setError('')
    try {
      await api.connectDiscovered({ node_id: node.node_id, name: name.trim() || node.name || null })
      await onConnected()
    } catch (connectError) { setError(connectError.message) } finally { setWaiting(false) }
  }

  const submit = async (event) => {
    event.preventDefault(); setError('')
    if (!workerUrl.trim()) { setError("Scan the network above, or type an address."); return }
    setWaiting(true)
    try {
      await api.connectNode({ worker_url: workerUrl.trim(), name: name.trim() || null })
      await onConnected()
    } catch (connectError) { setError(connectError.message) } finally { setWaiting(false) }
  }

  return <Modal eyebrow="ADD DEVICE" title="Connect another computer" onClose={onClose} onSubmit={submit} className="connect-modal">
    <p>HAR workers broadcast themselves on the LAN. Pick one from the scan below, or paste an address if you already know it.</p>

    <div className="section-heading compact" style={{ marginTop: 18 }}><div><span className="eyebrow">HAR USERS ON YOUR NETWORK</span></div><Button variant="text" onClick={scan} disabled={scanning}>{scanning ? 'Scanning…' : 'Scan again'}</Button></div>
    {discovered.length ? <div className="discovered-list">{discovered.map((node) => <div className="discovered-row" key={node.node_id}><div><strong>{node.name || node.node_id}</strong><span>{node.base_url || node.address || node.node_id}</span></div><Button onClick={() => connectDiscovered(node)} disabled={waiting}>Connect</Button></div>)}</div> : <div className="empty-copy">{scannedOnce ? 'No HAR workers found on the LAN. Make sure the other computer is set to Worker.' : 'Scanning for HAR workers...'}</div>}

    <div className="section-heading compact" style={{ marginTop: 22 }}><div><span className="eyebrow">OR CONNECT BY ADDRESS</span></div></div>
    <Field label="Device address"><input value={workerUrl} onChange={(event) => setWorkerUrl(event.target.value)} placeholder="192.168.1.25:9000" disabled={waiting} spellCheck={false} /></Field>
    <Field label="Nickname" optional><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Office computer" /></Field>
    <div className="advanced-note">{waiting ? 'Waiting for someone to click Accept on the other computer (up to 2 minutes)...' : 'Set the other computer to Worker on its Devices page. After you connect, click Accept there.'}</div>
    {error && <div className="form-error">{error}</div>}
    <ModalActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={waiting || !workerUrl.trim()} iconAfter={<ArrowRightIcon />}>{waiting ? 'Waiting for approval…' : 'Connect by address'}</Button></ModalActions>
  </Modal>
}

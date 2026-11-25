import { friendlyBackend } from '../lib/devices.js'

export function BackendBadge({ backend }) { return <span className={`backend-badge ${backend.toLowerCase()}`}>{friendlyBackend(backend)}</span> }
export function StatusBadge({ status }) { return <span className={`status-badge ${status}`}><span className="status-dot" />{status}</span> }

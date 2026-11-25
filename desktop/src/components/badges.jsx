import { backendTag, friendlyBackend } from '../lib/devices.js'

// Short technical tag (CPU / MPS / CUDA); the full name is the tooltip.
export function BackendBadge({ backend }) {
  return <span className={`backend-badge ${String(backend).toLowerCase()}`} title={friendlyBackend(backend)}>{backendTag(backend)}</span>
}

export function StatusBadge({ status }) {
  return <span className={`status-badge ${status}`}><span className="status-dot" />{status}</span>
}

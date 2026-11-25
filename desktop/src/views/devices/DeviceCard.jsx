import { BackendBadge, StatusBadge } from '../../components/badges.jsx'
import { Metric } from '../../components/metrics.jsx'
import { formatBytes } from '../../lib/format.js'

export function DeviceCard({ device, onDisconnect }) {
  const memory = device.memory || {}
  const isRemote = typeof device.kind === 'string' && device.kind.startsWith('OTHER COMPUTER') && device.node_id
  return <article className={`panel device-card-large ${device.state}`}>
    <div className="device-card-head"><div><BackendBadge backend={device.backend} /><span className="device-kind">{device.kind}</span></div><div className="device-card-actions"><StatusBadge status={device.state} />{isRemote && onDisconnect && <button type="button" className="secondary-button device-disconnect" onClick={() => onDisconnect({ node_id: device.node_id, name: device.kind?.split('/').pop()?.trim() || device.node_id })}>Disconnect</button>}</div></div>
    <h2>{device.name}</h2>
    <p>{device.detail}</p>
    <div className="device-metrics"><Metric label="Status" value={device.available === false ? 'Not ready' : 'Ready'} /><Metric label="Free space" value={formatBytes(memory.available_bytes)} /></div>
    <div className="util-track large"><div className={`backend-fill ${device.backend}`} style={{ width: memory.total_bytes && memory.available_bytes != null ? `${Math.min((memory.available_bytes / memory.total_bytes) * 100, 100)}%` : '0%' }} /></div>
    <div className="device-workload"><span>SPACE INFORMATION</span><strong>{memory.estimated ? 'Estimated' : memory.measured ? 'Measured' : 'Not available'}</strong></div>
  </article>
}

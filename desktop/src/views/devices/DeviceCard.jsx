import { api } from '../../api/endpoints.js'
import { BackendBadge, StatusBadge } from '../../components/badges.jsx'
import { MemoryBar } from '../../components/MemoryBar.jsx'
import { Metric } from '../../components/metrics.jsx'
import { useAction } from '../../hooks/useAction.js'
import { formatBytes } from '../../lib/format.js'

export function DeviceCard({ device }) {
  const action = useAction()
  const onDisconnect = ({ node_id, name }) => action({
    confirm: { title: `Disconnect ${name}?`, message: 'HAR will stop sending tasks to it. Anything running there now is marked failed. You can add it again later.', confirmLabel: 'Disconnect' },
    run: () => api.disconnectNode(node_id).catch((error) => { if (error.status !== 404) throw error }),
    success: `${name} disconnected.`,
    failure: 'Could not disconnect',
  })
  const memory = device.memory || {}
  const isRemote = typeof device.kind === 'string' && device.kind.startsWith('OTHER COMPUTER') && device.node_id
  return <article className={`panel device-card-large ${device.state}`}>
    <div className="device-card-head"><div><BackendBadge backend={device.backend} /><span className="device-kind">{device.kind}</span></div><div className="device-card-actions"><StatusBadge status={device.state} />{isRemote && <button type="button" className="secondary-button device-disconnect" onClick={() => onDisconnect({ node_id: device.node_id, name: device.kind?.split('/').pop()?.trim() || device.node_id })}>Disconnect</button>}</div></div>
    <h2>{device.name}</h2>
    <p>{device.detail}</p>
    <div className="device-metrics"><Metric label="Status" value={device.available === false ? 'Not ready' : 'Ready'} /><Metric label="Free space" value={formatBytes(memory.available_bytes)} /></div>
    <MemoryBar memory={memory} backend={device.backend} large />
    <div className="device-workload"><span>SPACE INFORMATION</span><strong>{memory.estimated ? 'Estimated' : memory.measured ? 'Measured' : 'Not available'}</strong></div>
  </article>
}

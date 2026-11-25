import { EmptyState } from '../../components/EmptyState.jsx'
import { PageHeader } from '../../components/PageHeader.jsx'
import { RefreshButton } from '../../components/RefreshButton.jsx'
import { deviceHeading } from '../../lib/devices.js'
import { DeviceCard } from './DeviceCard.jsx'
import { RolePanel } from './RolePanel.jsx'
import { TrustedHostsPanel } from './TrustedHostsPanel.jsx'
import { WorkerConnectionPanel } from './WorkerConnectionPanel.jsx'

export function FabricView({ devices, nodes, cpuInfo, trustedHosts, workerConnection, sessionRole, onConnect, onDisconnect, onRefresh, onRevokeTrustedHost, onStopServing }) {
  const isWorker = sessionRole === 'worker'
  const localAvailable = devices.filter((device) => device.available)
  const local = localAvailable.map((device) => ({ ...device, kind: 'ON THIS COMPUTER', state: 'online', name: deviceHeading(device, cpuInfo), detail: 'Ready to use' }))
  const remoteNodes = nodes.filter((node) => node.name !== 'This device')
  const remote = remoteNodes.flatMap((node) => node.capabilities.filter((device) => device.available !== false).map((device) => ({ ...device, kind: `OTHER COMPUTER / ${node.name}`, state: node.status, name: deviceHeading(device), detail: node.status === 'online' ? 'Ready to use' : 'Not responding', node_id: node.node_id, memory: device.memory || {} })))
  const all = [...local, ...remote]
  const machineCount = (localAvailable.length ? 1 : 0) + remoteNodes.length
  const machinesReady = (localAvailable.length ? 1 : 0) + remoteNodes.filter((node) => node.status === 'online').length
  const runtimesReady = all.filter((device) => device.state === 'online').length
  return <><PageHeader eyebrow="DEVICES" title="Your devices" description="See which computers can help with your tasks." action={<div className="header-actions">{onRefresh && <RefreshButton onClick={onRefresh} title="Refresh devices" />}<button className="primary-button" onClick={onConnect}><span>+</span> Add device</button></div>} /><RolePanel />{isWorker && <WorkerConnectionPanel connection={workerConnection} onStopServing={onStopServing} />}{isWorker && <TrustedHostsPanel hosts={trustedHosts} onRevoke={onRevokeTrustedHost} />}<div className="fabric-banner"><div><span className="status-dot" /><strong>{machinesReady} device{machinesReady === 1 ? '' : 's'} available</strong><span>{runtimesReady} runtime{runtimesReady === 1 ? '' : 's'} across {machineCount} machine{machineCount === 1 ? '' : 's'}</span></div><span className="eyebrow">LIVE STATUS</span></div>{all.length ? <section className="device-grid">{all.map((device, index) => <DeviceCard key={`${device.name}-${index}`} device={device} onDisconnect={onDisconnect} />)}</section> : <EmptyState title="No devices found" detail="Start the HAR service and try again." action="Add device" onAction={onConnect} />}</>
}

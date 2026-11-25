import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { PageHeader } from '../../components/PageHeader.jsx'
import { RefreshButton } from '../../components/RefreshButton.jsx'
import { deviceHeading, machineSummary, plural } from '../../lib/devices.js'
import { DeviceCard } from './DeviceCard.jsx'
import { RolePanel } from './RolePanel.jsx'
import { TrustedHostsPanel } from './TrustedHostsPanel.jsx'
import { WorkerConnectionPanel } from './WorkerConnectionPanel.jsx'

export function FabricView() {
  const { devices, nodes, cpuInfo, session, refresh: onRefresh } = useRuntime()
  const { openModal } = useNavigation()
  const onConnect = () => openModal('connect')
  const isWorker = session?.role === 'worker'
  const { localAvailable, remote: remoteNodes, machineCount, machinesReady, runtimesReady } = machineSummary(devices, nodes)
  const local = localAvailable.map((device) => ({ ...device, kind: 'ON THIS COMPUTER', state: 'online', name: deviceHeading(device, cpuInfo), detail: 'Ready to use' }))
  const remote = remoteNodes.flatMap((node) => node.capabilities.filter((device) => device.available !== false).map((device) => ({ ...device, kind: `OTHER COMPUTER / ${node.name}`, state: node.status, name: deviceHeading(device), detail: node.status === 'online' ? 'Ready to use' : 'Not responding', node_id: node.node_id, memory: device.memory || {} })))
  const all = [...local, ...remote]
  return <><PageHeader eyebrow="DEVICES" title="Your devices" description="See which computers can help with your tasks." action={<div className="header-actions">{onRefresh && <RefreshButton onClick={onRefresh} title="Refresh devices" />}<button className="primary-button" onClick={onConnect}><span>+</span> Add device</button></div>} /><RolePanel />{isWorker && <WorkerConnectionPanel />}{isWorker && <TrustedHostsPanel />}<div className="fabric-banner"><div><span className="status-dot" /><strong>{plural(machinesReady, 'device')} available</strong><span>{plural(runtimesReady, 'runtime')} across {plural(machineCount, 'machine')}</span></div><span className="eyebrow">LIVE STATUS</span></div>{all.length ? <section className="device-grid">{all.map((device, index) => <DeviceCard key={`${device.name}-${index}`} device={device} />)}</section> : <EmptyState title="No devices found" detail="Start the HAR service and try again." action="Add device" onAction={onConnect} />}</>
}

// A host can see a stale registration of its own worker from an older launch under this
// name. It is never "another computer", so every remote-node list filters it out here.
const THIS_DEVICE = 'This device'

export const remoteNodes = (nodes) => (nodes || []).filter((node) => node.name !== THIS_DEVICE)

const availableCapabilities = (node) => (node.capabilities || []).filter((capability) => capability.available !== false)

// Wording rule: a plain word plus the technical tag, e.g. "Apple GPU · MPS".
const BACKENDS = {
  cpu: { name: 'CPU', tag: 'CPU' },
  mps: { name: 'Apple GPU', tag: 'MPS' },
  cuda: { name: 'NVIDIA GPU', tag: 'CUDA' },
  network: { name: 'Network', tag: 'NET' },
  transfer: { name: 'Transfer', tag: 'XFER' },
}
export const backendTag = (backend) => BACKENDS[backend]?.tag || String(backend || '').toUpperCase()
export function friendlyBackend(backend) {
  const known = BACKENDS[backend]
  if (!known) return backend
  return known.name === known.tag ? known.name : `${known.name} · ${known.tag}`
}

export function cpuLabel(device, cpuInfo) {
  const brand = cpuInfo?.brand || device?.details?.cpu_brand || device?.device_name || 'CPU'
  const ghz = cpuInfo?.frequency_ghz ?? device?.details?.frequency_ghz
  return ghz ? `${brand} @ ${ghz} GHz` : brand
}

// The name to show for one backend on one computer. cpuInfo only applies to this computer.
export function backendTitle(device, cpuInfo) {
  if (device?.backend === 'cpu') return cpuLabel(device, cpuInfo)
  if (device?.backend === 'mps') return 'Apple GPU'
  return device?.device_name || BACKENDS[device?.backend]?.name || device?.backend
}

const shortHostname = (hostname) => (hostname || '').replace(/\.(local|lan|home)$/i, '')

// One entry per computer (this one first), each with the backends it can run on.
// `system` is /api/system for this computer, if loaded.
export function computers(devices, nodes, system) {
  const local = {
    id: 'local',
    isLocal: true,
    name: shortHostname(system?.host?.hostname) || 'This computer',
    status: 'online',
    backends: (devices || []).filter((device) => device.available),
    host: system?.host || null,
  }
  const remote = remoteNodes(nodes).map((node) => ({
    id: node.node_id,
    isLocal: false,
    name: node.name || node.node_id,
    status: node.status === 'online' ? 'online' : 'offline',
    backends: availableCapabilities(node),
    host: node.host || null,
    node,
  }))
  return [local, ...remote]
}

// One place for "how many machines / runtimes are ready".
export function machineSummary(devices, nodes) {
  const localAvailable = (devices || []).filter((device) => device.available)
  const remote = remoteNodes(nodes)
  const onlineRemote = remote.filter((node) => node.status === 'online')
  return {
    localAvailable,
    remote,
    onlineRemote,
    machineCount: (localAvailable.length ? 1 : 0) + remote.length,
    machinesReady: (localAvailable.length ? 1 : 0) + onlineRemote.length,
    runtimesReady: localAvailable.length + onlineRemote.reduce((sum, node) => sum + availableCapabilities(node).length, 0),
  }
}

export function backendsForTarget(targetNode, devices, nodes) {
  if (targetNode === 'local') return (devices || []).filter((device) => device.available)
  const node = (nodes || []).find((item) => item.node_id === targetNode)
  return node ? availableCapabilities(node) : []
}

export function nodeLabel(nodeId, nodes) {
  if (!nodeId || nodeId === 'local') return 'This computer'
  const node = (nodes || []).find((item) => item.node_id === nodeId)
  return node?.name || nodeId
}

// Options for a "which computer?" dropdown: this one first, offline ones disabled.
export const computerOptions = (nodes) => [
  { value: 'local', label: 'This computer' },
  ...remoteNodes(nodes).map((node) => ({ value: node.node_id, label: node.name, disabled: node.status !== 'online', hint: node.status === 'online' ? null : 'offline' })),
]

export const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

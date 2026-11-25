// Formatting and labels: sizes, times, backend names ("Apple GPU · MPS"), run statuses.


export const formatBytes = (bytes) => {
  if (bytes == null) return 'Unavailable'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1 }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}

export const formatDuration = (seconds) => {
  if (seconds == null) return 'Unavailable'
  if (seconds < 0.001) return `${(seconds * 1e6).toFixed(1)} us`
  return `${(seconds * 1e3).toFixed(2)} ms`
}

export const formatDate = (value) => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unavailable'

// "just now", "4 min ago", "3 h ago", then the date.
export function formatRelative(value, now = Date.now()) {
  if (!value) return ''
  const seconds = (now - new Date(value).getTime()) / 1000
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`
  return formatDate(value)
}

// Elapsed time: 0.7 s, 42 s, then clock style 2:15, 1:02:09.
export function formatElapsed(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '-'
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.floor(seconds)} s`
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

// A host can see a stale registration of its own worker from an older launch under this
// name. It is never "another computer", so every remote-node list filters it out here.
const THIS_DEVICE = 'This device'

const remoteNodes = (nodes) => (nodes || []).filter((node) => node.name !== THIS_DEVICE)

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

function cpuLabel(device, cpuInfo) {
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

const ACTIVE_STATUSES = ['queued', 'running']
export const isActive = (status) => ACTIVE_STATUSES.includes(status)

const WORKLOADS = { matmul: 'Matrix multiply', image: 'Image model', tree: 'Tree traversal' }
export const workloadLabel = (request) => WORKLOADS[request?.workload] || 'Benchmark'
export function workloadDetail(request) {
  if (!request) return ''
  if (request.workload === 'image') return `batch ${request.batch_size} · ${request.image_size} px`
  if (request.workload === 'tree') return `depth ${request.depth} · ${request.traversal_count} walks`
  return `${request.size} × ${request.size}`
}

// Seconds a script has been going (or went): live while active, final once finished.
export function scriptDuration(script, now = Date.now()) {
  const start = script.started_at || script.created_at
  if (!start) return null
  const end = isActive(script.status) ? now : new Date(script.finished_at || script.updated_at).getTime()
  const seconds = (end - new Date(start).getTime()) / 1000
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

// What the last column of a script row says.
export function scriptOutcome(script) {
  if (script.status === 'running') return script.stop_requested ? 'Stopping…' : 'Running'
  if (script.status === 'queued') return 'Waiting'
  if (script.status === 'stopped') return 'Stopped'
  if (script.timed_out) return 'Timed out'
  return script.exit_code == null ? 'No exit code' : `Exit ${script.exit_code}`
}

// Throughput in the unit that fits the workload. Only matmul reports TFLOP/s;
// image and tree runs report their own rate in `metrics`.
export function benchmarkSpeed(run) {
  const result = run?.result
  if (!result) return 'Unavailable'
  const tflops = result.throughput_tflops?.median
  if (tflops != null) return `${tflops.toFixed(3)} TFLOP/s`
  const images = result.metrics?.median_images_per_second
  if (images != null) return `${Math.round(images).toLocaleString()} images/s`
  const walks = result.metrics?.median_traversals_per_second
  if (walks != null) return `${Math.round(walks).toLocaleString()} walks/s`
  return 'Unavailable'
}

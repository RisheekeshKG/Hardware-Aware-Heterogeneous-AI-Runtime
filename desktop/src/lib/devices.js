export function backendsForTarget(targetNode, devices, nodes) {
  if (targetNode === 'local') return (devices || []).filter((device) => device.available)
  const node = (nodes || []).find((item) => item.node_id === targetNode)
  if (!node) return []
  return (node.capabilities || []).filter((capability) => capability.available !== false)
}

export function nodeLabel(nodeId, nodes) {
  if (!nodeId || nodeId === 'local') return 'This computer'
  const node = (nodes || []).find((item) => item.node_id === nodeId)
  return node?.name || nodeId
}

export function targetMachine(script, devices, nodes) {
  if (!script) return null
  if (script.target_node === 'local') {
    return { name: 'This computer', backends: devices || [], status: 'online' }
  }
  const node = nodes?.find((item) => item.node_id === script.target_node)
  if (!node) return { name: script.target_node, backends: [], status: 'unknown' }
  return { name: node.name, backends: node.capabilities || [], status: node.status }
}
export function backendLineLabel(backend, cpuInfo) {
  if (backend?.backend === 'cpu') return cpuLabel(backend, cpuInfo)
  return backend?.device_name || friendlyBackend(backend?.backend)
}

export function friendlyBackend(backend) { return { cpu: 'CPU', mps: 'Apple graphics', cuda: 'NVIDIA graphics', network: 'Another computer' }[backend] || backend }
export function cpuLabel(device, cpuInfo) {
  const brand = cpuInfo?.brand || device?.details?.cpu_brand || device?.device_name || 'CPU'
  const ghz = cpuInfo?.frequency_ghz ?? device?.details?.frequency_ghz
  return ghz ? `${brand} @ ${ghz} GHz` : brand
}
export function deviceHeading(device, cpuInfo) {
  if (device?.backend === 'cpu') return cpuLabel(device, cpuInfo)
  return device?.device_name || friendlyBackend(device?.backend)
}

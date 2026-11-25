export const ACTIVE_STATUSES = ['queued', 'running']
export const isActive = (status) => ACTIVE_STATUSES.includes(status)

const WORKLOADS = { matmul: 'Matrix multiply', image: 'Image model', tree: 'Tree traversal' }
export const workloadLabel = (request) => WORKLOADS[request?.workload] || 'Benchmark'
export function workloadDetail(request) {
  if (!request) return ''
  if (request.workload === 'image') return `batch ${request.batch_size} · ${request.image_size} px`
  if (request.workload === 'tree') return `depth ${request.depth} · ${request.traversal_count} walks`
  return `${request.size} × ${request.size}`
}

export function scriptTimings(script) {
  const parse = (value) => value ? new Date(value).getTime() : null
  const created = parse(script.created_at)
  const started = parse(script.started_at)
  const finished = parse(script.finished_at)
  const updated = parse(script.updated_at)
  const toSec = (ms) => (Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null)
  const diff = (end, start) => (end != null && start != null ? toSec(end - start) : null)
  const total = diff(finished ?? updated, created)
  const queue = diff(started ?? finished ?? updated, created)
  const execute = script.remote_execute_seconds != null
    ? script.remote_execute_seconds
    : (started != null ? diff(finished ?? updated, started) : null)
  const isRemote = Boolean(script.target_node && script.target_node !== 'local')
  const transport = isRemote && total != null && execute != null && queue != null
    ? Math.max(total - execute - queue, 0)
    : (isRemote ? null : 0)
  return { total, queue, execute, transport, isRemote }
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

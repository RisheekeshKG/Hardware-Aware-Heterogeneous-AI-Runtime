export function scriptElapsed(script) {
  if (!script.created_at || !script.updated_at) return null
  const seconds = (new Date(script.updated_at) - new Date(script.created_at)) / 1000
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
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

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

export function formatSecondsShort(seconds) {
  if (seconds == null) return '-'
  if (seconds < 0.001) return `${(seconds * 1e6).toFixed(0)} µs`
  if (seconds < 1) return `${(seconds * 1e3).toFixed(1)} ms`
  return `${seconds.toFixed(2)} s`
}

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

// Wall-clock style for elapsed time: 0:07, 2:15, 1:02:09.
export function formatElapsed(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '-'
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

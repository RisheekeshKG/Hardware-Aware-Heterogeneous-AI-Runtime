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

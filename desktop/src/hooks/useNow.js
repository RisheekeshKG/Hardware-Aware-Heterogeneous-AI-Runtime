import { useEffect, useState } from 'react'

// Re-render every `ms` while `active`, for live elapsed times. Idle when nothing is running.
export function useNow(active, ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(timer)
  }, [active, ms])
  return now
}

// Free memory as a share of total, in the backend's colour. Empty when either is unknown.
export function MemoryBar({ memory, backend, large = false }) {
  const total = memory?.total_bytes
  const free = memory?.available_bytes
  const width = total && free != null ? `${Math.min((free / total) * 100, 100)}%` : '0%'
  return <div className={`util-track ${large ? 'large' : ''}`.trim()} role="img" aria-label={total ? `${Math.round((free / total) * 100)}% memory free` : 'Memory unknown'}>
    <div className={`backend-fill ${backend}`} style={{ width }} />
  </div>
}

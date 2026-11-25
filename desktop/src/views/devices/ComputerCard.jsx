import { api } from '../../api/endpoints.js'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { Button } from '../../components/Button.jsx'
import { MemoryBar } from '../../components/MemoryBar.jsx'
import { BackendBadge, StatusBadge } from '../../components/badges.jsx'
import { useAction } from '../../hooks/useAction.js'
import { backendTitle } from '../../lib/devices.js'
import { formatBytes } from '../../lib/format.js'

export function hostSummary(host) {
  if (!host) return null
  const os = host.os?.platform?.startsWith('macOS') ? 'macOS' : host.os?.name === 'Windows' ? 'Windows' : host.os?.name
  return [os, host.architecture?.machine, host.runtime?.python_version && `Python ${host.runtime.python_version}`].filter(Boolean).join(' · ')
}

// One card per computer, with one row per backend it can run on.
export function ComputerCard({ computer, footer }) {
  const { cpuInfo } = useRuntime()
  const action = useAction()
  const disconnect = () => action({
    confirm: { title: `Disconnect ${computer.name}?`, message: 'HAR will stop sending tasks to it. Anything running there now is marked failed. You can add it again later.', confirmLabel: 'Disconnect' },
    run: () => api.disconnectNode(computer.id).catch((error) => { if (error.status !== 404) throw error }),
    success: `${computer.name} disconnected.`,
    failure: 'Could not disconnect',
  })
  return <article className={`panel computer-card ${computer.status}`}>
    <div className="computer-card-head">
      <div><span className="eyebrow">{computer.isLocal ? 'THIS COMPUTER' : 'OTHER COMPUTER'}</span><h2>{computer.name}</h2>{hostSummary(computer.host) && <p>{hostSummary(computer.host)}</p>}</div>
      <StatusBadge status={computer.status} />
    </div>
    <div className="backend-rows">
      {computer.backends.length ? computer.backends.map((backend) => <div className="backend-row" key={backend.backend}>
        <BackendBadge backend={backend.backend} />
        <div className="backend-row-main">
          <strong>{backendTitle(backend, computer.isLocal ? cpuInfo : null)}</strong>
          <span>{backend.memory?.total_bytes != null ? `${formatBytes(backend.memory.available_bytes)} free of ${formatBytes(backend.memory.total_bytes)}${backend.memory.estimated ? ' (estimate)' : ''}` : 'Memory unknown'}</span>
          <MemoryBar memory={backend.memory} backend={backend.backend} />
        </div>
      </div>) : <p className="empty-copy">No usable backends reported.</p>}
    </div>
    <div className="computer-card-foot">
      {!computer.isLocal && <Button variant="text" className="danger-text" onClick={disconnect}>Disconnect</Button>}
      {footer}
    </div>
  </article>
}

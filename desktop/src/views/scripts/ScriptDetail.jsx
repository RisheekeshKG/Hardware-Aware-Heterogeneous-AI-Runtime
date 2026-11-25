import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { BackendBadge, StatusBadge } from '../../components/badges.jsx'
import { Metric, Placement } from '../../components/metrics.jsx'
import { useNow } from '../../hooks/useNow.js'
import { useScriptStream } from '../../hooks/useScriptStream.js'
import { backendTitle, nodeLabel, remoteNodes } from '../../lib/devices.js'
import { formatBytes, formatDate, formatElapsed, formatSecondsShort } from '../../lib/format.js'
import { isActive, scriptDuration, scriptOutcome, scriptTimings } from '../../lib/runs.js'

function targetBackends(script, devices, nodes) {
  if (script.target_node === 'local') return { backends: (devices || []).filter((device) => device.available), status: 'online' }
  const node = remoteNodes(nodes).find((item) => item.node_id === script.target_node)
  return node ? { backends: (node.capabilities || []).filter((b) => b.available !== false), status: node.status } : { backends: [], status: 'unknown' }
}

export function ScriptDetail({ script }) {
  const { devices, nodes, cpuInfo } = useRuntime()
  const { liveOutput } = useScriptStream(script.id)
  const now = useNow(isActive(script.status))
  const output = liveOutput || script.output || ''
  const timings = scriptTimings(script)
  const target = targetBackends(script, devices, nodes)
  const running = isActive(script.status)
  return <section className="panel script-detail" aria-label={`Run of ${script.filename}`}>
    <div className="script-detail-head">
      <div><div className="eyebrow">SCRIPT RUN · {script.id}</div><h2>{script.filename}</h2></div>
      <div className="script-detail-actions"><StatusBadge status={script.status} /></div>
    </div>
    <div className="placement-grid">
      <Placement label="Computer" value={nodeLabel(script.target_node, nodes)} />
      <Placement label="Started" value={formatDate(script.started_at || script.created_at)} />
      <Placement label={running ? 'Running for' : 'Took'} value={formatElapsed(scriptDuration(script, now))} />
      <Placement label="Result" value={scriptOutcome(script)} />
    </div>
    {script.args?.length ? <div className="script-args"><span className="eyebrow">ARGUMENTS</span><code>{script.args.join(' ')}</code></div> : null}
    {/* For a crash the error is the stderr tail, already in the output; show it only when it adds something (timeouts, disconnects). */}
    {script.error && script.status !== 'completed' && !output.includes(script.error.trim().slice(-120)) ? <div className="form-error script-error">{script.error}</div> : null}
    <div className="script-output-head"><span className="eyebrow">OUTPUT</span><span>{output ? `${output.length.toLocaleString()} chars${running ? ' · streaming' : ''}` : running ? 'Waiting for output…' : ''}</span></div>
    <pre className="script-output">{output || (running ? 'The script has started. Anything it prints shows up here as it happens.' : 'This script printed nothing.')}</pre>
    <details className="detail-section">
      <summary><span className="eyebrow">TIMING</span><span>{formatSecondsShort(timings.total)} total</span></summary>
      <div className="timings-grid">
        <Metric label="Waiting to start" value={formatSecondsShort(timings.queue)} />
        <Metric label={timings.isRemote ? 'Running there' : 'Running'} value={formatSecondsShort(timings.execute)} />
        <Metric label="Network" value={timings.isRemote ? formatSecondsShort(timings.transport) : 'n/a'} />
        <Metric label="Total" value={formatSecondsShort(timings.total)} />
      </div>
      <p className="detail-note">{timings.isRemote ? 'Network time is sending the script and collecting its output. "Running there" is measured by the other computer\'s own clock.' : 'Local runs have no network time; "waiting" is the queue plus starting Python.'}</p>
    </details>
    <details className="detail-section">
      <summary><span className="eyebrow">HARDWARE ON THAT COMPUTER</span><span>{target.backends.length ? target.backends.map((b) => b.backend.toUpperCase()).join(' · ') : 'Unknown'}</span></summary>
      {target.backends.length ? <div className="hardware-list">{target.backends.map((backend) => <div className="hardware-row" key={backend.backend}>
        <BackendBadge backend={backend.backend} />
        <div><strong>{backendTitle(backend, script.target_node === 'local' ? cpuInfo : null)}</strong><span>{backend.memory?.total_bytes != null ? `${formatBytes(backend.memory.available_bytes)} free of ${formatBytes(backend.memory.total_bytes)}` : (backend.memory?.unavailable_reason || 'Memory unknown')}</span></div>
      </div>)}</div> : <p className="detail-note">That computer is no longer connected.</p>}
      <p className="detail-note">The script chooses which of these to use; HAR doesn't pick for it.</p>
    </details>
  </section>
}

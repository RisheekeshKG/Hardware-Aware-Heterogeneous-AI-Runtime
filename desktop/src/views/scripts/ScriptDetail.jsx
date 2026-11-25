import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { RefreshButton } from '../../components/RefreshButton.jsx'
import { BackendBadge, StatusBadge } from '../../components/badges.jsx'
import { Metric, Placement } from '../../components/metrics.jsx'
import { useScriptStream } from '../../hooks/useScriptStream.js'
import { backendLineLabel, targetMachine } from '../../lib/devices.js'
import { formatBytes, formatDate, formatSecondsShort } from '../../lib/format.js'
import { scriptTimings } from '../../lib/runs.js'

export function ScriptDetail({ script, onClose }) {
  const { devices, nodes, cpuInfo, refresh: onRefresh } = useRuntime()
  const { liveOutput } = useScriptStream(script.id)
  const output = liveOutput || script.output || ''
  const hasOutput = Boolean(output && output.length)
  const machine = targetMachine(script, devices, nodes)
  const isLocal = script.target_node === 'local'
  const machineCpuInfo = isLocal ? cpuInfo : null
  return <section className="panel script-detail">
    <div className="section-heading compact"><div><div className="eyebrow">SCRIPT DETAIL</div><h2>{script.filename}</h2></div><div className="script-detail-actions"><StatusBadge status={script.status} />{onRefresh && <RefreshButton onClick={onRefresh} title="Refresh this script" />}{onClose && <button type="button" className="close-button" onClick={onClose} aria-label="Close script detail">X</button>}</div></div>
    <div className="placement-grid">
      <Placement label="Machine" value={machine?.name || '-'} />
      <Placement label="Started" value={formatDate(script.created_at)} />
      <Placement label="Total time" value={formatSecondsShort(scriptTimings(script).total)} />
      <Placement label={scriptTimings(script).isRemote ? 'Transport' : 'Overhead'} value={formatSecondsShort(scriptTimings(script).transport)} accent={scriptTimings(script).isRemote ? 'transfer' : ''} />
    </div>
    {(() => {
      const timings = scriptTimings(script)
      return <div className="timings-block"><div className="timings-head"><span className="eyebrow">TIMING BREAKDOWN</span></div><div className="timings-grid"><Metric label="Queue wait" value={formatSecondsShort(timings.queue)} /><Metric label={timings.isRemote ? 'Remote execute' : 'Execute'} value={formatSecondsShort(timings.execute)} /><Metric label="Transport" value={formatSecondsShort(timings.transport)} /><Metric label="Total" value={formatSecondsShort(timings.total)} /></div><div className="policy-note"><span className="status-dot preview" /><span>{timings.isRemote ? 'Transport covers host↔worker HTTP + polling. Remote execute comes from the worker’s own clock.' : 'Local runs have near-zero transport. Overhead is queue + runtime setup.'}</span></div></div>
    })()}
    {machine && machine.backends.length ? <div className="hardware-block"><div className="hardware-head"><span className="eyebrow">HARDWARE AVAILABLE ON TARGET</span>{machine.status && machine.status !== 'online' ? <StatusBadge status={machine.status} /> : null}</div><div className="hardware-list">{machine.backends.filter((b) => b.available !== false).map((backend) => <div className="hardware-row" key={backend.backend}><BackendBadge backend={backend.backend} /><div><strong>{backendLineLabel(backend, machineCpuInfo)}</strong><span>{backend.memory?.total_bytes != null ? `${formatBytes(backend.memory.available_bytes)} free / ${formatBytes(backend.memory.total_bytes)}` : (backend.memory?.unavailable_reason || 'Memory unavailable')}</span></div></div>)}</div><div className="policy-note"><span className="status-dot preview" /><span>The script picks which of these to use at runtime. HAR shows every backend available on the target.</span></div></div> : null}
    {script.args?.length ? <div className="script-args"><span className="eyebrow">ARGUMENTS</span><code>{script.args.join(' ')}</code></div> : null}
    {script.error ? <div className="form-error" style={{ marginTop: 14 }}>{script.error}</div> : null}
    <div className="script-output-head"><span className="eyebrow">OUTPUT (STDOUT + STDERR)</span><span>{hasOutput ? `${output.length} chars${script.status === 'running' ? ' — streaming' : ''}` : (script.status === 'running' ? 'Waiting for the script to produce output...' : 'No output')}</span></div>
    <pre className="script-output">{hasOutput ? output : (script.status === 'running' ? 'Script is starting. Output will stream here as it is produced.' : (script.status === 'failed' ? (script.error || 'Script failed with no output.') : 'No output.'))}</pre>
  </section>
}

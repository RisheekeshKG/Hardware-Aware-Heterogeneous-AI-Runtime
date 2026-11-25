import { StatusBadge } from '../../components/badges.jsx'
import { nodeLabel } from '../../lib/devices.js'
import { formatDate } from '../../lib/format.js'
import { scriptElapsed } from '../../lib/runs.js'

export function ScriptRow({ script, active, onClick, nodes }) {
  const elapsed = scriptElapsed(script)
  const argsText = script.args?.length ? script.args.join(' ') : ''
  return <button type="button" className={`workload-row script-row ${active ? 'active' : ''}`} onClick={onClick}>
    <div className="workload-id"><span className={`workload-pulse ${script.status}`} /><div><strong>{script.filename}</strong><span>{argsText ? `${argsText} · ` : ''}{formatDate(script.created_at)}</span></div></div>
    <div className="row-placement"><span>{nodeLabel(script.target_node, nodes)}</span></div>
    <div className="row-progress"><span>{elapsed != null ? `${elapsed.toFixed(2)} s` : (script.status === 'running' ? 'Running...' : '-')}</span></div>
    <StatusBadge status={script.status} />
    <div className="row-time">{script.exit_code == null ? (script.status === 'failed' ? 'Error' : script.status === 'running' ? 'Running' : 'Pending') : `Exit ${script.exit_code}`}</div>
  </button>
}

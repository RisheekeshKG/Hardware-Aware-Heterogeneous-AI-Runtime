import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { StatusBadge } from '../../components/badges.jsx'
import { nodeLabel } from '../../lib/devices.js'
import { formatElapsed, formatRelative } from '../../lib/format.js'
import { scriptDuration, scriptOutcome } from '../../lib/runs.js'

// One script run in a list. Clicking opens it on the Scripts page.
export function ScriptRow({ script, selected = false }) {
  const { nodes } = useRuntime()
  const { go } = useNavigation()
  const args = script.args?.length ? script.args.join(' ') : ''
  return <button type="button" className={`script-row ${selected ? 'selected' : ''}`.trim()} aria-current={selected ? 'true' : undefined} onClick={() => go('scripts', { scriptId: script.id })}>
    <span className={`workload-pulse ${script.status}`} />
    <span className="script-row-main">
      <strong>{script.filename}{args && <em> {args}</em>}</strong>
      <span>{nodeLabel(script.target_node, nodes)} · <time dateTime={script.created_at} title={new Date(script.created_at).toLocaleString()}>{formatRelative(script.created_at)}</time></span>
    </span>
    <span className="script-row-time">{formatElapsed(scriptDuration(script))}</span>
    <span className="script-row-outcome">{scriptOutcome(script)}</span>
    <StatusBadge status={script.status} />
  </button>
}

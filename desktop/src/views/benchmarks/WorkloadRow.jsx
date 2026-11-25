import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { BackendBadge, StatusBadge } from '../../components/badges.jsx'
import { nodeLabel } from '../../lib/devices.js'
import { formatDate } from '../../lib/format.js'

export function WorkloadRow({ run, onClick }) { const { nodes } = useRuntime(); const total = run.request.measured_iterations || 1; const progress = Math.round((run.completed_iterations / total) * 100); return <button className="workload-row" onClick={onClick}><div className="workload-id"><span className={`workload-pulse ${run.status}`} /><div><strong>Matrix calculation</strong><span>{run.request.size} x {run.request.size} · {formatDate(run.created_at)}</span></div></div><div className="row-placement"><BackendBadge backend={run.request.backend} /><span>{nodeLabel(run.node_id, nodes)}</span></div><div className="row-progress"><div className="progress-track"><div style={{ width: `${progress}%` }} /></div><span>{run.status === 'completed' ? '100%' : `${progress}%`}</span></div><StatusBadge status={run.status} /><div className="row-time">{formatDate(run.updated_at)}</div></button> }

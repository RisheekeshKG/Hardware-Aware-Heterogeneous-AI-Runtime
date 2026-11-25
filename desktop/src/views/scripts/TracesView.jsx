import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { Dropdown } from '../../components/Dropdown.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { PageHeader } from '../../components/PageHeader.jsx'
import { RefreshButton } from '../../components/RefreshButton.jsx'
import { formatDate } from '../../lib/format.js'
import { ScriptDetail } from './ScriptDetail.jsx'

export function TracesView() {
  const { scripts, refresh: onRefresh } = useRuntime()
  const { scriptId: selectedScriptId, selectScript: onSelectScript, openModal } = useNavigation()
  const onScriptLaunch = () => openModal('script')
  const selectedScript = scripts.find((script) => script.id === selectedScriptId) || scripts[0] || null
  return <>
    <PageHeader eyebrow="SCRIPT ACTIVITY" title="Activity" description="See what each Python run did: where it ran, how long it took, and its output." action={<div className="header-actions">{onRefresh && <RefreshButton onClick={onRefresh} title="Refresh" />}<Dropdown ariaLabel="Choose a script run" placeholder="Choose a script run" value={selectedScript?.id || ''} onChange={(next) => onSelectScript(next || null)} options={scripts.map((item) => ({ value: item.id, label: `${item.filename}  ·  ${formatDate(item.created_at)}` }))} /></div>} />
    {!selectedScript ? <EmptyState title="No script runs yet" detail="Write a script first, then its activity shows up here." action="New script" onAction={onScriptLaunch} /> : <ScriptDetail script={selectedScript} />}
  </>
}

import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { PageHeader } from '../../components/PageHeader.jsx'
import { ScriptDetail } from './ScriptDetail.jsx'
import { ScriptRow } from './ScriptRow.jsx'

export function WorkloadsView() {
  const { scripts } = useRuntime()
  const { scriptId: selectedScriptId, selectScript: onSelectScript, openModal } = useNavigation()
  const onScriptLaunch = () => openModal('script')
  const selectedScript = scripts.find((script) => script.id === selectedScriptId) || null
  return <>
    <PageHeader eyebrow="SCRIPTS" title="Run Python" description="Write a Python script, pick a device, see what it printed and whether it finished cleanly." action={<button className="primary-button" onClick={onScriptLaunch}><span>+</span> New script</button>} />
    <section className="panel launch-card">
      <div className="eyebrow">GET STARTED</div>
      <h2>Write Python in HAR</h2>
      <p>Type your script, pick where it runs, see its stdout and exit code here. @har.offload-decorated functions get routed per call; the rest runs in-process.</p>
      <button className="large-launch" onClick={onScriptLaunch}><span className="launch-icon">-&gt;</span><span><strong>Write a new script</strong><small>Opens an in-app editor; you can also load an existing .py file to seed it</small></span><span className="arrow">+</span></button>
      <div className="policy-note"><span className="status-dot" /><span>Scripts run in a temporary job folder on the selected device.</span></div>
    </section>
    <section className="section-block">
      <div className="section-heading"><div><div className="eyebrow">SCRIPT HISTORY</div><h2>Your Python runs</h2></div>{scripts.length ? <span className="chart-meta">{scripts.length} run{scripts.length === 1 ? '' : 's'}</span> : null}</div>
      {scripts.length ? <div className="workload-list">{scripts.map((script) => <ScriptRow key={script.id} script={script} active={script.id === selectedScriptId} />)}</div> : <EmptyState title="No Python runs yet" detail="Write a script to see output and status here." action="New script" onAction={onScriptLaunch} />}
      {selectedScript && <ScriptDetail script={selectedScript} onClose={() => onSelectScript(null)} />}
    </section>
  </>
}

import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { Button } from '../../components/Button.jsx'
import { PageHeader } from '../../components/PageHeader.jsx'
import { RefreshButton } from '../../components/RefreshButton.jsx'
import { ArrowRightIcon, PlusIcon } from '../../components/icons.jsx'
import { plural } from '../../lib/devices.js'
import { ScriptDetail } from './ScriptDetail.jsx'
import { ScriptRow } from './ScriptRow.jsx'

// History on the left, the selected run on the right (stacked below 1280 px).
// Replaces the old Scripts + Activity pages, which showed the same runs twice.
export function ScriptsView() {
  const { scripts, refresh } = useRuntime()
  const { scriptId, openModal } = useNavigation()
  const selected = scripts.find((script) => script.id === scriptId) || scripts[0] || null
  return <>
    <PageHeader eyebrow="SCRIPTS" title="Scripts" description="Run Python on any of your computers and watch what it prints." action={<div className="header-actions"><RefreshButton onClick={refresh} title="Refresh scripts" /><Button variant="primary" icon={<PlusIcon />} onClick={() => openModal('script')}>New script</Button></div>} />
    {scripts.length ? <div className="scripts-layout">
      <section className="panel script-history" aria-label="Script runs">
        <div className="list-heading"><span className="eyebrow">HISTORY</span><span className="chart-meta">{plural(scripts.length, 'run')}</span></div>
        <div className="script-list">{scripts.map((script) => <ScriptRow key={script.id} script={script} selected={script.id === selected?.id} />)}</div>
      </section>
      {selected && <ScriptDetail key={selected.id} script={selected} />}
    </div> : <FirstScript onStart={() => openModal('script')} />}
  </>
}

function FirstScript({ onStart }) {
  return <section className="panel launch-card">
    <div className="eyebrow">GET STARTED</div>
    <h2>Run your first script</h2>
    <p>Write Python in HAR's editor, or load a .py file, and pick which computer runs it. Functions decorated with <code>@har.offload</code> are sent to the best device for each call; the rest runs as normal.</p>
    <button className="large-launch" onClick={onStart}><span className="launch-icon"><ArrowRightIcon /></span><span><strong>Write a new script</strong><small>Opens the editor. You can load an existing .py file there.</small></span><span className="arrow"><PlusIcon /></span></button>
    <div className="policy-note"><span className="status-dot" /><span>Each run gets a fresh temporary folder on the computer you pick.</span></div>
  </section>
}

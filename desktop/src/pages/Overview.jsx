// Overview: what's running now, your computers, recent scripts.
import { computers, formatElapsed, isActive, machineSummary, nodeLabel, plural, scriptDuration } from '../helpers.js'
import { ScriptRow, useStopScript } from '../pages/Scripts.jsx'
import { useNavigation, useNow, useRuntime } from '../state.jsx'
import { ArrowRightIcon, BackendBadge, Button, IconButton, Pane, PlusIcon, ScriptsIcon, StatusBadge, StopIcon, Workspace } from '../ui.jsx'

export function OverviewPage() {
  const { scripts, devices, nodes, system } = useRuntime()
  const { go } = useNavigation()
  const active = scripts.filter((script) => isActive(script.status))
  const queued = active.filter((script) => script.status === 'queued').length
  const recent = scripts.filter((script) => !isActive(script.status)).slice(0, 8)
  const completed = scripts.filter((script) => script.status === 'completed').length
  const failed = scripts.filter((script) => script.status === 'failed').length
  const summary = machineSummary(devices, nodes)
  const runtime = system?.host?.runtime
  return <Workspace title="Overview" note="What's running, and which computers can take work" actions={<Button variant="primary" icon={<ScriptsIcon />} onClick={() => go('scripts')}>Open editor</Button>}>
    <div className="workspace-scroll">
      <div className="stat-strip">
        <Stat tone="accent" label="Running" value={active.length - queued} detail={queued ? `${queued} waiting` : 'nothing waiting'} />
        <Stat tone="cpu" label="Computers ready" value={summary.machinesReady} detail={plural(summary.runtimesReady, 'backend')} />
        <Stat tone="success" label="Finished" value={completed} detail={failed ? `${failed} failed` : 'no failures'} />
        <Stat tone="warning" label="PyTorch" value={runtime ? (runtime.pytorch_version || 'missing') : '…'} detail={runtime?.pytorch_version ? `Python ${runtime.python_version}` : 'install it in Settings'} />
      </div>
      <div className="pane-grid">
        <RunningPane scripts={active} />
        <ComputersPane />
      </div>
      <Pane title="RECENT SCRIPTS" meta={recent.length || ''} actions={scripts.length ? <Button variant="text" iconAfter={<ArrowRightIcon />} onClick={() => go('scripts')}>All in editor</Button> : null}>
        {recent.length
          ? <div className="script-list">{recent.map((script) => <ScriptRow key={script.id} script={script} />)}</div>
          : <p className="pane-empty">Finished scripts show up here with their result.</p>}
      </Pane>
    </div>
  </Workspace>
}

function Stat({ tone, label, value, detail }) {
  return <div className={`stat ${tone}`}><span className="eyebrow">{label}</span><strong>{value}</strong><span>{detail}</span></div>
}

function RunningPane({ scripts }) {
  const { nodes } = useRuntime()
  const { go } = useNavigation()
  const now = useNow(scripts.length > 0)
  const stop = useStopScript()
  return <Pane title="RUNNING NOW" meta={scripts.length || ''}>
    {scripts.length
      ? <ul className="row-list">{scripts.map((script) => <li key={script.id} className="row-with-action">
          <button type="button" className="list-row" onClick={() => go('scripts', { scriptId: script.id })}>
            <span className={`workload-pulse ${script.status}`} />
            <span className="list-row-main"><strong>{script.filename}</strong><span>{nodeLabel(script.target_node, nodes)}{script.stop_requested ? ' · stopping…' : ''}</span></span>
            <span className="list-row-time">{formatElapsed(scriptDuration(script, now))}</span>
            <StatusBadge status={script.status} />
          </button>
          <IconButton className="stop-icon" label={`Stop ${script.filename}`} icon={<StopIcon />} disabled={script.stop_requested} onClick={() => stop(script)} />
        </li>)}</ul>
      : <div className="pane-empty">HAR is idle.<Button icon={<PlusIcon />} onClick={() => go('scripts')}>Write a script</Button></div>}
  </Pane>
}

function ComputersPane() {
  const { devices, nodes, system } = useRuntime()
  const { go } = useNavigation()
  const list = computers(devices, nodes, system)
  const ready = list.filter((computer) => computer.status === 'online').length
  return <Pane title="COMPUTERS" meta={`${ready} of ${list.length} ready`} actions={<Button variant="text" iconAfter={<ArrowRightIcon />} onClick={() => go('devices')}>Devices</Button>}>
    <ul className="row-list">{list.map((computer) => <li key={computer.id}>
      <button type="button" className={`list-row ${computer.status}`} onClick={() => go('devices', { deviceId: computer.id })}>
        <span className={`status-dot ${computer.status === 'online' ? '' : 'offline'}`} />
        <span className="list-row-main"><strong>{computer.name}</strong><span>{computer.isLocal ? 'This computer' : computer.status === 'online' ? 'Other computer' : 'Not responding'}</span></span>
        <span className="badge-row">{computer.backends.map((backend) => <BackendBadge key={backend.backend} backend={backend.backend} />)}</span>
      </button>
    </li>)}</ul>
  </Pane>
}

import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { Button } from '../../components/Button.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { PageHeader } from '../../components/PageHeader.jsx'
import { SectionHeading } from '../../components/SectionHeading.jsx'
import { BackendBadge, StatusBadge } from '../../components/badges.jsx'
import { ArrowRightIcon, PlusIcon } from '../../components/icons.jsx'
import { StatCard } from '../../components/metrics.jsx'
import { useNow } from '../../hooks/useNow.js'
import { computers, machineSummary, nodeLabel, plural } from '../../lib/devices.js'
import { formatElapsed } from '../../lib/format.js'
import { isActive, scriptDuration } from '../../lib/runs.js'
import { ScriptRow } from '../scripts/ScriptRow.jsx'

const pad = (count) => String(count).padStart(2, '0')

export function OverviewView() {
  const { scripts, devices, nodes, system } = useRuntime()
  const { go, openModal } = useNavigation()
  const active = scripts.filter((script) => isActive(script.status))
  const recent = scripts.filter((script) => !isActive(script.status)).slice(0, 6)
  const queued = active.filter((script) => script.status === 'queued').length
  const completed = scripts.filter((script) => script.status === 'completed').length
  const failed = scripts.filter((script) => script.status === 'failed').length
  const summary = machineSummary(devices, nodes)
  const runtime = system?.host?.runtime
  return <>
    <PageHeader eyebrow="HAR" title="Overview" description="What's running, and which computers can take work." action={<Button variant="primary" icon={<PlusIcon />} onClick={() => openModal('script')}>New script</Button>} />
    <section className="stat-grid">
      <StatCard label="Running now" value={pad(active.length - queued)} detail={queued ? `${queued} waiting for a slot` : 'Nothing waiting'} accent="lime" />
      <StatCard label="Computers ready" value={pad(summary.machinesReady)} detail={`${plural(summary.runtimesReady, 'backend')} across them`} accent="blue" />
      <StatCard label="Finished" value={pad(completed)} detail={failed ? `${failed} failed` : 'No failures'} accent="green" />
      <StatCard label="PyTorch" value={runtime ? (runtime.pytorch_version || 'Missing') : '—'} detail={runtime ? (runtime.pytorch_version ? `Python ${runtime.python_version}` : 'Install it in Settings') : 'Checking…'} accent="amber" />
    </section>
    <section className="overview-grid">
      <RunningPanel scripts={active} />
      <ComputersPanel />
    </section>
    <section className="section-block">
      <SectionHeading eyebrow="RECENT" title="Recent scripts" action={scripts.length ? <Button variant="text" iconAfter={<ArrowRightIcon />} onClick={() => go('scripts')}>All scripts</Button> : null} />
      {recent.length
        ? <div className="script-list">{recent.map((script) => <ScriptRow key={script.id} script={script} />)}</div>
        : <EmptyState title="No finished scripts yet" detail="Write a Python script and pick a computer to run it on. Its output and exit code show up here." action="New script" onAction={() => openModal('script')} />}
    </section>
  </>
}

function RunningPanel({ scripts }) {
  const { nodes } = useRuntime()
  const { go, openModal } = useNavigation()
  const now = useNow(scripts.length > 0)
  return <article className="panel running-panel">
    <SectionHeading compact eyebrow="RUNNING NOW" title={scripts.length ? plural(scripts.length, 'script') : 'Nothing is running'} />
    {scripts.length
      ? <ul className="running-list">{scripts.map((script) => <li key={script.id}>
          <button type="button" className="running-item" onClick={() => go('scripts', { scriptId: script.id })}>
            <span className={`workload-pulse ${script.status}`} />
            <span className="running-item-main"><strong>{script.filename}</strong><span>{nodeLabel(script.target_node, nodes)}</span></span>
            <span className="running-item-time">{formatElapsed(scriptDuration(script, now))}</span>
            <StatusBadge status={script.status} />
          </button>
        </li>)}</ul>
      : <><p className="empty-copy">HAR is idle. Start a script and you can watch its output here while it runs.</p><Button icon={<PlusIcon />} onClick={() => openModal('script')}>New script</Button></>}
  </article>
}

function ComputersPanel() {
  const { devices, nodes, system } = useRuntime()
  const { go } = useNavigation()
  const list = computers(devices, nodes, system)
  const ready = list.filter((computer) => computer.status === 'online').length
  return <article className="panel computers-panel">
    <SectionHeading compact eyebrow="YOUR COMPUTERS" title={`${ready} of ${list.length} ready`} />
    <ul className="computer-rows">{list.map((computer) => <li key={computer.id} className={`computer-row ${computer.status}`}>
      <span className={`status-dot ${computer.status === 'online' ? '' : 'offline'}`} />
      <span className="computer-row-main"><strong>{computer.name}</strong><span>{computer.isLocal ? 'This computer' : computer.status === 'online' ? 'Other computer' : 'Not responding'}</span></span>
      <span className="computer-row-backends">{computer.backends.map((backend) => <BackendBadge key={backend.backend} backend={backend.backend} />)}</span>
    </li>)}</ul>
    <Button iconAfter={<ArrowRightIcon />} onClick={() => go('devices')}>See devices</Button>
  </article>
}

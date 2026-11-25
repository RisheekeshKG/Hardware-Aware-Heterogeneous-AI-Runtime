import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { Button } from '../../components/Button.jsx'
import { PageHeader } from '../../components/PageHeader.jsx'
import { RefreshButton } from '../../components/RefreshButton.jsx'
import { ArrowRightIcon, PlusIcon } from '../../components/icons.jsx'
import { computers } from '../../lib/devices.js'
import { ComputerCard } from './ComputerCard.jsx'
import { TrustedHostsPanel } from './TrustedHostsPanel.jsx'
import { WorkerConnectionPanel } from './WorkerConnectionPanel.jsx'

const ROLE_LINE = {
  host: 'This computer is the host: it runs scripts and can send them to computers you add.',
  worker: 'This computer is a worker: a host on your network can send scripts here.',
  standalone: 'This computer is standalone: it only runs its own scripts and is not reachable from the network.',
}

export function DevicesView() {
  const { devices, nodes, system, session, refresh } = useRuntime()
  const { go, openModal } = useNavigation()
  const role = session?.role
  const list = computers(devices, nodes, system)
  const canAdd = role !== 'worker' && role !== 'standalone'
  return <>
    <PageHeader eyebrow="DEVICES" title="Devices" description="The computers HAR can send work to, and what each one can run on." action={<div className="header-actions"><RefreshButton onClick={refresh} title="Refresh devices" />{canAdd && <Button variant="primary" icon={<PlusIcon />} onClick={() => openModal('connect')}>Add device</Button>}</div>} />
    {role && <div className="role-summary"><span>{ROLE_LINE[role] || `Role: ${role}`}</span><Button variant="text" iconAfter={<ArrowRightIcon />} onClick={() => go('settings')}>Change role</Button></div>}
    {role === 'worker' && <WorkerConnectionPanel />}
    {role === 'worker' && <TrustedHostsPanel />}
    <section className="computer-grid">
      {list.map((computer) => <ComputerCard key={computer.id} computer={computer} />)}
      {canAdd && list.length === 1 && <button type="button" className="add-computer-card" onClick={() => openModal('connect')}>
        <PlusIcon /><strong>Add another computer</strong><span>Set HAR to Worker on the other computer, then connect it here. Both must be on the same network.</span>
      </button>}
    </section>
  </>
}

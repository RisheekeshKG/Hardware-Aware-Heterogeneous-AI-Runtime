import { Fragment } from 'react'
import { machineSummary, plural } from '../lib/devices.js'
import { navGroups, navItems, subPages } from './navigation.js'
import { useNavigation } from './NavigationProvider.jsx'
import { useRuntime } from './RuntimeProvider.jsx'

export function Brand() {
  return <div className="brand"><div className="brand-mark">H</div><div><strong>HAR</strong><span>runtime console</span></div></div>
}

const STATUS_TEXT = {
  starting: { label: 'Starting', dot: 'warn' },
  restarting: { label: 'Restarting', dot: 'warn' },
  live: { label: 'Connected', dot: '' },
  offline: { label: 'Not connected', dot: 'error' },
}

export function Sidebar() {
  const { page, go } = useNavigation()
  const { devices, nodes, status, workerConnection, session } = useRuntime()
  const { machinesReady } = machineSummary(devices, nodes)
  const activePage = subPages[page]?.parent || page
  const state = STATUS_TEXT[status] || STATUS_TEXT.offline
  const detail = status !== 'live'
    ? (status === 'offline' ? 'HAR service not answering' : 'Waiting for HAR service…')
    : workerConnection?.status === 'connected'
      ? `Working for host ${workerConnection.host_ip}`
      : `${plural(machinesReady, 'computer')} ready${session?.role ? ` · ${session.role}` : ''}`
  return <aside className="sidebar">
    <Brand />
    {navGroups.map((group) => <Fragment key={group.id}>
      <div className={`nav-group-label ${group.id === 'devtools' ? 'devtools' : ''}`}>{group.label}</div>
      <nav className="main-nav" aria-label={`${group.label} navigation`}>
        {navItems.filter((item) => item.group === group.id).map(({ id, label, Icon }) => <button key={id} className={`nav-item ${activePage === id ? 'active' : ''}`} aria-current={activePage === id ? 'page' : undefined} onClick={() => go(id)}><span className="nav-icon"><Icon /></span><span>{label}</span></button>)}
      </nav>
    </Fragment>)}
    <div className="sidebar-spacer" />
    <div className="connection-status" role="status"><span className={`status-dot ${state.dot}`} /><span>{state.label}</span><small>{detail}</small></div>
  </aside>
}

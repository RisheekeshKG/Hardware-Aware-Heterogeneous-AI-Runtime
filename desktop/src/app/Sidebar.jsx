import { Fragment } from 'react'
import { machineSummary, plural } from '../lib/devices.js'
import { navGroups, navItems } from './navigation.js'
import { useNavigation } from './NavigationProvider.jsx'
import { useRuntime } from './RuntimeProvider.jsx'

export function Brand() {
  return <div className="brand"><div className="brand-mark">H</div><div><strong>HAR</strong><span>runtime console</span></div></div>
}

export function Sidebar() {
  const { page, go } = useNavigation()
  const { devices, nodes, error, loading, workerConnection } = useRuntime()
  const { machinesReady } = machineSummary(devices, nodes)
  return <aside className="sidebar">
    <Brand />
    {navGroups.map((group) => <Fragment key={group.id}><div className={`nav-group-label ${group.id === 'devtools' ? 'devtools' : ''}`}>{group.label}</div><nav className="main-nav" aria-label={`${group.label} navigation`}>{navItems.filter((item) => item.group === group.id).map((item) => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => go(item.id)}><span className="nav-icon">{item.icon}</span><span>{item.label}</span></button>)}</nav></Fragment>)}
    <div className="sidebar-spacer" />
    <div className="sidebar-note"><span className="eyebrow">HAR STATUS</span><strong>{error ? 'Needs attention' : 'Ready to help'}</strong><span>{loading ? 'Checking your devices...' : workerConnection?.status === 'connected' ? `Working for host ${workerConnection.host_ip}` : 'Connected to this computer'}</span></div>
    <div className="connection-status"><span className={`status-dot ${error ? 'error' : ''}`} /><span>{error ? 'NOT CONNECTED' : 'CONNECTED'}</span><small>{loading ? 'Checking devices...' : `${plural(machinesReady, 'machine')} ready`}</small></div>
  </aside>
}

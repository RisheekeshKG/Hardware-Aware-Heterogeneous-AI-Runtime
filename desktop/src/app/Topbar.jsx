import { Button, IconButton } from '../components/Button.jsx'
import { RefreshIcon } from '../components/icons.jsx'
import { navItems, subPages } from './navigation.js'
import { useNavigation } from './NavigationProvider.jsx'
import { useRuntime } from './RuntimeProvider.jsx'

export function Topbar() {
  const { page, deviceId, go } = useNavigation()
  const { status, refresh, nodes } = useRuntime()
  const parent = subPages[page]?.parent
  const current = navItems.find((item) => item.id === (parent || page))
  const deviceName = deviceId === 'local' ? 'This computer' : nodes.find((node) => node.node_id === deviceId)?.name || 'Device'
  return <header className="topbar">
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <span>HAR</span><i>/</i>
      {parent ? <><button className="crumb-link" onClick={() => go(parent)}>{current?.label}</button><i>/</i><strong>{deviceName}</strong></> : <strong>{current?.label}</strong>}
    </nav>
    <div className="topbar-actions">
      <span className="live-pill"><span className={`status-dot ${status === 'live' ? '' : status === 'offline' ? 'error' : 'warn'}`} /> {status === 'live' ? 'Live' : status === 'offline' ? 'Disconnected' : 'Connecting'}</span>
      <IconButton onClick={refresh} label="Refresh now" icon={<RefreshIcon />} />
    </div>
  </header>
}

export function ConnectionBanner() {
  const { error, refresh, status } = useRuntime()
  if (status === 'restarting') return <div className="api-error restarting"><span className="status-dot warn" /><div><strong>HAR is restarting</strong><span>This takes a few seconds. Running scripts were stopped by the restart.</span></div></div>
  if (!error) return null
  return <div className="api-error" role="alert"><span className="status-dot error" /><div><strong>HAR can't connect right now</strong><span>{error}</span></div><Button variant="text" onClick={refresh}>Try again</Button></div>
}

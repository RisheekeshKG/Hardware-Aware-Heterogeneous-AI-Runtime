import { navItems } from './navigation.js'
import { useNavigation } from './NavigationProvider.jsx'
import { useRuntime } from './RuntimeProvider.jsx'

export function Topbar() {
  const { page } = useNavigation()
  const { error, refresh } = useRuntime()
  const pageLabel = navItems.find((item) => item.id === page)?.label || 'Runtime'
  return <header className="topbar"><div className="breadcrumbs"><span>HAR</span><i>/</i><strong>{pageLabel}</strong></div><div className="topbar-actions"><span className="live-pill"><span className={`status-dot ${error ? 'error' : ''}`} /> {error ? 'Disconnected' : 'Live API'}</span><button className="icon-button" onClick={refresh} aria-label="Refresh runtime">R</button></div></header>
}

export function ConnectionBanner() {
  const { error, refresh } = useRuntime()
  if (!error) return null
  return <div className="api-error"><span className="status-dot error" /><div><strong>HAR cannot connect right now</strong><span>{error}</span></div><button onClick={refresh}>Try again</button></div>
}

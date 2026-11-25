// The window: first-launch setup, then sidebar + top bar + the open page.
import { Fragment } from 'react'
import { machineSummary, plural } from './helpers.js'
import { BenchmarksPage, NewBenchmarkDialog } from './pages/Benchmarks.jsx'
import { AddDeviceDialog, DevicesPage, PairingPrompt } from './pages/Devices.jsx'
import { OverviewPage } from './pages/Overview.jsx'
import { ScriptsPage } from './pages/Scripts.jsx'
import { SettingsPage } from './pages/Settings.jsx'
import { SetupGate } from './pages/Setup.jsx'
import { ConfirmProvider, NavigationProvider, RuntimeProvider, ToastProvider, useNavigation, useRuntime } from './state.jsx'
import { BenchmarksIcon, Brand, Button, DevicesIcon, IconButton, OverviewIcon, RefreshIcon, ScriptsIcon, SettingsIcon } from './ui.jsx'

const pages = {
  overview: OverviewPage,
  scripts: ScriptsPage,
  devices: DevicesPage,
  device: DevicesPage,
  settings: SettingsPage,
  benchmarks: BenchmarksPage,
}

// setup gate → providers → shell → page + modal host
export function App() {
  return <ToastProvider>
    <SetupGate>
      <RuntimeProvider>
        <ConfirmProvider>
          <NavigationProvider>
            <Shell />
          </NavigationProvider>
        </ConfirmProvider>
      </RuntimeProvider>
    </SetupGate>
  </ToastProvider>
}

function Shell() {
  const { page } = useNavigation()
  const { pairing, status } = useRuntime()
  const Page = pages[page] || OverviewPage
  return <div className="app-shell">
    <Sidebar />
    <main className="main-content">
      <Topbar />
      <ConnectionBanner />
      {status === 'starting' ? <PageLoading /> : <Page />}
    </main>
    <ModalHost />
    {pairing[0] && <PairingPrompt key={pairing[0].id} request={pairing[0]} />}
  </div>
}

// Before the first answer from the runtime, empty lists would read as "nothing here".
function PageLoading() {
  return <div className="page-loading" role="status"><span className="status-dot warn" />Connecting to HAR…</div>
}

const navItems = [
  { id: 'overview', label: 'Overview', Icon: OverviewIcon, group: 'workspace' },
  { id: 'scripts', label: 'Scripts', Icon: ScriptsIcon, group: 'workspace' },
  { id: 'devices', label: 'Devices', Icon: DevicesIcon, group: 'workspace' },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon, group: 'workspace' },
  { id: 'benchmarks', label: 'Benchmarks', Icon: BenchmarksIcon, group: 'devtools' },
]

const navGroups = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'devtools', label: 'Dev tools' },
]


const STATUS_TEXT = {
  starting: { label: 'Starting', dot: 'warn' },
  restarting: { label: 'Restarting', dot: 'warn' },
  live: { label: 'Connected', dot: '' },
  offline: { label: 'Not connected', dot: 'error' },
}

function Sidebar() {
  const { page, go } = useNavigation()
  const { devices, nodes, status, workerConnection, session } = useRuntime()
  const { machinesReady } = machineSummary(devices, nodes)
  const activePage = page === 'device' ? 'devices' : page
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
        {navItems.filter((item) => item.group === group.id).map(({ id, label, Icon }) => <button key={id} title={label} className={`nav-item ${activePage === id ? 'active' : ''}`} aria-current={activePage === id ? 'page' : undefined} onClick={() => go(id)}><span className="nav-icon"><Icon /></span><span>{label}</span></button>)}
      </nav>
    </Fragment>)}
    <div className="sidebar-spacer" />
    <div className="connection-status" role="status"><span className={`status-dot ${state.dot}`} /><span>{state.label}</span><small>{detail}</small></div>
  </aside>
}

function Topbar() {
  const { page } = useNavigation()
  const { status, refresh } = useRuntime()
  const current = navItems.find((item) => item.id === (page === 'device' ? 'devices' : page))
  return <header className="topbar">
    <nav className="breadcrumbs" aria-label="Breadcrumb"><span>HAR</span><i>/</i><strong>{current?.label}</strong></nav>
    <div className="topbar-actions">
      <span className="live-pill"><span className={`status-dot ${status === 'live' ? '' : status === 'offline' ? 'error' : 'warn'}`} /> {status === 'live' ? 'Live' : status === 'offline' ? 'Disconnected' : 'Connecting'}</span>
      <IconButton onClick={refresh} label="Refresh now" icon={<RefreshIcon />} />
    </div>
  </header>
}

function ConnectionBanner() {
  const { error, refresh, status } = useRuntime()
  if (status === 'restarting') return <div className="api-error restarting"><span className="status-dot warn" /><div><strong>HAR is restarting</strong><span>This takes a few seconds. Running scripts were stopped by the restart.</span></div></div>
  if (!error) return null
  return <div className="api-error" role="alert"><span className="status-dot error" /><div><strong>HAR can't connect right now</strong><span>{error}</span></div><Button variant="text" onClick={refresh}>Try again</Button></div>
}

const modals = { benchmark: NewBenchmarkDialog, connect: AddDeviceDialog }

function ModalHost() {
  const { modal, closeModal } = useNavigation()
  const Modal = modals[modal]
  return Modal ? <Modal onClose={closeModal} /> : null
}

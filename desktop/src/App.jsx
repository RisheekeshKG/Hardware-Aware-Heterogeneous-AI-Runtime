import { useEffect } from 'react'
import { ConfirmProvider } from './app/ConfirmProvider.jsx'
import { ModalHost } from './app/ModalHost.jsx'
import { NavigationProvider, useNavigation } from './app/NavigationProvider.jsx'
import { PairingPrompt } from './app/PairingPrompt.jsx'
import { RuntimeProvider, useRuntime } from './app/RuntimeProvider.jsx'
import { Sidebar } from './app/Sidebar.jsx'
import { ConnectionBanner, Topbar } from './app/Topbar.jsx'
import { ToastProvider } from './app/ToastProvider.jsx'
import { BenchmarksView } from './views/benchmarks/BenchmarksView.jsx'
import { DeviceDetailView } from './views/devices/DeviceDetailView.jsx'
import { DevicesView } from './views/devices/DevicesView.jsx'
import { OverviewView } from './views/overview/OverviewView.jsx'
import { ScriptsView } from './views/scripts/ScriptsView.jsx'
import { SettingsView } from './views/settings/SettingsView.jsx'
import { SetupGate } from './views/setup/SetupGate.jsx'

const pages = {
  overview: OverviewView,
  scripts: ScriptsView,
  devices: DevicesView,
  device: DeviceDetailView,
  settings: SettingsView,
  benchmarks: BenchmarksView,
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
  const { page, deviceId } = useNavigation()
  const { pairing, status } = useRuntime()
  const Page = pages[page] || OverviewView
  // A new page starts at the top, not wherever the previous one was scrolled to.
  useEffect(() => { window.scrollTo(0, 0) }, [page, deviceId])
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

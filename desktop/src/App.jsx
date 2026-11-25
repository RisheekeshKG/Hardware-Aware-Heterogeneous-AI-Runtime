import { ModalHost } from './app/ModalHost.jsx'
import { NavigationProvider, useNavigation } from './app/NavigationProvider.jsx'
import { PairingPrompt } from './app/PairingPrompt.jsx'
import { RuntimeProvider, useRuntime } from './app/RuntimeProvider.jsx'
import { Sidebar } from './app/Sidebar.jsx'
import { ConnectionBanner, Topbar } from './app/Topbar.jsx'
import { ToastProvider } from './app/ToastProvider.jsx'
import { BenchmarksView } from './views/benchmarks/BenchmarksView.jsx'
import { FabricView } from './views/devices/FabricView.jsx'
import { RuntimeView } from './views/overview/RuntimeView.jsx'
import { TracesView } from './views/scripts/TracesView.jsx'
import { WorkloadsView } from './views/scripts/WorkloadsView.jsx'
import { SetupGate } from './views/setup/SetupGate.jsx'

const pages = {
  runtime: RuntimeView,
  workloads: WorkloadsView,
  fabric: FabricView,
  traces: TracesView,
  benchmarks: BenchmarksView,
}

// setup gate → providers → shell → page + modal host
export function App() {
  return <ToastProvider>
    <SetupGate>
      <RuntimeProvider>
        <NavigationProvider>
          <Shell />
        </NavigationProvider>
      </RuntimeProvider>
    </SetupGate>
  </ToastProvider>
}

function Shell() {
  const { page } = useNavigation()
  const { pairing } = useRuntime()
  const Page = pages[page] || RuntimeView
  return <div className="app-shell">
    <Sidebar />
    <main className="main-content">
      <Topbar />
      <ConnectionBanner />
      <Page />
    </main>
    <ModalHost />
    {pairing[0] && <PairingPrompt key={pairing[0].id} request={pairing[0]} />}
  </div>
}

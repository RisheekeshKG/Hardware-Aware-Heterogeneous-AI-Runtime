import { BenchmarksIcon, DevicesIcon, OverviewIcon, ScriptsIcon, SettingsIcon } from '../components/icons.jsx'

export const navItems = [
  { id: 'overview', label: 'Overview', Icon: OverviewIcon, group: 'workspace' },
  { id: 'scripts', label: 'Scripts', Icon: ScriptsIcon, group: 'workspace' },
  { id: 'devices', label: 'Devices', Icon: DevicesIcon, group: 'workspace' },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon, group: 'workspace' },
  { id: 'benchmarks', label: 'Benchmarks', Icon: BenchmarksIcon, group: 'devtools' },
]

export const navGroups = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'devtools', label: 'Dev tools' },
]

// Pages that live under another page in the sidebar and breadcrumbs.
export const subPages = { device: { parent: 'devices' } }

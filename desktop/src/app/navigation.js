// The desktop app launches the runtime itself; give it time to boot before reporting a failure.
export const RUNTIME_STARTUP_GRACE_MS = 20000
export const navItems = [
  { id: 'runtime', label: 'Overview', icon: 'O', group: 'workspace' },
  { id: 'workloads', label: 'Scripts', icon: 'S', group: 'workspace' },
  { id: 'fabric', label: 'Devices', icon: 'D', group: 'workspace' },
  { id: 'traces', label: 'Activity', icon: 'A', group: 'workspace' },
  { id: 'benchmarks', label: 'Benchmarks', icon: 'B', group: 'devtools' },
]
export const navGroups = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'devtools', label: 'Dev tools' },
]

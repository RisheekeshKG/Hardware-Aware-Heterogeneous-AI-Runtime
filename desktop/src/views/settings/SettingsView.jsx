import { useEffect, useState } from 'react'
import { API } from '../../api/client.js'
import { api } from '../../api/endpoints.js'
import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { PageHeader } from '../../components/PageHeader.jsx'
import { SectionHeading } from '../../components/SectionHeading.jsx'
import { appVersion, isDesktop } from '../../lib/tauri.js'
import { PyTorchPanel } from './PyTorchPanel.jsx'
import { RolePanel } from './RolePanel.jsx'

export function SettingsView() {
  return <>
    <PageHeader eyebrow="SETTINGS" title="Settings" description="How this computer takes part, and what HAR is running on." />
    <RolePanel />
    <PyTorchPanel />
    <AboutPanel />
  </>
}

function AboutPanel() {
  const { session, system } = useRuntime()
  const { go } = useNavigation()
  const [version, setVersion] = useState(null)
  const [env, setEnv] = useState(null)
  useEffect(() => { appVersion().then(setVersion).catch(() => {}) }, [])
  useEffect(() => { api.envHash().then(setEnv).catch(() => {}) }, [])
  const runtime = system?.host?.runtime
  const rows = [
    ['HAR app', isDesktop() ? (version || '…') : 'Running in a browser'],
    ['Role', session?.role || '…'],
    ['Python', runtime?.python_version || '…'],
    ['PyTorch', runtime ? (runtime.pytorch_version || 'Not installed') : '…'],
    ['Apple GPU (MPS)', runtime ? (runtime.mps_built ? 'Built in' : 'Not available') : '…'],
    ['NVIDIA CUDA', runtime ? (runtime.cuda_runtime || 'Not available') : '…'],
    ['API address', API],
    ['Session', session?.session_id || '…'],
    ['Environment', env ? <>{env.hash} · {Object.values(env.packages).filter((v) => v !== 'absent').length} packages <button className="link-button" onClick={() => go('device', { deviceId: 'local' })}>See packages</button></> : '…'],
  ]
  return <section className="panel settings-panel">
    <SectionHeading compact eyebrow="ABOUT" title="This installation" />
    <dl className="settings-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </section>
}

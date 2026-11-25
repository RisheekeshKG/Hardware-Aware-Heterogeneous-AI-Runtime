import { useEffect, useState } from 'react'
import { API } from '../../api/client.js'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { PageHeader } from '../../components/PageHeader.jsx'
import { SectionHeading } from '../../components/SectionHeading.jsx'
import { appVersion, isDesktop } from '../../lib/tauri.js'
import { RolePanel } from './RolePanel.jsx'

export function SettingsView() {
  return <>
    <PageHeader eyebrow="SETTINGS" title="Settings" description="How this computer takes part, and what HAR is running on." />
    <RolePanel />
    <AboutPanel />
  </>
}

function AboutPanel() {
  const { session, system } = useRuntime()
  const [version, setVersion] = useState(null)
  useEffect(() => { appVersion().then(setVersion).catch(() => {}) }, [])
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
  ]
  return <section className="panel settings-panel">
    <SectionHeading compact eyebrow="ABOUT" title="This installation" />
    <dl className="settings-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </section>
}

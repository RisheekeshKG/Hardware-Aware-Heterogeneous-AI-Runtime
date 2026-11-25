import { api } from '../../api/endpoints.js'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { useAction } from '../../hooks/useAction.js'

export function TrustedHostsPanel() {
  const { trustedHosts: hosts } = useRuntime()
  const action = useAction()
  if (!hosts || hosts.length === 0) return null
  const onRevoke = (ip) => action({
    confirm: { title: `Revoke trust for ${ip}?`, message: 'HAR will refuse any future tasks from that host until you accept it again.', confirmLabel: 'Revoke' },
    run: () => api.revokeTrustedHost(ip),
    success: `${ip} is no longer trusted.`,
    failure: 'Could not revoke',
  })
  return <section className="panel trusted-hosts-panel">
    <div className="section-heading compact">
      <div><div className="eyebrow">HOSTS CONNECTED TO THIS COMPUTER</div><h2>{hosts.length} host{hosts.length === 1 ? '' : 's'} can send tasks here</h2></div>
      <span className="eyebrow trusted-hosts-warn">AUDIT REGULARLY</span>
    </div>
    <p className="empty-copy">Each host below has previously been accepted and can run Python and benchmarks on this computer. Revoke any you don't recognize.</p>
    <div className="trusted-hosts-list">
      {hosts.map((host) => <div className="trusted-host-row" key={host.client_ip}>
        <div><strong>{host.client_ip}</strong><span>Trusted</span></div>
        <button type="button" className="secondary-button device-disconnect" onClick={() => onRevoke(host.client_ip)}>Revoke</button>
      </div>)}
    </div>
  </section>
}

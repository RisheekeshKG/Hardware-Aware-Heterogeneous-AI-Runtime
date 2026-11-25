import { api } from '../../api/endpoints.js'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { useAction } from '../../hooks/useAction.js'

export function WorkerConnectionPanel() {
  const { workerConnection: connection } = useRuntime()
  const action = useAction()
  if (!connection) return null
  const host = connection.host_ip
  const onStopServing = () => action({
    confirm: `Stop working for ${host || 'this host'}? HAR will stop auto-retrying every 5 seconds. You can accept a new host anytime.`,
    run: api.stopServingHost,
    success: `Stopped working for ${host || 'this host'}.`,
    failure: 'Could not stop',
  })
  if (connection.status === 'unsupported') {
    return <section className="panel worker-connection"><span className="status-dot warn" /><div><strong>Connection status needs a newer runtime</strong><span>The installed runtime is older than this app, so it can't report which host is connected. Update the runtime to see it here.</span></div></section>
  }
  const ago = (seconds) => seconds == null ? '' : seconds < 2 ? 'just now' : `${Math.round(seconds)}s ago`
  const jobs = connection.jobs_received ? ` · ${connection.jobs_received} task${connection.jobs_received === 1 ? '' : 's'} received${connection.running_jobs ? `, ${connection.running_jobs} running` : ''}` : ''
  const views = {
    connected: { dot: '', title: `Connected to host ${host}`, detail: `Last contact ${ago(connection.seconds_since_contact)}${jobs}. This computer is ready to take tasks from it.` },
    unreachable: { dot: 'error', title: `Can't reach host ${host}`, detail: `${connection.last_error ? `${connection.last_error}. ` : ''}Retrying every 5 seconds. Check that the host is running HAR and both computers are on the same network.` },
    waiting: { dot: 'warn', title: 'Waiting for a host', detail: "No host is connected yet. On the host, choose Add device and enter this PC's address." },
    disconnected: { dot: 'warn', title: 'The host disconnected this computer', detail: 'It will stop sending tasks. Add this computer again on the host to reconnect.' },
  }
  const view = views[connection.status] || views.waiting
  const hasHost = Boolean(connection.coordinator)
  return <section className="panel worker-connection"><span className={`status-dot ${view.dot}`} /><div><span className="eyebrow">WORKING FOR</span><strong>{view.title}</strong><span>{view.detail}</span></div>{hasHost && <button type="button" className="secondary-button device-disconnect worker-stop-serving" onClick={onStopServing}>Stop working for this host</button>}</section>
}

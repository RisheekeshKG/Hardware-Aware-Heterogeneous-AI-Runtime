import { apiUrl, request } from './client.js'

const id = encodeURIComponent
const post = (path, body) => request(path, { method: 'POST', body })

export const api = {
  runtime: () => request('/api/runtime'),
  session: () => request('/api/session'),
  system: () => request('/api/system'),
  envHash: () => request('/api/env-hash'),

  // The list poll leaves out each run's output (up to 100 KB apiece); ScriptDetail streams it.
  scripts: () => request('/api/scripts?include_output=false'),
  script: (scriptId) => request(`/api/scripts/${id(scriptId)}`),
  scriptChunks: (scriptId, since) => request(`/api/scripts/${id(scriptId)}/chunks?since=${since}`),
  scriptStreamUrl: (scriptId, since) => apiUrl(`/api/scripts/${id(scriptId)}/stream?since=${since}`),
  startScript: (body) => post('/api/scripts', body),
  stopScript: (scriptId) => post(`/api/scripts/${id(scriptId)}/stop`),

  startRun: (body) => post('/api/runs', body),
  runTrace: (runId) => request(`/api/runs/${id(runId)}/trace`),

  connectNode: (body) => post('/api/nodes/connect', body),
  disconnectNode: (nodeId) => request(`/api/nodes/${id(nodeId)}`, { method: 'DELETE' }),
  renameNode: (nodeId, name) => post(`/api/nodes/${id(nodeId)}/rename`, { name }),
  nodeEnvHash: (nodeId) => request(`/api/nodes/${id(nodeId)}/env-hash`),
  discovery: () => request('/api/discovery'),
  connectDiscovered: (body) => post('/api/discovery/connect', body),

  // Worker role only; the API answers [] / null in other roles.
  pairing: () => request('/api/pairing'),
  decidePairing: (requestId, decision) => post(`/api/pairing/${id(requestId)}/${decision}`),
  trustedHosts: () => request('/api/trusted-hosts'),
  revokeTrustedHost: (ip) => request(`/api/trusted-hosts/${id(ip)}`, { method: 'DELETE' }),
  workerConnection: () => request('/api/worker-connection'),
  stopServingHost: () => post('/api/worker-connection/stop'),
}

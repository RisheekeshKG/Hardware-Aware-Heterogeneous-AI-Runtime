// Every call HAR makes: HTTP requests to the runtime and desktop-app (Tauri) commands.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

// The only place that talks HTTP to the HAR API. Everything else goes through endpoints.js.
export const API = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'

class ApiError extends Error {
  constructor(message, status, data) {
    super(message)
    this.name = 'ApiError'
    this.status = status // 0 = never reached the server
    this.data = data
  }
}

// Checks `ok` before trusting the body: an error page or empty body must not throw a JSON
// parse error that hides the real HTTP status.
async function request(path, { method = 'GET', body, signal } = {}) {
  let response
  try {
    response = await fetch(`${API}${path}`, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new ApiError(`Can't reach HAR (${error.message})`, 0)
  }
  const text = await response.text()
  let data = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = text }
  }
  if (!response.ok) {
    const detail = data && typeof data === 'object' ? data.detail : null
    throw new ApiError(typeof detail === 'string' ? detail : `HTTP ${response.status}`, response.status, data)
  }
  return data
}

const apiUrl = (path) => `${API}${path}`

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

  // Your script files on this computer (~/HAR/scripts).
  workspace: () => request('/api/workspace'),
  readFile: (name) => request(`/api/workspace/files/${id(name)}`),
  saveFile: (name, content) => request(`/api/workspace/files/${id(name)}`, { method: 'PUT', body: { content } }),
  renameFile: (name, newName) => post(`/api/workspace/files/${id(name)}/rename`, { new_name: newName }),
  deleteFile: (name) => request(`/api/workspace/files/${id(name)}`, { method: 'DELETE' }),

  startRun: (body) => post('/api/runs', body),

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

// Every Tauri call goes through here so the UI also runs in a plain browser (`npm run dev`
// against `har serve`), where desktop-only features are simply absent.

export const isDesktop = () => Boolean(window.__TAURI_INTERNALS__)

export function desktopInvoke(command, args) {
  if (!isDesktop()) return Promise.reject(new Error('Only available in the HAR desktop app'))
  return invoke(command, args)
}

// Returns an unsubscribe function, usable directly as an effect cleanup.
export function desktopListen(event, handler) {
  if (!isDesktop()) return () => {}
  const pending = listen(event, handler)
  return () => { pending.then((stop) => stop()) }
}

export async function appVersion() {
  if (!isDesktop()) return null
  const { getVersion } = await import('@tauri-apps/api/app')
  return getVersion()
}

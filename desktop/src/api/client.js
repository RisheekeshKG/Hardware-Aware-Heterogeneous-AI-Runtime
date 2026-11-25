// The only place that talks HTTP to the HAR API. Everything else goes through endpoints.js.
export const API = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message)
    this.name = 'ApiError'
    this.status = status // 0 = never reached the server
    this.data = data
  }
}

// Checks `ok` before trusting the body: an error page or empty body must not throw a JSON
// parse error that hides the real HTTP status.
export async function request(path, { method = 'GET', body, signal } = {}) {
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

export const apiUrl = (path) => `${API}${path}`

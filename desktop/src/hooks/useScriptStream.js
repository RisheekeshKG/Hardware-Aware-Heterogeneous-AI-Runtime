import { useState, useEffect, useRef } from 'react'
import { api } from '../api/endpoints.js'

export function useScriptStream(scriptId) {
  // Live tail of /api/scripts/{id}/stream via EventSource. Each chunk is appended as it arrives,
  // so a 2-minute training script no longer shows a blank panel. The stream closes on the
  // server's terminal `done` event, on unmount, or on any stream error.
  const [chunks, setChunks] = useState([])
  const outputRef = useRef('')
  useEffect(() => {
    outputRef.current = ''
    setChunks([])
    if (!scriptId) return undefined
    let closed = false
    const es = new EventSource(api.scriptStreamUrl(scriptId, -1))
    es.onmessage = (event) => {
      try {
        const chunk = JSON.parse(event.data)
        if (typeof chunk.text === 'string') {
          outputRef.current = (outputRef.current + chunk.text).slice(-100_000)
          setChunks((prev) => [...prev, chunk])
        }
      } catch { /* ignore keep-alive and malformed frames */ }
    }
    es.addEventListener('done', () => { closed = true; es.close() })
    es.onerror = () => { if (!closed) es.close() }
    return () => { closed = true; es.close() }
  }, [scriptId])
  return { chunks, liveOutput: outputRef.current }
}

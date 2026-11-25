import { useEffect, useState } from 'react'
import { api } from '../api/endpoints.js'
import { isActive } from '../lib/runs.js'

const MAX_CHARS = 200_000
const BACKOFF_MS = [1000, 2000, 5000, 10000]
const MAX_STREAM_FAILURES = 3
// A connection must stay up this long before its failure stops counting toward the
// fallback; otherwise a link that opens and then drops would retry forever.
const HEALTHY_MS = 10000

const INITIAL = { chunks: [], phase: 'connecting', truncated: false, final: null }

// Live output of one script run.
//
// Opens /stream (SSE). Every chunk carries a `seq`, so duplicates from reconnects are
// dropped and nothing is applied twice. Updates are batched per animation frame and the
// kept text is capped at 200k chars (oldest chunks dropped first).
//
// If the stream breaks: catch up with /chunks?since=lastSeq, then reopen the stream from
// there with a 1/2/5/10 s backoff. After 3 failures, fall back to polling /chunks every
// second. A 404 means the run is gone (the runtime restarted).
//
// phase: connecting · live · reconnecting · polling · done · gone
export function useScriptStream(scriptId) {
  const [state, setState] = useState(INITIAL)

  useEffect(() => {
    if (!scriptId) return undefined
    let disposed = false
    let finished = false
    let source = null
    let timer = null
    let frame = 0
    let failures = 0
    let openedAt = 0
    let lastSeq = -1
    let pending = []

    setState(INITIAL)
    const setPhase = (phase) => { if (!disposed) setState((current) => current.phase === phase ? current : { ...current, phase }) }

    const flush = () => {
      frame = 0
      if (disposed || !pending.length) return
      const batch = pending
      pending = []
      setState((current) => {
        let chunks = current.chunks.concat(batch)
        let size = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
        let truncated = current.truncated
        let drop = 0
        while (size > MAX_CHARS && drop < chunks.length - 1) { size -= chunks[drop].text.length; drop += 1 }
        if (drop) { chunks = chunks.slice(drop); truncated = true }
        return { ...current, chunks, truncated }
      })
    }

    const accept = (chunk) => {
      if (typeof chunk?.seq !== 'number' || typeof chunk.text !== 'string' || chunk.seq <= lastSeq) return
      lastSeq = chunk.seq
      pending.push({ seq: chunk.seq, stream: chunk.stream, text: chunk.text })
      if (!frame) frame = window.requestAnimationFrame(flush)
    }

    const finish = (final) => {
      if (finished) return
      finished = true
      source?.close()
      window.clearTimeout(timer)
      if (frame) { window.cancelAnimationFrame(frame); frame = 0 }
      flush()
      if (!disposed) setState((current) => ({ ...current, phase: 'done', final }))
    }

    const catchUp = async () => {
      const data = await api.scriptChunks(scriptId, lastSeq)
      ;(data.chunks || []).forEach(accept)
      if (!isActive(data.status)) finish({ status: data.status, exit_code: data.exit_code })
    }

    const poll = async () => {
      if (disposed || finished) return
      try { await catchUp() } catch (error) {
        if (error.status === 404) { finished = true; setPhase('gone'); return }
      }
      if (!finished && !disposed) timer = window.setTimeout(poll, 1000)
    }

    const recover = async () => {
      if (disposed || finished) return
      failures += 1
      try { await catchUp() } catch (error) {
        if (error.status === 404) { finished = true; setPhase('gone'); return }
      }
      if (finished || disposed) return
      if (failures >= MAX_STREAM_FAILURES) { setPhase('polling'); poll(); return }
      setPhase('reconnecting')
      timer = window.setTimeout(open, BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)])
    }

    function open() {
      if (disposed || finished) return
      source = new EventSource(api.scriptStreamUrl(scriptId, lastSeq))
      openedAt = 0
      source.onopen = () => { openedAt = Date.now(); setPhase('live') }
      source.onmessage = (event) => { try { accept(JSON.parse(event.data)) } catch { /* keep-alive or malformed frame */ } }
      source.addEventListener('done', (event) => { let final = null; try { final = JSON.parse(event.data) } catch { /* ignore */ } finish(final) })
      // EventSource would retry on its own from the start; close it and resume from lastSeq instead.
      source.onerror = () => {
        source.close()
        if (openedAt && Date.now() - openedAt > HEALTHY_MS) failures = 0
        if (!finished) recover()
      }
    }

    open()
    return () => {
      disposed = true
      source?.close()
      window.clearTimeout(timer)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [scriptId])

  return state
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from './Button.jsx'
import { CopyIcon, DownIcon } from './icons.jsx'

const NEAR_BOTTOM_PX = 32
const PHASE_TEXT = {
  connecting: 'connecting…',
  live: 'live',
  reconnecting: 'connection dropped, reconnecting…',
  polling: 'live (polling)',
  done: '',
  gone: 'this run is no longer available',
}

const lineClass = (chunk) => chunk.text.startsWith('[har]') ? 'out-har' : chunk.stream === 'stderr' ? 'out-stderr' : undefined

// Streamed stdout/stderr. Follows new output only while you're at the bottom; if you
// scrolled up to read, it stays put and offers "Jump to latest".
export function ScriptOutput({ stream, running }) {
  const { chunks, phase, truncated } = stream
  const boxRef = useRef(null)
  const stick = useRef(true)
  const seenCount = useRef(0)
  const [unseen, setUnseen] = useState(0)
  const [copied, setCopied] = useState(false)
  const chars = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const added = chunks.length - seenCount.current
    seenCount.current = chunks.length
    if (stick.current) box.scrollTop = box.scrollHeight
    else if (added > 0) setUnseen((count) => count + added)
  }, [chunks])

  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const onScroll = () => {
    const box = boxRef.current
    stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX
    if (stick.current) setUnseen(0)
  }
  const jump = () => {
    const box = boxRef.current
    box.scrollTop = box.scrollHeight
    stick.current = true
    setUnseen(0)
  }
  const copy = () => {
    navigator.clipboard?.writeText(chunks.map((chunk) => chunk.text).join('')).then(() => setCopied(true)).catch(() => {})
  }

  const status = PHASE_TEXT[phase]
  return <div className="script-output-block">
    <div className="script-output-head">
      <span className="eyebrow">OUTPUT</span>
      <span className={`output-phase ${phase}`}>{chars ? `${chars.toLocaleString()} chars` : ''}{chars && status ? ' · ' : ''}{status}</span>
      <Button variant="text" icon={<CopyIcon />} onClick={copy} disabled={!chars}>{copied ? 'Copied' : 'Copy'}</Button>
    </div>
    <div className="script-output-frame">
      <pre ref={boxRef} className="script-output" onScroll={onScroll} tabIndex={0} aria-label="Script output" aria-live="off">
        {truncated && <span className="out-har">[har] Older output was dropped; showing the last 200,000 characters.{'\n'}</span>}
        {chunks.length
          ? chunks.map((chunk) => <span key={chunk.seq} className={lineClass(chunk)}>{chunk.text}</span>)
          : <span className="out-placeholder">{running ? 'The script has started. Anything it prints shows up here as it happens.' : phase === 'gone' ? 'HAR restarted since this ran, so its output is gone.' : phase === 'done' ? 'This script printed nothing.' : 'Loading output…'}</span>}
      </pre>
      {unseen > 0 && <button type="button" className="jump-latest" onClick={jump}><DownIcon /> Jump to latest ({unseen} new)</button>}
    </div>
  </div>
}

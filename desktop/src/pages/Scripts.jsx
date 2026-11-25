// Scripts: run history, one run's details and live output, Stop, and the new-script editor.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { EditorView, Prec, keymap } from '@uiw/react-codemirror'
import { python } from '@codemirror/lang-python'
import { syntaxHighlighting } from '@codemirror/language'
import { classHighlighter } from '@lezer/highlight'
import { api } from '../api.js'
import { backendTitle, computerOptions, formatBytes, formatDate, formatElapsed, formatRelative, formatSecondsShort, isActive, nodeLabel, plural, remoteNodes, scriptDuration, scriptOutcome, scriptTimings } from '../helpers.js'
import { useConfirm, useNavigation, useNow, useRuntime, useToast } from '../state.jsx'
import { ArrowRightIcon, BackendBadge, Button, CopyIcon, DownIcon, Dropdown, Field, Metric, Modal, ModalActions, PageHeader, Placement, PlusIcon, RefreshButton, StatusBadge, StopIcon } from '../ui.jsx'

// History on the left, the selected run on the right (stacked below 1280 px).
// Replaces the old Scripts + Activity pages, which showed the same runs twice.
export function ScriptsPage() {
  const { scripts, refresh } = useRuntime()
  const { scriptId, openModal } = useNavigation()
  const selected = scripts.find((script) => script.id === scriptId) || scripts[0] || null
  return <>
    <PageHeader eyebrow="SCRIPTS" title="Scripts" description="Run Python on any of your computers and watch what it prints." action={<div className="header-actions"><RefreshButton onClick={refresh} title="Refresh scripts" /><Button variant="primary" icon={<PlusIcon />} onClick={() => openModal('script')}>New script</Button></div>} />
    {scripts.length ? <div className="scripts-layout">
      <section className="panel script-history" aria-label="Script runs">
        <div className="list-heading"><span className="eyebrow">HISTORY</span><span className="chart-meta">{plural(scripts.length, 'run')}</span></div>
        <div className="script-list">{scripts.map((script) => <ScriptRow key={script.id} script={script} selected={script.id === selected?.id} />)}</div>
      </section>
      {selected && <ScriptDetail key={selected.id} script={selected} />}
    </div> : <FirstScript onStart={() => openModal('script')} />}
  </>
}

function FirstScript({ onStart }) {
  return <section className="panel launch-card">
    <div className="eyebrow">GET STARTED</div>
    <h2>Run your first script</h2>
    <p>Write Python in HAR's editor, or load a .py file, and pick which computer runs it. Functions decorated with <code>@har.offload</code> are sent to the best device for each call; the rest runs as normal.</p>
    <button className="large-launch" onClick={onStart}><span className="launch-icon"><ArrowRightIcon /></span><span><strong>Write a new script</strong><small>Opens the editor. You can load an existing .py file there.</small></span><span className="arrow"><PlusIcon /></span></button>
    <div className="policy-note"><span className="status-dot" /><span>Each run gets a fresh temporary folder on the computer you pick.</span></div>
  </section>
}

// One script run in a list. Clicking opens it on the Scripts page.
export function ScriptRow({ script, selected = false }) {
  const { nodes } = useRuntime()
  const { go } = useNavigation()
  const args = script.args?.length ? script.args.join(' ') : ''
  return <button type="button" className={`script-row ${selected ? 'selected' : ''}`.trim()} aria-current={selected ? 'true' : undefined} onClick={() => go('scripts', { scriptId: script.id })}>
    <span className={`workload-pulse ${script.status}`} />
    <span className="script-row-main">
      <strong>{script.filename}{args && <em> {args}</em>}</strong>
      <span>{nodeLabel(script.target_node, nodes)} · <time dateTime={script.created_at} title={new Date(script.created_at).toLocaleString()}>{formatRelative(script.created_at)}</time></span>
    </span>
    <span className="script-row-time">{formatElapsed(scriptDuration(script))}</span>
    <span className="script-row-outcome">{scriptOutcome(script)}</span>
    <StatusBadge status={script.status} />
  </button>
}

function targetBackends(script, devices, nodes) {
  if (script.target_node === 'local') return { backends: (devices || []).filter((device) => device.available), status: 'online' }
  const node = remoteNodes(nodes).find((item) => item.node_id === script.target_node)
  return node ? { backends: (node.capabilities || []).filter((b) => b.available !== false), status: node.status } : { backends: [], status: 'unknown' }
}

function ScriptDetail({ script }) {
  const { devices, nodes, cpuInfo } = useRuntime()
  const stream = useScriptStream(script.id)
  const stop = useStopScript()
  const now = useNow(isActive(script.status))
  const output = stream.chunks.map((chunk) => chunk.text).join('')
  const timings = scriptTimings(script)
  const target = targetBackends(script, devices, nodes)
  const running = isActive(script.status)
  return <section className="panel script-detail" aria-label={`Run of ${script.filename}`}>
    <div className="script-detail-head">
      <div><div className="eyebrow">SCRIPT RUN · {script.id}</div><h2>{script.filename}</h2></div>
      <div className="script-detail-actions">
        {running && <Button variant="danger" icon={<StopIcon />} disabled={script.stop_requested} onClick={() => stop(script)}>{script.stop_requested ? 'Stopping…' : 'Stop'}</Button>}
        <StatusBadge status={script.status} />
      </div>
    </div>
    <div className="placement-grid">
      <Placement label="Computer" value={nodeLabel(script.target_node, nodes)} />
      <Placement label="Started" value={formatDate(script.started_at || script.created_at)} />
      <Placement label={running ? 'Running for' : 'Took'} value={formatElapsed(scriptDuration(script, now))} />
      <Placement label="Result" value={scriptOutcome(script)} />
    </div>
    {script.args?.length ? <div className="script-args"><span className="eyebrow">ARGUMENTS</span><code>{script.args.join(' ')}</code></div> : null}
    {/* For a crash the error is the stderr tail, already in the output; show it only when it adds something (timeouts, disconnects). */}
    {script.error && script.status !== 'completed' && !output.includes(script.error.trim().slice(-120)) ? <div className="form-error script-error">{script.error}</div> : null}
    <ScriptOutput stream={stream} running={running} />
    <details className="detail-section">
      <summary><span className="eyebrow">TIMING</span><span>{formatSecondsShort(timings.total)} total</span></summary>
      <div className="timings-grid">
        <Metric label="Waiting to start" value={formatSecondsShort(timings.queue)} />
        <Metric label={timings.isRemote ? 'Running there' : 'Running'} value={formatSecondsShort(timings.execute)} />
        <Metric label="Network" value={timings.isRemote ? formatSecondsShort(timings.transport) : 'n/a'} />
        <Metric label="Total" value={formatSecondsShort(timings.total)} />
      </div>
      <p className="detail-note">{timings.isRemote ? 'Network time is sending the script and collecting its output. "Running there" is measured by the other computer\'s own clock.' : 'Local runs have no network time; "waiting" is the queue plus starting Python.'}</p>
    </details>
    <details className="detail-section">
      <summary><span className="eyebrow">HARDWARE ON THAT COMPUTER</span><span>{target.backends.length ? target.backends.map((b) => b.backend.toUpperCase()).join(' · ') : 'Unknown'}</span></summary>
      {target.backends.length ? <div className="hardware-list">{target.backends.map((backend) => <div className="hardware-row" key={backend.backend}>
        <BackendBadge backend={backend.backend} />
        <div><strong>{backendTitle(backend, script.target_node === 'local' ? cpuInfo : null)}</strong><span>{backend.memory?.total_bytes != null ? `${formatBytes(backend.memory.available_bytes)} free of ${formatBytes(backend.memory.total_bytes)}` : (backend.memory?.unavailable_reason || 'Memory unknown')}</span></div>
      </div>)}</div> : <p className="detail-note">That computer is no longer connected.</p>}
      <p className="detail-note">The script chooses which of these to use; HAR doesn't pick for it.</p>
    </details>
  </section>
}

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
function ScriptOutput({ stream, running }) {
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
function useScriptStream(scriptId) {
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

// Ask, then POST /api/scripts/{id}/stop. The run moves to "stopped" within a few seconds;
// the list shows "Stopping…" meanwhile (stop_requested).
export function useStopScript() {
  const ask = useConfirm()
  const notify = useToast()
  const { refresh } = useRuntime()
  return useCallback(async (script) => {
    const ok = await ask({
      title: `Stop ${script.filename}?`,
      message: script.status === 'queued'
        ? "It hasn't started yet, so it just won't run."
        : 'HAR sends it Ctrl-C (KeyboardInterrupt), then force-stops it and anything it started after 2 seconds. Output so far is kept.',
      confirmLabel: 'Stop script',
    })
    if (!ok) return
    try {
      await api.stopScript(script.id)
      notify(script.status === 'queued' ? `${script.filename} won't run.` : `Stopping ${script.filename}…`)
    } catch (error) {
      // A runtime from before Stop existed has no such route: FastAPI answers 404 "Not Found"
      // (a known run that's gone answers "Script run not found").
      if (error.status === 409) notify(`${script.filename} had already finished.`)
      else if (error.status === 405 || (error.status === 404 && error.message === 'Not Found')) notify("This HAR runtime can't stop scripts. Update HAR.")
      else if (error.status === 404) notify('That run is no longer available.')
      else notify(`Could not stop ${script.filename}: ${error.message}`)
    }
    await refresh()
  }, [ask, notify, refresh])
}

const DEFAULT_SCRIPT = `import har
import torch


@har.offload
def big_matmul(size: int) -> torch.Tensor:
    left = torch.randn(size, size)
    right = torch.randn(size, size)
    return left @ right


result = big_matmul(2048)
print("result shape:", tuple(result.shape))
`

export function NewScriptDialog({ onClose }) {
  const { nodes, refresh } = useRuntime()
  const { go } = useNavigation()
  const notify = useToast()
  const [filename, setFilename] = useState('untitled.py')
  const [content, setContent] = useState(DEFAULT_SCRIPT)
  const [targetNode, setTargetNode] = useState('local')
  const [args, setArgs] = useState('')
  const [error, setError] = useState('')

  const loadFile = async (event) => {
    const selected = event.target.files?.[0]
    if (!selected) return
    if (!selected.name.toLowerCase().endsWith('.py')) { setError('Load a .py file.'); return }
    setFilename(selected.name)
    setContent(await selected.text())
    setError('')
  }

  const submit = async (event) => {
    event.preventDefault(); setError('')
    const name = filename.trim() || 'untitled.py'
    if (!name.toLowerCase().endsWith('.py')) { setError('Filename must end with .py.'); return }
    if (!content.trim()) { setError('Write some code first.'); return }
    try {
      const script = await api.startScript({ filename: name, content, target_node: targetNode, args: args.trim() ? args.trim().split(/\s+/) : [] })
      onClose()
      go('scripts', { scriptId: script.id })
      notify(`${script.filename} started.`)
      await refresh()
    } catch (submitError) { setError(submitError.message) }
  }

  const fileInput = useRef(null)
  const lineCount = content.split('\n').length
  // ⌘/Ctrl+Enter runs the script. Highest precedence so CodeMirror doesn't insert a line first.
  const runShortcut = useMemo(() => Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { document.querySelector('form.editor-modal')?.requestSubmit(); return true } }])), [])

  return <Modal eyebrow="NEW SCRIPT" title="Write Python" onClose={onClose} onSubmit={submit} className="editor-modal">
    <p>Type Python here (or load a .py file to seed it). HAR copies the code to the selected computer and runs it in a temporary job folder.</p>
    <div className="editor-head">
      <Field label="Filename" className="editor-filename"><input value={filename} onChange={(event) => setFilename(event.target.value)} spellCheck={false} /></Field>
      <Button className="editor-load" title="Load a .py file into the editor" onClick={() => fileInput.current?.click()}>Load file…</Button>
      <input ref={fileInput} type="file" accept=".py,text/x-python" onChange={loadFile} hidden />
    </div>
    <div className="field-label code-label">Code <span className="editor-meta">{lineCount} line{lineCount === 1 ? '' : 's'} · {content.length} chars</span></div>
    <div className="code-editor-wrap">
      <CodeMirror
        value={content}
        height="380px"
        theme={editorTheme}
        extensions={[python(), runShortcut]}
        onChange={(value) => setContent(value)}
        basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: false, autocompletion: true, bracketMatching: true, indentOnInput: true, highlightSelectionMatches: true }}
      />
    </div>
    <Field label="Computer"><Dropdown ariaLabel="Target computer" value={targetNode} onChange={setTargetNode} options={computerOptions(nodes)} /></Field>
    <Field label="Arguments" optional><input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="--input data.csv" spellCheck={false} /></Field>
    <div className="advanced-note">The script runs with the Python packages already installed on the selected computer. @har.offload-decorated functions get routed by HAR; everything else runs in-process as usual.</div>
    {error && <div className="form-error">{error}</div>}
    <ModalActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" iconAfter={<ArrowRightIcon />} title={`Run (${navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl'}+Enter)`}>Run script</Button></ModalActions>
  </Modal>
}

// The code editor's look comes from the design tokens: the editor chrome here, and
// syntax colours in styles/components/editor.css through classHighlighter's tok-* classes.
const editorTheme = [
  EditorView.theme({
    '&': { color: 'var(--text-primary)', backgroundColor: 'transparent' },
    '.cm-content': { caretColor: 'var(--accent)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--editor-selection)' },
    '.cm-gutters': { backgroundColor: 'var(--bg-sunken)', color: 'var(--text-disabled)', border: 'none', borderRight: '1px solid var(--border-subtle)' },
    '.cm-activeLine': { backgroundColor: 'var(--accent-wash)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--accent-wash)', color: 'var(--text-secondary)' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--accent-bg)', outline: '1px solid var(--accent-border)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--accent-bg)' },
    '.cm-tooltip': { border: '1px solid var(--border-strong)', backgroundColor: 'var(--bg-input)', color: 'var(--text-body)' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-bg)', color: 'var(--accent)' },
    '.cm-panels': { backgroundColor: 'var(--bg-panel)', color: 'var(--text-body)' },
  }, { dark: true }),
  syntaxHighlighting(classHighlighter),
]

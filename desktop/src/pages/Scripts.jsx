// Scripts: an editor for your script files (saved in ~/HAR/scripts), with runs and live output.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { EditorView, Prec, keymap } from '@uiw/react-codemirror'
import { python } from '@codemirror/lang-python'
import { syntaxHighlighting } from '@codemirror/language'
import { classHighlighter } from '@lezer/highlight'
import { api } from '../api.js'
import { computerOptions, formatElapsed, formatRelative, isActive, nodeLabel, scriptDuration, scriptOutcome } from '../helpers.js'
import { useConfirm, useNavigation, useNow, useRuntime, useToast } from '../state.jsx'
import { Button, ChevronIcon, CloseIcon, CopyIcon, DownIcon, Dropdown, FileIcon, IconButton, OpenFileIcon, PencilIcon, PlayIcon, PlusIcon, RefreshIcon, StatusBadge, StopIcon, TrashIcon } from '../ui.jsx'

const MOD = navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl+'
const AUTOSAVE_MS = 700
const NEW_FILE_TEXT = '# New script\nprint("Hello from HAR")\n'

// Per-viewer layout memory (open tabs, console height, last computer). Never file contents.
const KEYS = { view: 'har.ide.view', console: 'har.ide.console', target: 'har.ide.target', args: 'har.ide.args' }
function remember(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw) } catch { return fallback }
}
function persist(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable: layout just isn't remembered */ }
}

// "train" → "train.py"; typing the extension over a selected base name ("x.py.py") → "x.py".
const toPyName = (raw) => {
  const name = raw.trim().replace(/\s+/g, '_').replace(/(\.py)+$/i, '.py')
  return name && !name.toLowerCase().endsWith('.py') ? `${name}.py` : name
}
// "/Users/me/HAR/scripts" → "~/HAR/scripts" (also Linux /home and Windows C:\Users).
const shortPath = (path) => (path || '').replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, '~')
const splitArgs = (text) => (text || '').trim() ? text.trim().split(/\s+/) : []

export function ScriptsPage() {
  const ws = useWorkspace()
  const { scripts, refresh } = useRuntime()
  const { scriptId } = useNavigation()
  const notify = useToast()
  const stop = useStopScript()
  const [target, setTarget] = useState(() => remember(KEYS.target, 'local'))
  const [argsByFile, setArgsByFile] = useState(() => remember(KEYS.args, {}))
  const [pinnedRunId, setPinnedRunId] = useState(null)
  const [starting, setStarting] = useState(false)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const console_ = useConsoleSize()

  useEffect(() => { persist(KEYS.target, target) }, [target])
  useEffect(() => { persist(KEYS.args, argsByFile) }, [argsByFile])

  const active = ws.view.active
  const doc = active ? ws.docs[active] : null
  const pinned = scripts.find((script) => script.id === pinnedRunId)
  const consoleRun = pinned || scripts.find((script) => script.filename === active) || null
  const activeRun = consoleRun && consoleRun.filename === active && isActive(consoleRun.status) ? consoleRun : null

  // Opening a run from another page (Overview, a device): show it and open its file if it's here.
  const handledNav = useRef(null)
  useEffect(() => {
    if (!scriptId || handledNav.current === scriptId || !ws.files) return
    handledNav.current = scriptId
    const run = scripts.find((script) => script.id === scriptId)
    if (run && ws.files.some((file) => file.name === run.filename)) ws.open(run.filename)
    setPinnedRunId(scriptId)
  }, [scriptId, scripts, ws])

  const selectFile = (name) => { ws.open(name); setPinnedRunId(null) }
  const selectRun = (run) => {
    if (ws.files?.some((file) => file.name === run.filename)) ws.open(run.filename)
    setPinnedRunId(run.id)
  }

  const run = useCallback(async () => {
    if (!active || starting) return
    if (!(await ws.save(active))) return
    const text = ws.latest(active)
    if (!text?.trim()) { notify(`${active} is empty.`); return }
    setStarting(true)
    try {
      const record = await api.startScript({ filename: active, content: text, target_node: target, args: splitArgs(argsByFile[active]) })
      setPinnedRunId(record.id)
      console_.open()
      refresh()
    } catch (error) {
      notify(`Could not run ${active}: ${error.message}`)
    } finally {
      setStarting(false)
    }
  }, [active, starting, ws, target, argsByFile, notify, refresh, console_])

  // Keyboard: ⌘↵ runs, ⌘S saves — inside the editor (keymap below) and anywhere on this page.
  const actions = useRef({})
  useEffect(() => { actions.current = { run, save: () => active && ws.save(active) } })
  useEffect(() => {
    const onKey = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.defaultPrevented) return
      if (event.key === 'Enter') { event.preventDefault(); actions.current.run() }
      if (event.key === 's') { event.preventDefault(); actions.current.save() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const shortcuts = useMemo(() => Prec.highest(keymap.of([
    { key: 'Mod-Enter', run: () => { actions.current.run(); return true } },
    { key: 'Mod-s', run: () => { actions.current.save(); return true } },
  ])), [])

  return <div className="ide" style={{ '--console-height': `${console_.height}px` }}>
    <aside className="ide-side">
      <FilesPanel ws={ws} onSelect={selectFile} />
      <RunsPanel selectedId={consoleRun?.id} onSelect={selectRun} />
    </aside>

    <section className="ide-main">
      <EditorTabs ws={ws} onSelect={selectFile} />
      {active && <div className="ide-toolbar">
        <div className="ide-file-title"><FileIcon /><strong>{active}</strong><SaveState doc={doc} /></div>
        <div className="ide-run-controls">
          <TargetPicker value={target} onChange={setTarget} />
          <input className="ide-args" aria-label="Arguments" placeholder="arguments" spellCheck={false} value={argsByFile[active] || ''} onChange={(event) => setArgsByFile((current) => ({ ...current, [active]: event.target.value }))} />
          {activeRun && <Button variant="danger" icon={<StopIcon />} disabled={activeRun.stop_requested} onClick={() => stop(activeRun)}>{activeRun.stop_requested ? 'Stopping…' : 'Stop'}</Button>}
          <Button variant="primary" icon={<PlayIcon />} onClick={run} disabled={starting || doc?.state !== 'ready'} title={`Run (${MOD}↵)`}>{starting ? 'Starting…' : 'Run'}<kbd>{MOD}↵</kbd></Button>
        </div>
      </div>}

      <div className="ide-editor">
        {!ws.files ? <div className="ide-empty">Loading your scripts…</div>
          : !active ? <NoFileOpen ws={ws} />
          : doc?.state === 'missing' ? <div className="ide-empty">{active} could not be opened: {doc.error}</div>
          : doc?.state !== 'ready' ? <div className="ide-empty">Opening {active}…</div>
          : <CodeMirror
              key={active}
              value={doc.text}
              height="100%"
              theme={editorTheme}
              extensions={[python(), shortcuts]}
              onChange={(text) => ws.edit(active, text)}
              onUpdate={(update) => {
                if (!update.selectionSet && !update.docChanged) return
                const head = update.state.selection.main.head
                const line = update.state.doc.lineAt(head)
                setCursor({ line: line.number, col: head - line.from + 1 })
              }}
              autoFocus
              basicSetup={{ lineNumbers: true, highlightActiveLine: true, highlightActiveLineGutter: true, foldGutter: true, autocompletion: true, bracketMatching: true, closeBrackets: true, indentOnInput: true, highlightSelectionMatches: true, tabSize: 4 }}
            />}
      </div>

      <div className="ide-splitter" role="separator" aria-orientation="horizontal" aria-label="Resize output" tabIndex={0} onPointerDown={console_.startDrag} onKeyDown={console_.onKey} />
      <RunConsole key={consoleRun?.id || 'none'} run={consoleRun} collapsed={console_.collapsed} onToggle={console_.toggle} onStop={consoleRun && consoleRun.id !== activeRun?.id ? stop : null} />

      <footer className="ide-status">
        <span>{active ? `Ln ${cursor.line}, Col ${cursor.col}` : ''}</span>
        <span>Python</span>
        <span>{doc?.state === 'ready' ? `${doc.text.split('\n').length} lines` : ''}</span>
        <span className="ide-status-path" title={ws.folder}>{shortPath(ws.folder)}</span>
      </footer>
    </section>
  </div>
}

function SaveState({ doc }) {
  if (!doc || doc.state !== 'ready') return null
  if (doc.saveError) return <span className="save-state error" title={doc.saveError}>Not saved</span>
  if (doc.saving) return <span className="save-state">Saving…</span>
  if (doc.text !== doc.saved) return <span className="save-state dirty">Edited</span>
  return <span className="save-state saved">Saved</span>
}

function TargetPicker({ value, onChange }) {
  const { nodes } = useRuntime()
  const options = computerOptions(nodes)
  const known = options.some((option) => option.value === value)
  return <div className="ide-target"><Dropdown ariaLabel="Run on" value={known ? value : 'local'} onChange={onChange} options={options} /></div>
}

// Files, open tabs and their contents. Edits autosave 0.7 s after you stop typing.
function useWorkspace() {
  const notify = useToast()
  const [folder, setFolder] = useState('')
  const [files, setFiles] = useState(null)
  const [view, setView] = useState(() => remember(KEYS.view, { tabs: [], active: null }))
  const [docs, setDocs] = useState({})
  const docsRef = useRef(docs)
  const timers = useRef({})
  useEffect(() => { docsRef.current = docs }, [docs])
  useEffect(() => { persist(KEYS.view, view) }, [view])

  const patchDoc = (name, patch) => setDocs((current) => ({ ...current, [name]: { ...current[name], ...patch } }))

  const reload = useCallback(async () => {
    try {
      const data = await api.workspace()
      setFolder(data.path)
      setFiles(data.files)
      return data.files
    } catch (error) {
      notify(`Could not list your scripts: ${error.message}`)
      setFiles((current) => current || [])
      return null
    }
  }, [notify])

  const fetchDoc = useCallback(async (name, { quiet = false } = {}) => {
    if (!quiet) setDocs((current) => ({ ...current, [name]: { text: '', saved: '', state: 'loading' } }))
    try {
      const file = await api.readFile(name)
      setDocs((current) => {
        const existing = current[name]
        // Picks up edits made outside HAR, but never overwrites unsaved typing here.
        if (quiet && existing && existing.text !== existing.saved) return current
        if (quiet && existing?.saved === file.content) return current
        return { ...current, [name]: { text: file.content, saved: file.content, state: 'ready' } }
      })
    } catch (error) {
      if (!quiet) setDocs((current) => ({ ...current, [name]: { text: '', saved: '', state: 'missing', error: error.message } }))
    }
  }, [])

  const open = useCallback((name) => {
    setView((current) => ({ tabs: current.tabs.includes(name) ? current.tabs : [...current.tabs, name], active: name }))
  }, [])

  const save = useCallback(async (name) => {
    window.clearTimeout(timers.current[name])
    const doc = docsRef.current[name]
    if (!doc || doc.state !== 'ready' || doc.text === doc.saved) return true
    const text = doc.text
    patchDoc(name, { saving: true })
    try {
      await api.saveFile(name, text)
      patchDoc(name, { saved: text, saving: false, saveError: '' })
      return true
    } catch (error) {
      patchDoc(name, { saving: false, saveError: error.message })
      notify(`Could not save ${name}: ${error.message}`)
      return false
    }
  }, [notify])

  const edit = useCallback((name, text) => {
    setDocs((current) => ({ ...current, [name]: { ...current[name], text } }))
    window.clearTimeout(timers.current[name])
    timers.current[name] = window.setTimeout(() => save(name), AUTOSAVE_MS)
  }, [save])

  const latest = useCallback((name) => docsRef.current[name]?.text, [])

  const close = useCallback((name) => {
    save(name)
    setView((current) => {
      const index = current.tabs.indexOf(name)
      const tabs = current.tabs.filter((tab) => tab !== name)
      const active = current.active === name ? (tabs[index] || tabs[index - 1] || null) : current.active
      return { tabs, active }
    })
  }, [save])

  const create = useCallback(async (rawName, content = NEW_FILE_TEXT) => {
    const name = toPyName(rawName)
    if (files?.some((file) => file.name === name)) throw new Error(`${name} already exists`)
    await api.saveFile(name, content)
    setDocs((current) => ({ ...current, [name]: { text: content, saved: content, state: 'ready' } }))
    await reload()
    open(name)
    return name
  }, [files, reload, open])

  const rename = useCallback(async (name, rawNext) => {
    const next = toPyName(rawNext)
    if (!next || next === name) return
    await save(name)
    await api.renameFile(name, next)
    setDocs((current) => { const rest = { ...current }; const doc = rest[name]; delete rest[name]; if (doc) rest[next] = doc; return rest })
    setView((current) => ({ tabs: current.tabs.map((tab) => (tab === name ? next : tab)), active: current.active === name ? next : current.active }))
    await reload()
  }, [save, reload])

  const remove = useCallback(async (name) => {
    window.clearTimeout(timers.current[name])
    await api.deleteFile(name)
    close(name)
    setDocs((current) => { const rest = { ...current }; delete rest[name]; return rest })
    await reload()
  }, [close, reload])

  // First load, and again whenever the window regains focus (files may change in other editors).
  const viewRef = useRef(view)
  useEffect(() => { viewRef.current = view }, [view])
  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    const onFocus = () => { reload(); const name = viewRef.current.active; if (name) fetchDoc(name, { quiet: true }) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reload, fetchDoc])

  // Drop tabs whose files are gone; make sure something is open when there are files.
  useEffect(() => {
    if (!files) return
    const names = new Set(files.map((file) => file.name))
    setView((current) => {
      const tabs = current.tabs.filter((tab) => names.has(tab))
      let active = current.active && names.has(current.active) ? current.active : tabs[0] || null
      if (!active && files.length) active = files[0].name
      if (active && !tabs.includes(active)) tabs.push(active)
      return tabs.length === current.tabs.length && active === current.active ? current : { tabs, active }
    })
  }, [files])

  // Load the active file's contents the first time it's shown.
  useEffect(() => {
    if (view.active && !docsRef.current[view.active]) fetchDoc(view.active)
  }, [view.active, fetchDoc])

  // Leaving the page: write anything still waiting for its autosave.
  useEffect(() => () => { Object.keys(timers.current).forEach((name) => save(name)) }, [save])

  return { folder, files, view, docs, reload, open, close, edit, save, latest, create, rename, remove }
}

function FilesPanel({ ws, onSelect }) {
  const ask = useConfirm()
  const notify = useToast()
  const [naming, setNaming] = useState(null) // { mode: 'new' | 'rename', name, value }
  const picker = useRef(null)

  const startNew = () => {
    let n = 1
    const taken = new Set((ws.files || []).map((file) => file.name))
    while (taken.has(n === 1 ? 'untitled.py' : `untitled-${n}.py`)) n += 1
    setNaming({ mode: 'new', value: n === 1 ? 'untitled.py' : `untitled-${n}.py` })
  }
  const commit = async () => {
    const value = naming.value.trim()
    const current = naming
    setNaming(null)
    if (!value) return
    try {
      if (current.mode === 'new') await ws.create(value)
      else await ws.rename(current.name, value)
    } catch (error) { notify(error.message) }
  }
  const remove = async (name) => {
    const ok = await ask({ title: `Delete ${name}?`, message: `It is removed from ${ws.folder}. Past runs and their output stay in the run list.`, confirmLabel: 'Delete' })
    if (!ok) return
    try { await ws.remove(name) } catch (error) { notify(`Could not delete ${name}: ${error.message}`) }
  }
  // "Open file…" copies a .py file from anywhere on this computer into the scripts folder.
  const importFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.py')) { notify('Choose a .py file.'); return }
    const text = await file.text()
    const exists = ws.files?.some((item) => item.name === file.name)
    if (exists && !(await ask({ title: `Replace ${file.name}?`, message: 'A script with this name is already in your scripts folder.', confirmLabel: 'Replace' }))) return
    try {
      if (exists) { await api.saveFile(file.name, text); await ws.reload(); ws.open(file.name) } else { await ws.create(file.name, text) }
    } catch (error) { notify(`Could not add ${file.name}: ${error.message}`) }
  }

  const nameInput = naming && <input className="file-name-input" autoFocus spellCheck={false} value={naming.value}
    onChange={(event) => setNaming({ ...naming, value: event.target.value })}
    onFocus={(event) => event.target.setSelectionRange(0, event.target.value.replace(/\.py$/i, '').length)}
    onKeyDown={(event) => { if (event.key === 'Enter') commit(); if (event.key === 'Escape') { event.stopPropagation(); setNaming(null) } }}
    onBlur={commit} />

  return <section className="ide-panel files-panel" aria-label="Files">
    <div className="ide-panel-head">
      <span className="eyebrow">FILES</span>
      <div className="ide-panel-actions">
        <IconButton icon={<PlusIcon />} label="New file" onClick={startNew} />
        <IconButton icon={<OpenFileIcon />} label="Open a .py file from this computer" onClick={() => picker.current?.click()} />
        <IconButton icon={<RefreshIcon />} label="Refresh files" onClick={ws.reload} />
      </div>
      <input ref={picker} type="file" accept=".py,text/x-python" hidden onChange={importFile} />
    </div>
    <ul className="file-list">
      {naming?.mode === 'new' && <li className="file-item naming"><FileIcon />{nameInput}</li>}
      {(ws.files || []).map((file) => {
        const doc = ws.docs[file.name]
        const dirty = doc && doc.state === 'ready' && doc.text !== doc.saved
        if (naming?.mode === 'rename' && naming.name === file.name) return <li key={file.name} className="file-item naming"><FileIcon />{nameInput}</li>
        return <li key={file.name} className={`file-item ${ws.view.active === file.name ? 'active' : ''}`}>
          <button type="button" className="file-open" onClick={() => onSelect(file.name)} onDoubleClick={() => setNaming({ mode: 'rename', name: file.name, value: file.name })} title={`${file.name} · edited ${formatRelative(file.modified)}`}>
            <FileIcon /><span>{file.name}</span>{dirty && <i className="dirty-dot" aria-label="unsaved" />}
          </button>
          <span className="file-actions">
            <IconButton icon={<PencilIcon />} label={`Rename ${file.name}`} onClick={() => setNaming({ mode: 'rename', name: file.name, value: file.name })} />
            <IconButton icon={<TrashIcon />} label={`Delete ${file.name}`} onClick={() => remove(file.name)} />
          </span>
        </li>
      })}
      {ws.files && !ws.files.length && !naming && <li className="file-empty">No scripts yet.</li>}
    </ul>
  </section>
}

function RunsPanel({ selectedId, onSelect }) {
  const { scripts, nodes } = useRuntime()
  const running = scripts.some((script) => isActive(script.status))
  const now = useNow(running)
  return <section className="ide-panel runs-panel" aria-label="Runs">
    <div className="ide-panel-head"><span className="eyebrow">RUNS</span><span className="chart-meta">{scripts.length || ''}</span></div>
    <ul className="run-list">
      {scripts.slice(0, 40).map((script) => <li key={script.id}>
        <button type="button" className={`run-item ${script.id === selectedId ? 'active' : ''}`} onClick={() => onSelect(script)}>
          <span className={`workload-pulse ${script.status}`} />
          <span className="run-item-main"><strong>{script.filename}</strong><span>{nodeLabel(script.target_node, nodes)} · {formatRelative(script.created_at, now)}</span></span>
          <span className="run-item-time">{isActive(script.status) ? formatElapsed(scriptDuration(script, now)) : scriptOutcome(script)}</span>
        </button>
      </li>)}
      {!scripts.length && <li className="file-empty">Runs appear here. Press {MOD}↵ to run the open file.</li>}
    </ul>
  </section>
}

function EditorTabs({ ws, onSelect }) {
  if (!ws.view.tabs.length) return <div className="ide-tabs" />
  return <div className="ide-tabs" role="tablist">
    {ws.view.tabs.map((name) => {
      const doc = ws.docs[name]
      const dirty = doc && doc.state === 'ready' && doc.text !== doc.saved
      return <div key={name} className={`ide-tab ${ws.view.active === name ? 'active' : ''}`} role="tab" aria-selected={ws.view.active === name}>
        <button type="button" className="ide-tab-name" onClick={() => onSelect(name)} onAuxClick={(event) => { if (event.button === 1) ws.close(name) }}>{name}</button>
        <button type="button" className={`ide-tab-close ${dirty ? 'dirty' : ''}`} aria-label={`Close ${name}`} title={dirty ? 'Saving…' : 'Close'} onClick={() => ws.close(name)}><CloseIcon /></button>
      </div>
    })}
  </div>
}

function NoFileOpen({ ws }) {
  const notify = useToast()
  const create = () => ws.create('untitled.py').catch((error) => notify(error.message))
  return <div className="ide-empty">
    <strong>{ws.files.length ? 'No file open' : 'Write your first script'}</strong>
    <span>{ws.files.length ? 'Pick a file on the left, or start a new one.' : `Scripts are saved as .py files in ${ws.folder}.`}</span>
    <Button variant="primary" icon={<PlusIcon />} onClick={create}>New file</Button>
  </div>
}

// Console height: drag the bar above it (or focus it and use ↑/↓). Remembered per viewer.
function useConsoleSize() {
  const [state, setState] = useState(() => remember(KEYS.console, { height: 240, collapsed: false }))
  useEffect(() => { persist(KEYS.console, state) }, [state])
  const clamp = (value) => Math.min(Math.max(value, 80), Math.max(window.innerHeight - 280, 120))
  const startDrag = (event) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = state.collapsed ? 34 : state.height
    const move = (moveEvent) => setState({ collapsed: false, height: clamp(startHeight - (moveEvent.clientY - startY)) })
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const onKey = (event) => {
    if (event.key === 'ArrowUp') { event.preventDefault(); setState((current) => ({ collapsed: false, height: clamp(current.height + 24) })) }
    if (event.key === 'ArrowDown') { event.preventDefault(); setState((current) => ({ ...current, height: clamp(current.height - 24) })) }
  }
  return {
    height: state.collapsed ? 34 : state.height,
    collapsed: state.collapsed,
    startDrag,
    onKey,
    toggle: () => setState((current) => ({ ...current, collapsed: !current.collapsed })),
    open: () => setState((current) => (current.collapsed ? { ...current, collapsed: false } : current)),
  }
}

const NEAR_BOTTOM_PX = 32
const lineClass = (chunk) => chunk.text.startsWith('[har]') ? 'out-har' : chunk.stream === 'stderr' ? 'out-stderr' : undefined

// The bottom panel: one run's live output. Follows new output only while you're at the
// bottom; scroll up to read and it stays put, offering "Jump to latest".
function RunConsole({ run, collapsed, onToggle, onStop }) {
  const { nodes } = useRuntime()
  const stream = useScriptStream(run?.id)
  const running = Boolean(run && isActive(run.status))
  const now = useNow(running)
  const { chunks, phase, truncated } = stream
  const boxRef = useRef(null)
  const stick = useRef(true)
  const seenCount = useRef(0)
  const [unseen, setUnseen] = useState(0)
  const [copied, setCopied] = useState(false)

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const added = chunks.length - seenCount.current
    seenCount.current = chunks.length
    if (stick.current) box.scrollTop = box.scrollHeight
    else if (added > 0) setUnseen((count) => count + added)
  }, [chunks, collapsed])

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
  const jump = () => { boxRef.current.scrollTop = boxRef.current.scrollHeight; stick.current = true; setUnseen(0) }
  const copy = () => navigator.clipboard?.writeText(chunks.map((chunk) => chunk.text).join('')).then(() => setCopied(true)).catch(() => {})
  const phaseNote = PHASE_TEXT[phase]

  return <section className={`ide-console ${collapsed ? 'collapsed' : ''}`} aria-label="Output">
    <div className="ide-console-head">
      <button type="button" className="console-toggle" onClick={onToggle} aria-expanded={!collapsed} title={collapsed ? 'Show output' : 'Hide output'}><ChevronIcon /><span className="eyebrow">OUTPUT</span></button>
      {run ? <>
        <StatusBadge status={run.status} />
        <span className="console-meta"><strong>{run.filename}</strong>{run.args?.length ? ` ${run.args.join(' ')}` : ''} · {nodeLabel(run.target_node, nodes)} · {formatElapsed(scriptDuration(run, now))}{running ? '' : ` · ${scriptOutcome(run)}`}{phaseNote && phase !== 'live' ? ` · ${phaseNote}` : ''}</span>
      </> : <span className="console-meta">Nothing has run yet. Press {MOD}↵ to run the open file.</span>}
      <span className="console-actions">
        {running && onStop && <Button variant="danger" icon={<StopIcon />} disabled={run.stop_requested} onClick={() => onStop(run)}>{run.stop_requested ? 'Stopping…' : 'Stop'}</Button>}
        <Button variant="text" icon={<CopyIcon />} onClick={copy} disabled={!chunks.length}>{copied ? 'Copied' : 'Copy'}</Button>
      </span>
    </div>
    {!collapsed && <div className="ide-console-body">
      <pre ref={boxRef} className="console-output" onScroll={onScroll} tabIndex={0} aria-label="Script output">
        {truncated && <span className="out-har">[har] Older output was dropped; showing the last 200,000 characters.{'\n'}</span>}
        {chunks.length
          ? chunks.map((chunk) => <span key={chunk.seq} className={lineClass(chunk)}>{chunk.text}</span>)
          : <span className="out-placeholder">{!run ? '' : running ? 'Started. Anything it prints shows up here as it happens.' : phase === 'gone' ? 'HAR restarted since this ran, so its output is gone.' : phase === 'done' ? 'This run printed nothing.' : 'Loading output…'}</span>}
        {run?.error && !running && run.status !== 'completed' && !chunks.some((chunk) => chunk.text.includes(run.error.trim().slice(-80))) && <span className="out-stderr">{'\n'}{run.error}</span>}
      </pre>
      {unseen > 0 && <button type="button" className="jump-latest" onClick={jump}><DownIcon /> Jump to latest ({unseen} new)</button>}
    </div>}
  </section>
}

const PHASE_TEXT = {
  connecting: 'connecting…',
  live: 'live',
  reconnecting: 'connection dropped, reconnecting…',
  polling: 'live (polling)',
  done: '',
  gone: 'this run is no longer available',
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

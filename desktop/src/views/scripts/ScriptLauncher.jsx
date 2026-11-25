import { useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { python } from '@codemirror/lang-python'
import { oneDark } from '@codemirror/theme-one-dark'
import { Dropdown } from '../../components/Dropdown.jsx'

export const DEFAULT_SCRIPT = `import har
import torch


@har.offload
def big_matmul(size: int) -> torch.Tensor:
    left = torch.randn(size, size)
    right = torch.randn(size, size)
    return left @ right


result = big_matmul(2048)
print("result shape:", tuple(result.shape))
`

export function ScriptLauncher({ nodes, onClose, onSubmit }) {
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
      await onSubmit({ filename: name, content, target_node: targetNode, args: args.trim() ? args.trim().split(/\s+/) : [] })
    } catch (submitError) { setError(submitError.message) }
  }

  const lineCount = content.split('\n').length
  const remoteNodes = nodes.filter((node) => node.name !== 'This device')

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="launcher-modal editor-modal" onSubmit={submit}>
    <div className="modal-header"><div><div className="eyebrow">NEW SCRIPT</div><h2>Write Python</h2></div><button type="button" className="close-button" onClick={onClose}>X</button></div>
    <p>Type Python here (or load a .py file to seed it). HAR copies the code to the selected computer and runs it in a temporary job folder.</p>
    <div className="editor-head">
      <label className="editor-filename">Filename<input value={filename} onChange={(event) => setFilename(event.target.value)} /></label>
      <label className="editor-load secondary-button" title="Load a .py file into the editor">Load file...<input type="file" accept=".py,text/x-python" onChange={loadFile} hidden /></label>
    </div>
    <label>Code <span className="editor-meta">{lineCount} line{lineCount === 1 ? '' : 's'} · {content.length} chars</span></label>
    <div className="code-editor-wrap">
      <CodeMirror
        value={content}
        height="380px"
        theme={oneDark}
        extensions={[python()]}
        onChange={(value) => setContent(value)}
        basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: false, autocompletion: true, bracketMatching: true, indentOnInput: true, highlightSelectionMatches: true }}
      />
    </div>
    <label>Computer<Dropdown ariaLabel="Target computer" value={targetNode} onChange={setTargetNode} options={[{ value: 'local', label: 'This computer' }, ...remoteNodes.map((node) => ({ value: node.node_id, label: node.name, disabled: node.status !== 'online', hint: node.status === 'online' ? null : 'not available' }))]} /></label>
    <label>Arguments <span className="optional">OPTIONAL</span><input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="--input data.csv" /></label>
    <div className="advanced-note">The script runs with the Python packages already installed on the selected computer. @har.offload-decorated functions get routed by HAR; everything else runs in-process as usual.</div>
    {error && <div className="form-error">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Run script <span>-&gt;</span></button></div>
  </form></div>
}

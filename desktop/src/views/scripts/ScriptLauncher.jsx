import { useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { python } from '@codemirror/lang-python'
import { oneDark } from '@codemirror/theme-one-dark'
import { api } from '../../api/endpoints.js'
import { useNavigation } from '../../app/NavigationProvider.jsx'
import { useRuntime } from '../../app/RuntimeProvider.jsx'
import { useToast } from '../../app/ToastProvider.jsx'
import { Button } from '../../components/Button.jsx'
import { Dropdown } from '../../components/Dropdown.jsx'
import { Field } from '../../components/Field.jsx'
import { Modal, ModalActions } from '../../components/Modal.jsx'
import { ArrowRightIcon } from '../../components/icons.jsx'
import { computerOptions } from '../../lib/devices.js'

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

export function ScriptLauncher({ onClose }) {
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
      go('workloads', { scriptId: script.id })
      notify(`${script.filename} is running. Output will appear below.`)
      await refresh()
    } catch (submitError) { setError(submitError.message) }
  }

  const lineCount = content.split('\n').length

  return <Modal eyebrow="NEW SCRIPT" title="Write Python" onClose={onClose} onSubmit={submit} className="editor-modal">
    <p>Type Python here (or load a .py file to seed it). HAR copies the code to the selected computer and runs it in a temporary job folder.</p>
    <div className="editor-head">
      <Field label="Filename" className="editor-filename"><input value={filename} onChange={(event) => setFilename(event.target.value)} spellCheck={false} /></Field>
      <label className="editor-load secondary-button" title="Load a .py file into the editor">Load file…<input type="file" accept=".py,text/x-python" onChange={loadFile} hidden /></label>
    </div>
    <div className="field-label code-label">Code <span className="editor-meta">{lineCount} line{lineCount === 1 ? '' : 's'} · {content.length} chars</span></div>
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
    <Field label="Computer"><Dropdown ariaLabel="Target computer" value={targetNode} onChange={setTargetNode} options={computerOptions(nodes)} /></Field>
    <Field label="Arguments" optional><input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="--input data.csv" spellCheck={false} /></Field>
    <div className="advanced-note">The script runs with the Python packages already installed on the selected computer. @har.offload-decorated functions get routed by HAR; everything else runs in-process as usual.</div>
    {error && <div className="form-error">{error}</div>}
    <ModalActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" iconAfter={<ArrowRightIcon />}>Run script</Button></ModalActions>
  </Modal>
}

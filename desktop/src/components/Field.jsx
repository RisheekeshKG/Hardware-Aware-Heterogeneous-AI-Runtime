// A labelled form control. The label wraps the control, so no id wiring is needed.
export function Field({ label, optional = false, meta, className = '', children }) {
  return <label className={`field ${className}`.trim()}>
    <span className="field-label">{label}{optional && <span className="optional">OPTIONAL</span>}{meta && <span className="editor-meta">{meta}</span>}</span>
    {children}
  </label>
}

// Small shared pieces: buttons, dialogs, form fields, badges, icons, dropdown.
import { useEffect, useId, useRef, useState } from 'react'
import { backendTag, friendlyBackend } from './helpers.js'

// variant: primary (one per view), secondary, danger (stop / remove), text.
export function Button({ variant = 'secondary', icon, iconAfter, className = '', children, type = 'button', ...rest }) {
  return <button type={type} className={`${variant}-button ${className}`.trim()} {...rest}>
    {icon}{children}{iconAfter && <span className="button-icon-after">{iconAfter}</span>}
  </button>
}

// Square icon-only button. `label` is required: it is the accessible name and tooltip.
export function IconButton({ icon, label, className = '', ...rest }) {
  return <button type="button" className={`icon-button ${className}`.trim()} aria-label={label} title={label} {...rest}>{icon}</button>
}

const FOCUSABLE = 'input, textarea, select, button:not(.close-button), [tabindex]:not([tabindex="-1"]), .cm-content'

// Esc and a click on the backdrop close it; focus moves into it on open and returns to
// whatever had it on close. Pass onSubmit to render the body as a <form>.
export function Modal({ eyebrow, title, onClose, onSubmit, className = '', role = 'dialog', children }) {
  const titleId = useId()
  const boxRef = useRef(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    const previous = document.activeElement
    const first = boxRef.current?.querySelector(FOCUSABLE)
    ;(first || boxRef.current)?.focus()
    const onKey = (event) => {
      if (event.key !== 'Escape' || !onCloseRef.current || event.defaultPrevented) return
      // The code editor uses Esc itself (closing completions); closing the modal there would lose the script.
      if (event.target?.closest?.('.cm-editor')) return
      event.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); previous?.focus?.() }
  }, [])

  const Box = onSubmit ? 'form' : 'div'
  return <div className="modal-backdrop" onMouseDown={(event) => { if (onClose && event.target === event.currentTarget) onClose() }}>
    <Box ref={boxRef} className={`launcher-modal ${className}`.trim()} role={role} aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onSubmit={onSubmit}>
      <div className="modal-header">
        <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2 id={titleId}>{title}</h2></div>
        {onClose && <IconButton className="close-button" label="Close" icon={<CloseIcon />} onClick={onClose} />}
      </div>
      {children}
    </Box>
  </div>
}

export function ModalActions({ children }) {
  return <div className="modal-actions">{children}</div>
}

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', tone = 'danger', onAnswer }) {
  return <Modal role="alertdialog" eyebrow="PLEASE CONFIRM" title={title} onClose={() => onAnswer(false)} className="confirm-modal">
    {message && <p>{message}</p>}
    <ModalActions>
      <Button onClick={() => onAnswer(false)}>Cancel</Button>
      <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={() => onAnswer(true)}>{confirmLabel}</Button>
    </ModalActions>
  </Modal>
}

// A labelled form control. The label wraps the control, so no id wiring is needed.
export function Field({ label, optional = false, meta, className = '', children }) {
  return <label className={`field ${className}`.trim()}>
    <span className="field-label">{label}{optional && <span className="optional">OPTIONAL</span>}{meta && <span className="editor-meta">{meta}</span>}</span>
    {children}
  </label>
}

export function Dropdown({ value, onChange, options, placeholder = 'Choose...', disabled = false, ariaLabel }) {
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(-1)
  const rootRef = useRef(null)
  const current = options.find((option) => option.value === value)
  useEffect(() => {
    if (!open) return undefined
    const close = (event) => { if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  // Clamp focused index when the options array shrinks underneath us, so Enter can't
  // trigger a now-removed item and ArrowDown/Up still land on something real.
  useEffect(() => {
    if (focused >= options.length || (focused >= 0 && options[focused]?.disabled)) setFocused(-1)
  }, [options, focused])
  const enabledIndices = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0)
  const handleKey = (event) => {
    if (disabled) return
    if (!open && (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown')) { event.preventDefault(); setOpen(true); setFocused(enabledIndices[0] ?? -1); return }
    if (!open) return
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const pos = enabledIndices.indexOf(focused)
      const nextPos = pos === -1 ? 0 : (pos + direction + enabledIndices.length) % enabledIndices.length
      setFocused(enabledIndices[nextPos])
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const option = options[focused]
      if (option && !option.disabled) { onChange(option.value); setOpen(false) }
    }
  }
  return <div className={`dropdown ${disabled ? 'disabled' : ''} ${open ? 'open' : ''}`} ref={rootRef}>
    <button type="button" className="dropdown-trigger" onClick={() => !disabled && setOpen((state) => !state)} onKeyDown={handleKey} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}>
      <span className="dropdown-label">{current ? current.label : placeholder}</span>
      <span className="dropdown-chevron"><ChevronDownIcon /></span>
    </button>
    {open && <ul className="dropdown-menu" role="listbox">
      {options.map((option, index) => <li key={option.value} role="option" aria-selected={option.value === value}>
        <button type="button" className={`dropdown-option ${option.value === value ? 'selected' : ''} ${option.disabled ? 'disabled' : ''} ${index === focused ? 'focused' : ''}`} onClick={() => { if (option.disabled) return; onChange(option.value); setOpen(false) }} disabled={option.disabled} onMouseEnter={() => setFocused(index)}>
          <span>{option.label}</span>
          {option.hint && <span className="dropdown-hint">{option.hint}</span>}
        </button>
      </li>)}
    </ul>}
  </div>
}

export function Brand() {
  return <div className="brand"><div className="brand-mark">H</div><div><strong>HAR</strong><span>runtime console</span></div></div>
}

export function PageHeader({ eyebrow, title, description, action }) {
  return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>
}

export function SectionHeading({ eyebrow, title, action, compact = false }) {
  return <div className={`section-heading ${compact ? 'compact' : ''}`.trim()}>
    <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}{title && <h2>{title}</h2>}</div>
    {action}
  </div>
}

export function EmptyState({ title, detail, action, onAction }) {
  return <div className="empty-state"><strong>{title}</strong><span>{detail}</span>{action && <Button onClick={onAction} iconAfter={<ArrowRightIcon />}>{action}</Button>}</div>
}

export function RefreshButton({ onClick, title = 'Refresh' }) {
  return <IconButton className="section-refresh" onClick={onClick} label={title} icon={<RefreshIcon />} />
}

// Short technical tag (CPU / MPS / CUDA); the full name is the tooltip.
export function BackendBadge({ backend }) {
  return <span className={`backend-badge ${String(backend).toLowerCase()}`} title={friendlyBackend(backend)}>{backendTag(backend)}</span>
}

export function StatusBadge({ status }) {
  return <span className={`status-badge ${status}`}><span className="status-dot" />{status}</span>
}

export function Placement({ label, value, accent }) { return <div><span>{label}</span><strong className={accent || ''}>{value}</strong></div> }
export function Metric({ label, value }) { return <div className="small-metric"><span>{label}</span><strong>{value}</strong></div> }
export function StatCard({ label, value, detail, accent }) { return <div className={`stat-card ${accent}`}><span className="eyebrow">{label}</span><strong>{value}</strong><span>{detail}</span></div> }

// Free memory as a share of total, in the backend's colour. Empty when either is unknown.
export function MemoryBar({ memory, backend, large = false }) {
  const total = memory?.total_bytes
  const free = memory?.available_bytes
  const width = total && free != null ? `${Math.min((free / total) * 100, 100)}%` : '0%'
  return <div className={`util-track ${large ? 'large' : ''}`.trim()} role="img" aria-label={total ? `${Math.round((free / total) * 100)}% memory free` : 'Memory unknown'}>
    <div className={`backend-fill ${backend}`} style={{ width }} />
  </div>
}

// Inline SVG icons (16px, stroke = currentColor). They replace the letter glyphs
// (R, X, v, ->, +) the UI used as icons. Decorative: the button carries the label.
const Svg = ({ children, size = 16 }) => <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>

export const RefreshIcon = () => <Svg><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 2.5v3h-3" /></Svg>
const CloseIcon = () => <Svg><path d="M4 4l8 8M12 4l-8 8" /></Svg>
const ChevronDownIcon = () => <Svg size={12}><path d="M4 6l4 4 4-4" /></Svg>
export const ArrowRightIcon = () => <Svg size={14}><path d="M3 8h10M9 4l4 4-4 4" /></Svg>
export const PlusIcon = () => <Svg size={14}><path d="M8 3v10M3 8h10" /></Svg>
export const StopIcon = () => <Svg size={14}><rect x="4" y="4" width="8" height="8" rx="1" /></Svg>
export const CopyIcon = () => <Svg size={14}><rect x="5.5" y="5.5" width="8" height="8" rx="1" /><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" /></Svg>
export const DownIcon = () => <Svg size={14}><path d="M8 3v10M4 9l4 4 4-4" /></Svg>

// Navigation
export const OverviewIcon = () => <Svg><rect x="2.5" y="2.5" width="4.5" height="4.5" /><rect x="9" y="2.5" width="4.5" height="4.5" /><rect x="2.5" y="9" width="4.5" height="4.5" /><rect x="9" y="9" width="4.5" height="4.5" /></Svg>
export const ScriptsIcon = () => <Svg><path d="M5 5L2.5 8 5 11M11 5l2.5 3-2.5 3M9.2 3.5l-2.4 9" /></Svg>
export const DevicesIcon = () => <Svg><rect x="2" y="3" width="12" height="8" rx="1" /><path d="M6 14h4M8 11v3" /></Svg>
export const SettingsIcon = () => <Svg><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6" /></Svg>
export const BenchmarksIcon = () => <Svg><path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" /></Svg>

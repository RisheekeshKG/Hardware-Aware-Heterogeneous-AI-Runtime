import { useState, useEffect, useRef } from 'react'

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
      <span className="dropdown-chevron" aria-hidden>v</span>
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

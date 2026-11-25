import { useEffect, useId, useRef } from 'react'
import { IconButton } from './Button.jsx'
import { CloseIcon } from './icons.jsx'

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

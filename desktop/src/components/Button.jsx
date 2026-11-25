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

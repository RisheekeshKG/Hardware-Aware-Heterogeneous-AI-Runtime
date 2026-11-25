export function RefreshButton({ onClick, title = 'Refresh' }) {
  return <button type="button" className="icon-button section-refresh" onClick={onClick} aria-label={title} title={title}>R</button>
}

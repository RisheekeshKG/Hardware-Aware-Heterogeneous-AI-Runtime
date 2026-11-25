import { IconButton } from './Button.jsx'
import { RefreshIcon } from './icons.jsx'

export function RefreshButton({ onClick, title = 'Refresh' }) {
  return <IconButton className="section-refresh" onClick={onClick} label={title} icon={<RefreshIcon />} />
}

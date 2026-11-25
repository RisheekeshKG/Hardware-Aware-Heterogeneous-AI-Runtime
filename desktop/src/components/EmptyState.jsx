import { Button } from './Button.jsx'
import { ArrowRightIcon } from './icons.jsx'

export function EmptyState({ title, detail, action, onAction }) {
  return <div className="empty-state"><strong>{title}</strong><span>{detail}</span>{action && <Button onClick={onAction} iconAfter={<ArrowRightIcon />}>{action}</Button>}</div>
}

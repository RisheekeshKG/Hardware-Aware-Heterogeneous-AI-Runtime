export function SectionHeading({ eyebrow, title, action, compact = false }) {
  return <div className={`section-heading ${compact ? 'compact' : ''}`.trim()}>
    <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}{title && <h2>{title}</h2>}</div>
    {action}
  </div>
}

export function Placement({ label, value, accent }) { return <div><span>{label}</span><strong className={accent || ''}>{value}</strong></div> }
export function Metric({ label, value }) { return <div className="small-metric"><span>{label}</span><strong>{value}</strong></div> }
export function StatCard({ label, value, detail, accent }) { return <div className={`stat-card ${accent}`}><span className="eyebrow">{label}</span><strong>{value}</strong><span>{detail}</span></div> }

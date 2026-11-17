import { useStatus } from '../lib/status.js'

/**
 * A status as a small pill. Labels come from /api/meta, tones from lib/status.js.
 *   <StatusPill kind="job" value="AWAITING_DEPOSIT" />
 *   <StatusPill kind="payment" value={order.payment_status} />
 *   <StatusPill kind="flag" value="OVERDUE" />
 */
export default function StatusPill({ kind, value, label, tone, icon = null, size, title }) {
  const status = useStatus()
  const text = label ?? status.label(kind, value)
  const t = tone ?? status.tone(kind, value)
  return (
    <span className={`braq-pill ${t}${size === 'sm' ? ' sm' : ''}`} title={title}>
      {icon}
      {text}
    </span>
  )
}

/** Flags (On hold, Overdue …) as a row of pills. */
export function FlagPills({ flags = [], size, exclude = [] }) {
  const shown = flags.filter((f) => !exclude.includes(f))
  if (!shown.length) return null
  return shown.map((f) => <StatusPill key={f} kind="flag" value={f} size={size} />)
}

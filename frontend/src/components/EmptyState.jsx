import { InboxOutlined } from '@ant-design/icons'

/**
 * Nothing to show — say why, and what to do next.
 *   <EmptyState title="No jobs match" action={<Button>Clear filters</Button>}>…</EmptyState>
 */
export default function EmptyState({ icon, title, children, action, compact = false }) {
  return (
    <div className={`braq-empty${compact ? ' compact' : ''}`}>
      {!compact && <span className="braq-empty-icon" aria-hidden="true">{icon ?? <InboxOutlined />}</span>}
      {title && <div className="braq-empty-title">{title}</div>}
      {children && <div className="braq-empty-text">{children}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  )
}

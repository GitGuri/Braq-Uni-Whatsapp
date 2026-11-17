/**
 * List-page header: title, one-line subtitle, actions on the right.
 *   <PageHeader title="Jobs" subtitle="…" actions={<Button …/>} />
 */
export default function PageHeader({ title, subtitle, actions, children }) {
  return (
    <div className="braq-page-header">
      <div style={{ minWidth: 0 }}>
        <h1 className="braq-page-title">{title}</h1>
        {subtitle && <div className="braq-page-subtitle">{subtitle}</div>}
      </div>
      {(actions || children) && <div className="braq-page-actions">{actions}{children}</div>}
    </div>
  )
}

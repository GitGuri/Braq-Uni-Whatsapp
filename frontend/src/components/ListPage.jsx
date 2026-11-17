import { Skeleton } from 'antd'
import PageHeader from './PageHeader.jsx'
import ErrorState from './ErrorState.jsx'

/**
 * Standard list page: header, a filter bar, then the list (or its loading /
 * error state). Filters live in the URL — see lib/useUrlState.js.
 *
 *   <ListPage title="Jobs" subtitle="…" actions={…} filters={…}
 *             error={error} onRetry={refetch} loading={isLoading}>
 *     …table / rows…
 *   </ListPage>
 */
export default function ListPage({ title, subtitle, actions, filters, chips, error, onRetry, loading, errorTitle, children }) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} actions={actions} />
      {chips && <div className="braq-chip-row" role="group" aria-label="Filter by state">{chips}</div>}
      {filters && <div className="braq-filter-bar" role="search" aria-label={`Filter ${String(title).toLowerCase()}`}>{filters}</div>}
      {error ? (
        <section className="braq-panel"><ErrorState title={errorTitle ?? `Could not load ${String(title).toLowerCase()}`} error={error} onRetry={onRetry} /></section>
      ) : loading ? (
        <section className="braq-panel" style={{ padding: 18 }}><Skeleton active paragraph={{ rows: 5 }} title={false} /></section>
      ) : children}
    </div>
  )
}

/** A filter chip with a count: <Chip active count={3} onClick>Pricing</Chip> */
export function Chip({ active, count, onClick, children, tone }) {
  return (
    <button type="button" className={`braq-chip${active ? ' active' : ''}${tone ? ` ${tone}` : ''}`} aria-pressed={!!active} onClick={onClick}>
      <span>{children}</span>
      {count != null && <span className="braq-chip-count">{count}</span>}
    </button>
  )
}

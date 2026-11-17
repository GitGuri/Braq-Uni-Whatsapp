import { useEffect, useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button, Grid, Input, Segmented, Switch, Table } from 'antd'
import { PlusOutlined, SearchOutlined, CloseOutlined } from '@ant-design/icons'
import { listJobs } from '../../api/jobs.js'
import { qk } from '../../lib/queryKeys.js'
import { useMeta } from '../../lib/useMeta.js'
import { useUrlState } from '../../lib/useUrlState.js'
import { money, shortDate, fromNow } from '../../lib/format.js'
import ListPage, { Chip } from '../../components/ListPage.jsx'
import StatusPill, { FlagPills } from '../../components/StatusPill.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import NewJobModal from '../../components/NewJobModal.jsx'

const PAGE_SIZE = 25
/**
 * Board views: every job, quotes (before an order exists) or orders. The old
 * Quotations and Orders pages open these views (/quotations → ?view=quotes).
 */
export const VIEWS = {
  all:    { label: 'All jobs', states: ['PRICING', 'QUOTED', 'ACCEPTED', 'AWAITING_DEPOSIT', 'AWAITING_PROOF', 'READY_TO_PRODUCE', 'IN_PRODUCTION', 'READY', 'COMPLETED', 'AFTER_SALES'], side: ['DECLINED', 'EXPIRED', 'CANCELLED'] },
  quotes: { label: 'Quotes', states: ['PRICING', 'QUOTED', 'ACCEPTED'], side: ['EXPIRED', 'DECLINED'] },
  orders: { label: 'Orders', states: ['AWAITING_DEPOSIT', 'AWAITING_PROOF', 'READY_TO_PRODUCE', 'IN_PRODUCTION', 'READY', 'COMPLETED', 'AFTER_SALES'], side: ['CANCELLED'] },
}
const allStates = (v) => [...VIEWS[v].states, ...VIEWS[v].side]

/**
 * The jobs board: every customer job — quotes and orders — by state. Filters
 * live in the URL (/jobs?view=orders&state=PRICING&queue=follow_up&owner=me&overdue=true&q=…),
 * so dashboard cells and queues link here pre-filtered and Back returns to the same view.
 */
export default function JobsBoard() {
  const navigate = useNavigate()
  const location = useLocation()
  const meta = useMeta()
  const phone = !Grid.useBreakpoint().sm
  const [f, set] = useUrlState({ view: '', state: '', queue: '', owner: '', overdue: false, q: '', page: 1 })
  const [search, setSearch] = useState(f.q)
  const [newOpen, setNewOpen] = useState(false)
  const view = VIEWS[f.view] ? f.view : 'all'

  // Debounce typing into the URL.
  useEffect(() => { setSearch(f.q) }, [f.q])
  useEffect(() => {
    if (search === f.q) return undefined
    const t = setTimeout(() => set({ q: search.trim() }), 300)
    return () => clearTimeout(t)
  }, [search]) // eslint-disable-line react-hooks/exhaustive-deps

  const params = {
    state: f.state || (view !== 'all' ? allStates(view).join(',') : undefined),
    queue: f.queue || undefined,
    owner: f.owner || undefined,
    overdue: f.overdue ? 'true' : undefined,
    search: f.q || undefined,
    page: f.page,
    limit: PAGE_SIZE,
  }
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: qk.jobs(params),
    queryFn: () => listJobs(params),
    placeholderData: (prev) => prev,
  })

  const counts = data?.counts ?? {}
  const label = (k) => meta.jobStates.find((s) => s.key === k)?.label ?? k
  const viewCount = allStates(view).reduce((s, k) => s + Number(counts[k] || 0), 0)
  const chipStates = [...VIEWS[view].states, ...VIEWS[view].side.filter((k) => counts[k] > 0 || f.state === k)]
  const queueLabel = (meta.jobQueues ?? []).find((x) => x.key === f.queue)?.label ?? f.queue
  const filtered = Boolean(f.state || f.queue || f.owner || f.overdue || f.q)
  const here = `${location.pathname}${location.search}`
  const open = (row) => navigate(`/jobs/${row.quotation_id}`, { state: { from: here } })

  const columns = [
    {
      title: 'Job',
      key: 'ref',
      render: (_, r) => (
        <div>
          <Link to={`/jobs/${r.quotation_id}`} state={{ from: here }} onClick={(e) => e.stopPropagation()} className="braq-ref">
            {r.order_reference ?? r.quotation_reference}
          </Link>
          {r.order_reference && <div className="braq-small braq-ref" style={{ color: 'var(--ink-3)' }}>{r.quotation_reference}</div>}
        </div>
      ),
    },
    {
      title: 'Client',
      key: 'client',
      render: (_, r) => (
        <div style={{ minWidth: 140 }}>
          <div style={{ fontWeight: 600 }}>{r.client_name ?? '—'}{r.account_terms && <span className="braq-pill blue sm" style={{ marginLeft: 6 }}>Account</span>}</div>
          {r.organisation && <div className="braq-small">{r.organisation}</div>}
        </div>
      ),
    },
    {
      title: 'State',
      key: 'state',
      render: (_, r) => (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 140 }}>
          <StatusPill kind="job" value={r.state} label={r.state_label} />
          <FlagPills flags={r.flags} />
        </div>
      ),
    },
    { title: 'Total', key: 'total', align: 'right', render: (_, r) => <span style={{ whiteSpace: 'nowrap' }}>{money(r.total)}</span> },
    { title: 'Due', key: 'due', responsive: ['md'], render: (_, r) => <span className="braq-small" style={{ whiteSpace: 'nowrap' }}>{shortDate(r.due_date)}</span> },
    {
      title: 'Owner',
      key: 'owner',
      responsive: ['md'],
      render: (_, r) => <span style={{ whiteSpace: 'nowrap', color: r.owner_name ? 'var(--ink)' : 'var(--ink-3)' }}>{r.owner_name ?? 'Unassigned'}</span>,
    },
    { title: 'Updated', key: 'updated', responsive: ['lg'], render: (_, r) => <span className="braq-small" style={{ whiteSpace: 'nowrap' }}>{fromNow(r.updated_at)}</span> },
  ]

  // Phones: one stacked column, so state and client are visible without scrolling sideways.
  const phoneColumns = [{
    title: 'Job',
    key: 'job',
    render: (_, r) => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <Link to={`/jobs/${r.quotation_id}`} state={{ from: here }} onClick={(e) => e.stopPropagation()} className="braq-ref">
            {r.order_reference ?? r.quotation_reference}
          </Link>
          <span style={{ whiteSpace: 'nowrap' }}>{money(r.total)}</span>
        </div>
        <div style={{ fontWeight: 600 }}>{r.client_name ?? '—'}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <StatusPill kind="job" value={r.state} label={r.state_label} />
          <FlagPills flags={r.flags} />
        </div>
        <div className="braq-small">{r.owner_name ?? 'Unassigned'}{r.due_date ? ` · due ${shortDate(r.due_date)}` : ''}</div>
      </div>
    ),
  }]

  const subtitle = view === 'quotes'
    ? 'Quotes being priced, waiting on the client, or accepted and waiting for their order.'
    : view === 'orders'
      ? 'Orders from deposit to collection. Overdue work comes first.'
      : 'Every customer job from quote to collection. Overdue work comes first — open a job to see its next step.'

  return (
    <ListPage
      title="Jobs"
      subtitle={subtitle}
      actions={<Button type="primary" icon={<PlusOutlined />} onClick={() => setNewOpen(true)}>New job</Button>}
      chips={(
        <>
          <Segmented
            value={view}
            onChange={(v) => set({ view: v === 'all' ? '' : v, state: '' })}
            options={Object.entries(VIEWS).map(([value, v]) => ({ value, label: v.label }))}
            aria-label="Quotes or orders"
            className="braq-view-switch"
          />
          <Chip active={!f.state} count={viewCount || undefined} onClick={() => set({ state: '' })}>All</Chip>
          {chipStates.map((k) => (
            <Chip key={k} active={f.state === k} count={counts[k] ?? 0} onClick={() => set({ state: f.state === k ? '' : k })}>{label(k)}</Chip>
          ))}
        </>
      )}
      filters={(
        <>
          <Input
            prefix={<SearchOutlined style={{ color: 'var(--ink-3)' }} />}
            placeholder="Search reference, client or number"
            aria-label="Search jobs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
            style={{ flex: '1 1 220px', maxWidth: 340 }}
          />
          <Segmented
            value={f.owner}
            onChange={(v) => set({ owner: v })}
            options={[{ value: '', label: 'Everyone' }, { value: 'me', label: 'Mine' }, { value: 'unassigned', label: 'Unassigned' }]}
            aria-label="Owner"
          />
          <label className="braq-switch-label">
            <Switch size="small" checked={f.overdue} onChange={(v) => set({ overdue: v })} aria-label="Overdue only" />
            Overdue only
          </label>
          {f.queue && (
            <button type="button" className="braq-chip active" onClick={() => set({ queue: '' })} aria-label={`Remove filter: ${queueLabel}`}>
              <span>{queueLabel}</span> <CloseOutlined aria-hidden="true" />
            </button>
          )}
        </>
      )}
      error={error}
      onRetry={refetch}
    >
      <section className="braq-panel" style={{ overflow: 'hidden' }}>
        <Table
          dataSource={data?.items ?? []}
          columns={phone ? phoneColumns : columns}
          rowKey="quotation_id"
          loading={isLoading || isFetching}
          size="middle"
          scroll={{ x: 'max-content' }}
          pagination={{
            current: f.page, pageSize: PAGE_SIZE, total: data?.total ?? 0,
            onChange: (page) => set({ page }), showSizeChanger: false, hideOnSinglePage: true,
          }}
          rowClassName={(r) => (r.flags?.includes('OVERDUE') ? 'braq-row-overdue' : '')}
          locale={{
            emptyText: isLoading ? ' ' : (
              <EmptyState
                title={filtered ? 'No jobs match these filters' : 'No jobs yet'}
                action={filtered
                  ? <Button onClick={() => { setSearch(''); set({ state: '', queue: '', owner: '', overdue: false, q: '' }) }}>Clear filters</Button>
                  : <Button type="primary" icon={<PlusOutlined />} onClick={() => setNewOpen(true)}>New job</Button>}
              >
                {filtered ? 'Try another state, or clear the filters to see every job.' : 'Jobs start when a client asks for a quote on WhatsApp, or when you start one.'}
              </EmptyState>
            ),
          }}
          onRow={(r) => ({
            onClick: () => open(r),
            onKeyDown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(r) },
            tabIndex: 0,
            style: { cursor: 'pointer' },
            'aria-label': `${r.order_reference ?? r.quotation_reference}, ${r.client_name ?? ''}, ${r.state_label ?? r.state}`,
          })}
        />
      </section>
      <NewJobModal open={newOpen} onClose={() => setNewOpen(false)} />
    </ListPage>
  )
}

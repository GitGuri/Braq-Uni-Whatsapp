import { useQuery } from '@tanstack/react-query'
import { Row, Col, Table, Skeleton, Tooltip, Grid } from 'antd'
import dayjs from 'dayjs'
import { getRevenueData, getTopClients, getTopProducts } from '../../api/analytics.js'
import StatusPill from '../../components/StatusPill.jsx'
import NoAccess from '../../components/NoAccess.jsx'
import ErrorState from '../../components/ErrorState.jsx'
import { useCan } from '../../lib/useCan.js'
import { money } from '../../lib/format.js'
import { STAGES, normaliseStage } from '../../lib/stages.js'

const fmt = (n) => money(n ?? 0)
// Axis labels: R 0, R 20k, R 1.5m
function compact(n) {
  if (n >= 1e6) return `R ${+(n / 1e6).toFixed(1)}m`
  if (n >= 1e3) return `R ${+(n / 1e3).toFixed(1)}k`
  return `R ${Math.round(n)}`
}
// Round the axis top up to 1, 2, 2.5 or 5 × 10ⁿ so gridlines land on readable numbers
function niceCeil(n) {
  if (n <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(n))
  const f = n / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p
}

const FIGURE = { fontSize: 32, fontStretch: '112%', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.05, color: 'var(--ink)', whiteSpace: 'nowrap' }
const CAPTION = { fontSize: 13, color: 'var(--ink-2)' }

function Panel({ id, title, extra, children, bodyStyle, style }) {
  return (
    <section className="braq-panel" aria-labelledby={id} style={{ height: '100%', overflow: 'hidden', ...style }}>
      <div className="braq-panel-head" style={{ flexWrap: 'wrap', rowGap: 4 }}>
        <h2 id={id} className="braq-panel-title">{title}</h2>
        {extra}
      </div>
      <div style={bodyStyle}>{children}</div>
    </section>
  )
}

function MonthlyChart({ byMonth, compactAxis }) {
  // Always show the last 12 calendar months, so empty months read as zero rather than vanishing.
  const values = new Map(byMonth.map((m) => [m.month, m]))
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = dayjs().startOf('month').subtract(11 - i, 'month')
    const row = values.get(d.format('YYYY-MM'))
    return { key: d.format('YYYY-MM'), date: d, revenue: Number(row?.revenue ?? 0), orders: Number(row?.orders ?? 0) }
  })
  const max = Math.max(...months.map((m) => m.revenue), 0)
  const top = niceCeil(max)
  const ticks = [top, top / 2, 0]
  const peak = max > 0 ? months.findIndex((m) => m.revenue === max) : -1
  const PLOT_H = 190

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: 10 }}>
      {/* y axis */}
      <div style={{ position: 'relative', height: PLOT_H, minWidth: 40 }} aria-hidden="true">
        {ticks.map((t) => (
          <span
            key={t}
            style={{ position: 'absolute', right: 0, top: `${(1 - t / top) * 100}%`, transform: 'translateY(-50%)', fontSize: 11, color: 'var(--ink-3)', whiteSpace: 'nowrap' }}
          >
            {compact(t)}
          </span>
        ))}
      </div>

      {/* plot */}
      <div style={{ position: 'relative', height: PLOT_H }}>
        {ticks.map((t) => (
          <div
            key={t}
            aria-hidden="true"
            style={{
              position: 'absolute', left: 0, right: 0, top: `${(1 - t / top) * 100}%`,
              borderTop: t === 0 ? '1px solid var(--ink-3)' : '1px dashed var(--ink-3)',
              opacity: t === 0 ? 0.7 : 0.3,
            }}
          />
        ))}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end' }}>
          {months.map((m, i) => {
            const h = m.revenue > 0 ? Math.max(2, (m.revenue / top) * PLOT_H) : 0
            const label = `${m.date.format('MMMM YYYY')}: ${fmt(m.revenue)}${m.orders ? `, ${m.orders} ${m.orders === 1 ? 'order' : 'orders'}` : ''}`
            return (
              <Tooltip key={m.key} title={label}>
                <div
                  tabIndex={0}
                  aria-label={label}
                  style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', position: 'relative' }}
                >
                  {i === peak && (
                    <span style={{ position: 'absolute', bottom: h + 4, fontSize: 11, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap' }}>
                      {compact(m.revenue)}
                    </span>
                  )}
                  <div style={{ width: '56%', maxWidth: 28, height: h, background: 'var(--thread)', borderRadius: '4px 4px 0 0' }} />
                </div>
              </Tooltip>
            )
          })}
        </div>
      </div>

      {/* x axis */}
      <div />
      <div style={{ display: 'flex', marginTop: 6 }} aria-hidden="true">
        {months.map((m, i) => (
          <span key={m.key} style={{ flex: 1, textAlign: 'center', fontSize: 11, color: 'var(--ink-3)', whiteSpace: 'nowrap', overflow: 'hidden' }}>
            {compactAxis ? (i % 2 === 1 ? m.date.format('MMM') : '') : m.date.format('MMM')}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function RevenueDashboard() {
  const allowed = useCan()('analytics.view')
  if (!allowed) {
    return <NoAccess title="Analytics">Analytics is for admins and managers. Ask one of them if you need these numbers.</NoAccess>
  }
  return <Revenue />
}

function Revenue() {
  const screens = Grid.useBreakpoint()
  const { data: rev, isLoading: revLoading, error: revError, refetch: refetchRev } = useQuery({
    queryKey: ['analytics', 'revenue'],
    queryFn: getRevenueData,
  })
  const { data: clientsData, isLoading: clientsLoading, error: clientsError, refetch: refetchClients } = useQuery({
    queryKey: ['analytics', 'top-clients'],
    queryFn: () => getTopClients(8),
  })
  const { data: productsData, isLoading: productsLoading, error: productsError, refetch: refetchProducts } = useQuery({
    queryKey: ['analytics', 'top-products'],
    queryFn: () => getTopProducts(8),
  })

  const summary      = rev?.summary ?? {}
  const byMonth      = rev?.byMonth ?? []
  const conversion   = rev?.conversion ?? {}
  const stageCounts  = rev?.stageBreakdown ?? []
  const topClients   = clientsData?.clients ?? []
  const topProducts  = productsData?.products ?? []

  const maxProductQty = Math.max(...topProducts.map((p) => Number(p.total_qty)), 1)

  // Group by the current 3 open stages (older orders may carry legacy stage names)
  const pipeline = STAGES.filter((s) => s.key !== 'completed').map((s) => ({
    ...s,
    count: stageCounts.filter((r) => normaliseStage(r.stage) === s.key).reduce((n, r) => n + Number(r.count), 0),
  }))
  const pipelineTotal = pipeline.reduce((n, s) => n + s.count, 0)

  const thisMonth = Number(summary.this_month ?? 0)
  const lastMonth = Number(summary.last_month ?? 0)
  const diff = thisMonth - lastMonth
  const yearTotal = byMonth.reduce((n, m) => n + Number(m.revenue), 0)

  const headline = [
    {
      label: 'This month',
      value: fmt(thisMonth),
      note: lastMonth > 0
        ? `${diff >= 0 ? 'Up' : 'Down'} ${fmt(Math.abs(diff))} on last month`
        : 'Nothing was received last month',
    },
    { label: 'Last month', value: fmt(lastMonth), note: dayjs().subtract(1, 'month').format('MMMM YYYY') },
    { label: 'All-time revenue', value: fmt(summary.all_time), note: 'Every payment recorded in Braq Connect' },
  ]
  const cols = screens.md ? 3 : 1

  const pct = Number(conversion.conversion_pct ?? 0)
  const convRows = [
    { label: 'Accepted',             value: conversion.accepted, tone: 'green' },
    { label: 'Waiting on the client', value: conversion.sent,    tone: 'blue' },
    { label: 'Still being priced',   value: conversion.draft,    tone: 'amber' },
    { label: 'Declined',             value: conversion.rejected, tone: 'red' },
    { label: 'Expired',              value: conversion.expired,  tone: '' },
  ].filter((r) => r.value != null)

  const clientColumns = [
    { title: 'Client', dataIndex: 'name',
      render: (v, r) => (
        <div style={{ minWidth: 140 }}>
          <div style={{ fontWeight: 600 }}>{v ?? '—'}</div>
          {r.organisation && <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>{r.organisation}</div>}
        </div>
      ) },
    { title: 'Orders', dataIndex: 'total_orders', align: 'right' },
    { title: 'Total spent', dataIndex: 'total_spent', align: 'right',
      render: (v) => <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt(v)}</span> },
  ]

  const productColumns = [
    { title: 'Product', dataIndex: 'product', render: (v) => <span style={{ fontWeight: 600 }}>{v}</span> },
    { title: 'Units sold', dataIndex: 'total_qty', align: 'right',
      render: (v) => (
        <div style={{ minWidth: 96 }}>
          <div style={{ fontWeight: 600 }}>{Number(v).toLocaleString('en-ZA')}</div>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--surface-3)', marginTop: 4 }} aria-hidden="true">
            <div style={{ width: `${Math.round(Number(v) / maxProductQty * 100)}%`, height: '100%', borderRadius: 2, background: 'var(--thread)', marginLeft: 'auto' }} />
          </div>
        </div>
      ) },
    { title: 'On orders', dataIndex: 'appearances', align: 'right',
      render: (v) => <span style={{ color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{v} {Number(v) === 1 ? 'order' : 'orders'}</span> },
  ]

  return (
    <div>
      <div className="braq-page-header">
        <div>
          <h1 className="braq-page-title">Revenue dashboard</h1>
          <div className="braq-page-subtitle">Money received, how many quotations turn into orders, and what clients buy most.</div>
        </div>
      </div>

      {revLoading ? (
        <section className="braq-panel" style={{ padding: 24, marginBottom: 20 }}><Skeleton active paragraph={{ rows: 4 }} /></section>
      ) : revError ? (
        // Not R 0: the numbers did not load.
        <section className="braq-panel" style={{ marginBottom: 20 }}>
          <ErrorState title="Could not load the revenue figures" error={revError} onRetry={refetchRev} />
        </section>
      ) : (
        <>
          {/* ── Headline figures ─────────────────────────────────────── */}
          <section
            aria-label="Revenue totals"
            className="braq-panel"
            style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, marginBottom: 20, overflow: 'hidden' }}
          >
            {headline.map((h, i) => (
              <div
                key={h.label}
                style={{
                  padding: '18px 20px',
                  display: 'flex', flexDirection: 'column', gap: 10,
                  borderRight: cols > 1 && i < headline.length - 1 ? '1px solid var(--line-2)' : 0,
                  borderBottom: cols === 1 && i < headline.length - 1 ? '1px solid var(--line-2)' : 0,
                  minWidth: 0,
                }}
              >
                <span style={{ ...CAPTION, fontWeight: 600 }}>{h.label}</span>
                <span style={FIGURE}>{h.value}</span>
                <span style={{ ...CAPTION, color: 'var(--ink-3)' }}>{h.note}</span>
              </div>
            ))}
          </section>

          {/* ── Monthly revenue + quotation conversion ───────────────── */}
          <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
            <Col xs={24} lg={16}>
              <Panel
                id="rev-monthly"
                title="Revenue by month"
                extra={<span style={CAPTION}>{fmt(yearTotal)} in the last 12 months</span>}
                bodyStyle={{ padding: '22px 18px 16px' }}
              >
                {byMonth.length === 0 ? (
                  <div style={{ padding: '36px 0', textAlign: 'center', color: 'var(--ink-2)' }}>
                    No payments in the last 12 months. Revenue shows here once a deposit or payment is recorded on an order.
                  </div>
                ) : (
                  <MonthlyChart byMonth={byMonth} compactAxis={!screens.sm} />
                )}
              </Panel>
            </Col>

            <Col xs={24} lg={8}>
              <Panel id="rev-conversion" title="Quotation conversion" bodyStyle={{ padding: '18px 18px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <span style={FIGURE}>{pct}%</span>
                  <span style={CAPTION}>of {conversion.total ?? 0} quotations accepted</span>
                </div>
                <div
                  role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Quotations accepted"
                  style={{ height: 6, borderRadius: 3, background: 'var(--surface-3)', margin: '14px 0 12px', overflow: 'hidden' }}
                >
                  <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: 'var(--thread)', borderRadius: 3 }} />
                </div>
                <div>
                  {convRows.map((r) => (
                    <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '7px 0', borderTop: '1px solid var(--line-2)' }}>
                      <span className={`braq-pill ${r.tone}`}>{r.label}</span>
                      <span style={{ fontWeight: 600 }}>{r.value ?? 0}</span>
                    </div>
                  ))}
                </div>
              </Panel>
            </Col>
          </Row>

          {/* ── Open orders by stage ─────────────────────────────────── */}
          <section className="braq-panel" aria-labelledby="rev-pipeline" style={{ marginBottom: 20 }}>
            <div className="braq-panel-head">
              <h2 id="rev-pipeline" className="braq-panel-title">Open orders by stage</h2>
              <span style={CAPTION}>{pipelineTotal} open {pipelineTotal === 1 ? 'order' : 'orders'}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {pipeline.map((s, i) => (
                <div
                  key={s.key}
                  style={{
                    padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10,
                    borderRight: cols > 1 && i < pipeline.length - 1 ? '1px solid var(--line-2)' : 0,
                    borderBottom: cols === 1 && i < pipeline.length - 1 ? '1px solid var(--line-2)' : 0,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <StatusPill kind="stage" value={s.key} />
                    <span style={{ fontSize: 24, fontStretch: '112%', fontWeight: 700, lineHeight: 1 }}>{s.count}</span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: 'var(--surface-3)' }} aria-hidden="true">
                    <div style={{ width: `${pipelineTotal ? Math.round(s.count / pipelineTotal * 100) : 0}%`, height: '100%', borderRadius: 2, background: 'var(--thread)' }} />
                  </div>
                  <span style={{ ...CAPTION, color: 'var(--ink-3)' }}>{s.description}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {/* ── Top clients / products ──────────────────────────────────── */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Panel id="rev-clients" title="Top clients by spend">
            {clientsError ? <ErrorState title="Could not load top clients" error={clientsError} onRetry={refetchClients} /> : <Table
              dataSource={topClients}
              columns={clientColumns}
              rowKey="id"
              loading={clientsLoading}
              size="small"
              pagination={false}
              scroll={{ x: 'max-content' }}
              locale={{ emptyText: 'No paying clients yet.' }}
            />}
          </Panel>
        </Col>
        <Col xs={24} lg={12}>
          <Panel id="rev-products" title="Best-selling products">
            {productsError ? <ErrorState title="Could not load best-selling products" error={productsError} onRetry={refetchProducts} /> : <Table
              dataSource={topProducts}
              columns={productColumns}
              rowKey="product"
              loading={productsLoading}
              size="small"
              pagination={false}
              scroll={{ x: 'max-content' }}
              locale={{ emptyText: 'No products on orders yet.' }}
            />}
          </Panel>
        </Col>
      </Row>
    </div>
  )
}

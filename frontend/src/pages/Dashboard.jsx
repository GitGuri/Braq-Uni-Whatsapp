import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { App, Button, Segmented, Skeleton } from 'antd'
import {
  InboxOutlined, FileTextOutlined, ToolOutlined, WarningOutlined, CustomerServiceOutlined,
  CheckCircleOutlined, RightOutlined, LikeOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { getKpis, listOrders } from '../api/orders.js'
import { getUnreadCount } from '../api/conversations.js'
import { listJobs, runActionEndpoint } from '../api/jobs.js'
import { claimTicket } from '../api/tickets.js'
import { actionError } from '../api/adapt.js'
import { useAuth } from '../auth/AuthContext.jsx'
import { errorMessage } from '../utils/errorMessage.js'
import { qk, useJobMutation } from '../lib/queryKeys.js'
import { useMeta } from '../lib/useMeta.js'
import { useUrlState } from '../lib/useUrlState.js'
import { fromNow, shortDate } from '../lib/format.js'
import Seam from '../components/Seam.jsx'
import { FlagPills } from '../components/StatusPill.jsx'
import ErrorState from '../components/ErrorState.jsx'
import { useStatus } from '../lib/status.js'

const ROWS_PER_QUEUE = 4

/** Counts up to `value` once, the first time real data arrives; later changes just update. */
function useCountUp(value, ready) {
  const [shown, setShown] = useState(0)
  const done = useRef(false)
  useEffect(() => {
    if (!ready) return undefined
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (done.current || reduced || value === 0) { done.current = true; setShown(value); return undefined }
    done.current = true
    const start = performance.now()
    let raf
    const step = (now) => {
      const t = Math.min(1, (now - start) / 700)
      setShown(Math.round(value * (1 - (1 - t) ** 3)))
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, ready])
  return shown
}

function BoardCell({ value, label, icon, urgent, to, ready }) {
  const shown = useCountUp(value, ready)
  return (
    <Link to={to} className={`braq-board-cell${urgent ? ' urgent' : ''}`}>
      {icon}
      <span className="braq-board-num">{ready ? shown : '–'}</span>
      <span className="braq-board-label">{label}</span>
    </Link>
  )
}

/** One job in a queue: who, which job, and — when it takes one click — the next step as a button. */
function JobRow({ job, onRun, running }) {
  const action = job.primary_action
  const when = job.due_date ? `Due ${shortDate(job.due_date)}`
    : job.queue === 'follow_up' && job.sent_at ? `Sent ${fromNow(job.sent_at)}`
      : `Updated ${fromNow(job.updated_at)}`
  return (
    <div className="braq-queue-row braq-queue-job">
      <Link to={`/jobs/${job.quotation_id}`} state={{ from: '/' }} className="braq-queue-job-link">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.client_name ?? '—'}</div>
          <div className="braq-small" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 2 }}>
            <span className="braq-ref" style={{ fontWeight: 500, color: 'var(--ink-2)' }}>{job.order_reference ?? job.quotation_reference}</span>
            {job.account_terms && <span className="braq-pill blue sm">Account</span>}
            <FlagPills flags={job.flags} size="sm" exclude={['UNASSIGNED', 'BALANCE_DUE']} />
            <span>{when}</span>
            <span aria-hidden="true">·</span>
            <span>{job.owner_name ?? 'Unassigned'}</span>
          </div>
        </div>
        {!action && <RightOutlined aria-hidden="true" className="braq-row-chevron" />}
      </Link>
      {action && (
        <Button size="small" loading={running} onClick={() => onRun(job)} aria-label={`${action.label}: ${job.client_name ?? ''}`}>
          {action.label}
        </Button>
      )}
    </div>
  )
}

function Queue({ queue, rows, count, loading, link, onRun, runningId }) {
  const titleId = `queue-${queue.key}`
  return (
    <section className={`braq-panel braq-queue${rows.length === 0 ? ' empty' : ''}`} aria-labelledby={titleId}>
      <div className="braq-panel-head">
        <div style={{ minWidth: 0 }}>
          <h3 id={titleId} className="braq-panel-title">{queue.label}</h3>
          <div className="braq-small">{queue.hint}</div>
        </div>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
          {count > 0 && <span className={`braq-pill ${queue.key === 'accepted' ? 'green' : ''}`}>{count}</span>}
          <Link to={link} className="braq-link" style={{ fontSize: 13 }} aria-label={`All: ${queue.label}`}>All</Link>
        </span>
      </div>
      {loading ? (
        <div style={{ padding: 18 }}><Skeleton active title={false} paragraph={{ rows: 2 }} /></div>
      ) : rows.length === 0 ? (
        <div className="braq-queue-empty"><CheckCircleOutlined aria-hidden="true" /> Nothing here</div>
      ) : (
        <div>
          {rows.slice(0, ROWS_PER_QUEUE).map((j) => <JobRow key={j.quotation_id} job={j} onRun={onRun} running={runningId === j.quotation_id} />)}
          {count > ROWS_PER_QUEUE && (
            <Link to={link} className="braq-queue-more">{count - ROWS_PER_QUEUE} more</Link>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * The dashboard: today's numbers, then the work queue — every active job once,
 * in its most urgent queue (from GET /api/jobs `queue`). Rows whose next step
 * takes one click carry it as a button. Mine / everyone (consultants start on Mine).
 */
export default function Dashboard() {
  const navigate = useNavigate()
  const { staff } = useAuth()
  const { message } = App.useApp()
  const status = useStatus()
  const meta = useMeta()
  const [f, set] = useUrlState({ who: '' })
  const who = f.who || (staff?.role === 'consultant' ? 'mine' : 'all')
  const mine = who === 'mine'
  const ownerQs = mine ? '&owner=me' : ''
  const queues = meta.jobQueues ?? []

  const { data: kpiData, isLoading: kpiLoading } = useQuery({ queryKey: qk.kpis, queryFn: getKpis, refetchInterval: 30_000 })
  const { data: unreadData } = useQuery({ queryKey: qk.unread, queryFn: getUnreadCount, refetchInterval: 30_000 })
  const jobsParams = { queue: queues.map((q) => q.key).join(','), limit: 200, ...(mine ? { owner: 'me' } : {}) }
  const { data: jobsData, isLoading: jobsLoading, error: jobsError, refetch: refetchJobs } = useQuery({
    queryKey: qk.jobs({ ...jobsParams, dashboard: true }),
    queryFn: () => listJobs(jobsParams),
    refetchInterval: 60_000,
    enabled: queues.length > 0,
  })
  const { data: floorData, isLoading: floorLoading } = useQuery({
    queryKey: qk.orders({ active: true, dashboard: true }),
    queryFn: () => listOrders({ active: 'true', limit: 6 }),
    refetchInterval: 60_000,
  })

  const claimT = useJobMutation({
    mutationFn: claimTicket,
    onSuccess: () => message.success('Ticket claimed'),
    onError: (err) => message.error(errorMessage(err, 'Could not claim this ticket')),
  })
  // One-click next step from a queue row (the API says which steps need no input).
  const runRow = useJobMutation({ mutationFn: (job) => runActionEndpoint(job.primary_action.endpoint) })
  const onRun = (job) => runRow.mutate(job, {
    onSuccess: (res) => {
      const ref = res?.order?.reference
      message.success(`${job.primary_action.label} — done${ref ? ` (order ${ref})` : ''}`)
    },
    onError: (err) => {
      const e = actionError(err)
      message.error(e.message)
      if (e.status === 409) navigate(`/jobs/${job.quotation_id}`, { state: { from: '/' } })
    },
  })

  const kpis = kpiData?.kpis ?? {}
  const tickets = (kpiData?.attention ?? []).filter((item) => item.type === 'ticket')
  const jobs = jobsData?.items ?? []
  const counts = jobsData?.counts ?? {}
  const queueCounts = jobsData?.queueCounts ?? {}
  const flagCounts = jobsData?.flagCounts ?? {}
  const floor = floorData?.items ?? []
  const ready = !kpiLoading && !jobsLoading

  const waiting = Number(unreadData?.waiting ?? 0)
  const overdue = Number(flagCounts.OVERDUE ?? 0)

  const hour = dayjs().hour()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const firstName = staff?.name?.split(' ')[0] ?? 'there'

  // Board numbers are the board's own counts (same filters), so a cell and the page it opens agree.
  const cells = [
    { label: 'Waiting for a reply', value: waiting,                         icon: <InboxOutlined />,           urgent: waiting > 0, to: '/inbox?view=waiting' },
    { label: 'Client accepted',     value: Number(counts.ACCEPTED ?? 0),     icon: <LikeOutlined />,            urgent: Number(counts.ACCEPTED ?? 0) > 0, to: `/jobs?state=ACCEPTED${ownerQs}` },
    { label: 'Needs pricing',       value: Number(counts.PRICING ?? 0),      icon: <FileTextOutlined />,        to: `/jobs?state=PRICING${ownerQs}` },
    { label: 'In production',       value: Number(counts.IN_PRODUCTION ?? 0), icon: <ToolOutlined />,           to: `/jobs?state=IN_PRODUCTION${ownerQs}` },
    { label: 'Overdue',             value: overdue,                          icon: <WarningOutlined />,         urgent: overdue > 0, to: `/jobs?overdue=true${ownerQs}` },
    { label: 'Open tickets',        value: Number(kpis.open_tickets ?? 0),   icon: <CustomerServiceOutlined />, to: '/tickets' },
  ]

  return (
    <div>
      <div className="braq-page-header" style={{ marginBottom: 24 }}>
        <div>
          <h1 className="braq-page-title" style={{ fontSize: 30 }}>{greeting}, {firstName}</h1>
          <div className="braq-page-subtitle">{dayjs().format('dddd D MMMM YYYY')}</div>
        </div>
        <div className="braq-page-actions">
          <Segmented
            value={who}
            onChange={(v) => set({ who: v })}
            options={[{ value: 'mine', label: 'Mine' }, { value: 'all', label: 'Everyone' }]}
            aria-label="Whose work to show"
          />
          <Button onClick={() => navigate('/jobs')}>All jobs</Button>
        </div>
      </div>

      <section aria-label="Today at a glance" className="braq-board" style={{ marginBottom: 28 }}>
        {cells.map((c) => <BoardCell key={c.label} {...c} ready={ready} />)}
      </section>

      <h2 className="braq-section-title" id="work-queue-title">{mine ? 'My work' : 'Work queue'}</h2>
      {jobsError ? (
        <section className="braq-panel" style={{ marginBottom: 28 }}><ErrorState title="Could not load the work queue" error={jobsError} onRetry={refetchJobs} /></section>
      ) : (
        <div className="braq-queue-grid" aria-labelledby="work-queue-title" role="region">
          {queues.map((q) => (
            <Queue
              key={q.key}
              queue={q}
              rows={jobs.filter((j) => j.queue === q.key)}
              count={Number(queueCounts[q.key] ?? 0)}
              loading={jobsLoading}
              link={`/jobs?queue=${q.key}${ownerQs}`}
              onRun={onRun}
              runningId={runRow.isPending ? runRow.variables?.quotation_id : null}
            />
          ))}
          <section className="braq-panel braq-queue" aria-labelledby="queue-tickets">
            <div className="braq-panel-head">
              <div>
                <h3 id="queue-tickets" className="braq-panel-title">Tickets waiting</h3>
                <div className="braq-small">After-sales problems to answer</div>
              </div>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                {tickets.length > 0 && <span className="braq-pill">{tickets.length}</span>}
                <Link to="/tickets" className="braq-link" style={{ fontSize: 13 }} aria-label="All tickets">All</Link>
              </span>
            </div>
            {kpiLoading ? <div style={{ padding: 18 }}><Skeleton active title={false} paragraph={{ rows: 2 }} /></div>
              : tickets.length === 0 ? <div className="braq-queue-empty"><CheckCircleOutlined aria-hidden="true" /> Nothing here</div>
                : tickets.slice(0, ROWS_PER_QUEUE).map((item) => {
                  const when = item.deadline ? (item.is_overdue ? `Overdue ${fromNow(item.deadline)}` : `Due ${fromNow(item.deadline)}`) : ''
                  return (
                    <div key={item.id} className="braq-queue-row">
                      <Link to={`/tickets/${item.id}`} style={{ flex: 1, minWidth: 0, color: 'inherit' }}>
                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.client_name ?? 'Client'}</div>
                        {when && <div className="braq-small" style={{ color: item.is_overdue ? 'var(--thread)' : undefined, fontWeight: item.is_overdue ? 600 : 400 }}>{when}</div>}
                      </Link>
                      {item.assigned_staff_id ? (
                        <span className="braq-small" style={{ whiteSpace: 'nowrap' }}>{item.assigned_name}</span>
                      ) : (
                        <Button size="small" loading={claimT.isPending && claimT.variables === item.id} onClick={() => claimT.mutate(item.id)}>Claim</Button>
                      )}
                    </div>
                  )
                })}
          </section>
        </div>
      )}

      {/* ── Production floor ── */}
      <section className="braq-panel" aria-labelledby="floor-title" style={{ marginTop: 28 }}>
        <div className="braq-panel-head">
          <h2 id="floor-title" className="braq-panel-title">On the production floor</h2>
          <Link to="/jobs?state=IN_PRODUCTION" className="braq-link" style={{ fontSize: 13 }}>All in production</Link>
        </div>
        {floorLoading ? (
          <div style={{ padding: 18 }}><Skeleton active paragraph={{ rows: 3 }} title={false} /></div>
        ) : floor.length === 0 ? (
          <div style={{ padding: '36px 24px', textAlign: 'center', color: 'var(--ink-2)' }}>
            No open orders. Orders appear here once a quote is accepted and the order is created.
          </div>
        ) : (
          floor.map((o) => (
            <Link key={o.id} to={o.quotation_id ? `/jobs/${o.quotation_id}` : `/orders/${o.id}`} state={{ from: '/' }} className="braq-queue-row" style={{ flexWrap: 'wrap', rowGap: 10 }}>
              <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                <div className="braq-ref">{o.reference}</div>
                <div className="braq-small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.client_name ?? '—'}</div>
              </div>
              <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                <Seam stage={o.stage} size="sm" held={o.is_on_hold} />
                <span style={{ fontSize: 12, color: o.is_on_hold ? 'var(--warn)' : 'var(--ink-2)', fontWeight: o.is_on_hold ? 600 : 400 }}>
                  {o.is_on_hold ? 'On hold' : (o.lifecycle_state ? status.label('job', o.lifecycle_state) : status.label('stage', o.stage))}
                  {o.estimated_completion_date && !o.is_on_hold ? ` · due ${shortDate(o.estimated_completion_date)}` : ''}
                </span>
              </div>
            </Link>
          ))
        )}
      </section>
    </div>
  )
}

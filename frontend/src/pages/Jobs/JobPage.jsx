import { useParams, useNavigate, useLocation, Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { App, Button, Select, Skeleton, Tabs, Tooltip } from 'antd'
import { CopyOutlined, FilePdfOutlined, UserAddOutlined } from '@ant-design/icons'
import { listStaff } from '../../api/staff.js'
import { qk } from '../../lib/queryKeys.js'
import { useStatus } from '../../lib/status.js'
import { fromNow, money, date } from '../../lib/format.js'
import { errorMessage } from '../../utils/errorMessage.js'
import DetailHeader from '../../components/DetailHeader.jsx'
import StatusPill, { FlagPills } from '../../components/StatusPill.jsx'
import JourneyBar from '../../components/JourneyBar.jsx'
import NextStepCard from '../../components/NextStepCard.jsx'
import ErrorState from '../../components/ErrorState.jsx'
import ClientPanel from '../../components/ClientPanel.jsx'
import QuotePanel, { useQuoteDraft, QuoteDraftSummary, useQuotePdf } from './QuotePanel.jsx'
import OrderPanel, { orderMoney } from './OrderPanel.jsx'
import ConversationPanel from './ConversationPanel.jsx'
import TicketsPanel from './TicketsPanel.jsx'
import HistoryPanel from './HistoryPanel.jsx'
import { useJob, useJobActions, useOwnerActions } from './useJobActions.js'

const TABS = ['quote', 'order', 'tickets', 'history']

/** Owner: assignable once there is an order; before that, claim the quote. */
function OwnerControl({ job }) {
  const { message } = App.useApp()
  const { assign, claim } = useOwnerActions(job)
  const { data } = useQuery({ queryKey: qk.staff, queryFn: listStaff, enabled: !!job.order })
  const ownerName = job.order?.staff_name ?? job.quotation.assigned_name
  if (job.order) {
    return (
      <Select
        size="small"
        aria-label="Job owner"
        placeholder="Assign an owner"
        value={job.order.assigned_staff_id ?? undefined}
        options={(data?.staff ?? []).map((s) => ({ value: s.id, label: s.name }))}
        onChange={(v) => assign.mutate(v, {
          onSuccess: () => message.success('Owner changed'),
          onError: (err) => message.error(errorMessage(err, 'The owner was not changed')),
        })}
        loading={assign.isPending}
        style={{ minWidth: 160 }}
        popupMatchSelectWidth={false}
      />
    )
  }
  if (ownerName) return <span>Owner: <strong>{ownerName}</strong></span>
  return (
    <Button
      size="small"
      icon={<UserAddOutlined />}
      loading={claim.isPending}
      onClick={() => claim.mutate(undefined, {
        onSuccess: () => message.success('This job is now yours'),
        onError: (err) => message.error(errorMessage(err, 'Could not claim this job')),
      })}
    >
      Assign to me
    </Button>
  )
}

/**
 * The job page — one place to work a customer's job from pricing to after-sales.
 * Header (refs, client, owner, state, flags) → journey bar → Next step → tabs.
 * After every action the page stays here and shows the new next step.
 */
export default function JobPage() {
  const { quotationId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const { message } = App.useApp()
  const status = useStatus()
  const { data: job, isLoading, error, refetch } = useJob(quotationId)
  const draft = useQuoteDraft(job?.quotation)
  const { run: runAction, pendingKey } = useJobActions(job)
  const pdf = useQuotePdf()
  // Sending the quote: save any edit still waiting for autosave first.
  const run = async (action, values, ctx) => {
    if (action.key === 'price_quote' || action.key === 'send_quote') await draft.flush()
    return runAction(action, values, ctx)
  }

  if (isLoading) {
    return <div style={{ display: 'grid', gap: 16 }}><Skeleton active paragraph={{ rows: 2 }} /><Skeleton.Node active style={{ width: '100%', height: 80 }} /><Skeleton active paragraph={{ rows: 6 }} /></div>
  }
  if (error || !job?.quotation) {
    return (
      <>
        <DetailHeader back={{ to: '/jobs', label: 'Jobs' }} title="Job" />
        <section className="braq-panel"><ErrorState title="Could not load this job" error={error} onRetry={refetch} action={<Button onClick={() => navigate('/jobs')}>Back to jobs</Button>} /></section>
      </>
    )
  }

  const { quotation: q, order, lifecycle } = job
  const state = lifecycle.state
  const editable = state === 'PRICING'
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : (order ? 'order' : 'quote')
  const setTab = (t) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', t); return n }, { replace: true })
  const back = location.state?.from ?? '/jobs'
  const m = order ? orderMoney(order, job.payments, q) : null

  const copyRef = () => navigator.clipboard?.writeText(order?.reference ?? q.reference)
    .then(() => message.success('Reference copied')).catch(() => {})

  // Extra context under the Next step heading (facts, not rules).
  const context = {
    QUOTED: `Quote sent ${fromNow(q.approved_at) || ''} — waiting for the client to accept${q.valid_until ? ` (valid until ${date(q.valid_until)})` : ''}.`,
    AWAITING_PROOF: order?.proof_sent_at ? `Proof sent ${fromNow(order.proof_sent_at)} — waiting for the client to approve it.` : undefined,
    AWAITING_DEPOSIT: m?.depositDue != null ? `Deposit due: ${money(m.depositDue)} of ${money(m.total)}.` : undefined,
    READY: m && m.outstanding > 0
      ? `${money(m.outstanding)} still to pay — enter what the client pays when they ${order?.delivery_type === 'delivery' ? 'receive the order' : 'collect'}.`
      : undefined,
    READY_TO_PRODUCE: job.client?.account_terms && order?.payment_status === 'unpaid'
      ? 'Account client — no deposit needed before production.' : undefined,
  }
  const account = job.client?.account_terms === true

  const header = (
    <DetailHeader
      back={{ to: back, label: back.startsWith('/jobs') ? 'Jobs' : 'Back' }}
      title={order?.reference ?? q.reference}
      titleExtra={(
        <Tooltip title="Copy reference">
          <Button type="text" size="small" icon={<CopyOutlined />} onClick={copyRef} aria-label="Copy reference" />
        </Tooltip>
      )}
      meta={(
        <>
          {order && <span className="braq-ref" style={{ color: 'var(--ink-2)' }}>{q.reference}</span>}
          <Link to={`/clients/${q.client_id}`} className="braq-link">{q.client_name ?? 'Client'}{q.client_org ? `, ${q.client_org}` : ''}</Link>
          {account && <span className="braq-pill blue" title="Account client — no deposit needed before production">Account</span>}
          <StatusPill kind="job" value={state} label={lifecycle.label ?? undefined} />
          <FlagPills flags={lifecycle.flags} />
          <OwnerControl job={job} />
        </>
      )}
      actions={(
        <Button
          icon={<FilePdfOutlined />}
          loading={pdf.loading}
          disabled={editable && draft.items.length === 0}
          onClick={() => pdf.open(q.id, { before: editable ? draft.flush : undefined })}
        >
          {editable ? 'Preview PDF' : 'Quote PDF'}
        </Button>
      )}
    />
  )

  const tabItems = [
    { key: 'quote', label: editable ? 'Quote (pricing)' : 'Quote', children: <QuotePanel quotation={q} draft={draft} editable={editable} /> },
    { key: 'order', label: order ? 'Order' : 'Order (not yet)', children: <OrderPanel job={job} run={run} pendingKey={pendingKey} /> },
    { key: 'tickets', label: `Tickets${job.tickets.length ? ` (${job.tickets.length})` : ''}`, children: <TicketsPanel tickets={job.tickets} hasOrder={!!order} /> },
    { key: 'history', label: 'History', children: <HistoryPanel history={job.history} /> },
  ]

  return (
    <div className="braq-job">
      {header}

      <section className="braq-panel braq-journey-panel" aria-label="Job progress">
        <JourneyBar state={state} flags={lifecycle.flags} />
      </section>

      <div className="braq-job-grid">
        <div className="braq-job-main">
          <NextStepCard
            lifecycle={lifecycle}
            context={context}
            run={run}
            pendingKey={pendingKey}
            specialPayload={draft.payload}
            specialBlocker={draft.blocker}
            renderSpecial={() => <QuoteDraftSummary draft={draft} onEdit={tab !== 'quote' ? () => setTab('quote') : undefined} />}
          />
          <Tabs activeKey={tab} onChange={setTab} items={tabItems} className="braq-job-tabs" />
        </div>
        <aside className="braq-job-side" aria-label="Client and conversation">
          <ConversationPanel conversation={job.conversation} />
          <ClientPanel clientId={q.client_id} conversationId={job.conversation?.id} />
          <p className="braq-small" style={{ margin: 0 }}>
            {status.label('job', state)} · updated {fromNow(order?.updated_at ?? q.updated_at)}
          </p>
        </aside>
      </div>
    </div>
  )
}

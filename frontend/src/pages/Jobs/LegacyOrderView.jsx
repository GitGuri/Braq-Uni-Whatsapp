import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Alert, Skeleton } from 'antd'
import { getOrder } from '../../api/orders.js'
import { qk } from '../../lib/queryKeys.js'
import DetailHeader from '../../components/DetailHeader.jsx'
import StatusPill, { FlagPills } from '../../components/StatusPill.jsx'
import JourneyBar from '../../components/JourneyBar.jsx'
import NextStepCard from '../../components/NextStepCard.jsx'
import ErrorState from '../../components/ErrorState.jsx'
import OrderPanel from './OrderPanel.jsx'
import HistoryPanel from './HistoryPanel.jsx'
import { useJobActions } from './useJobActions.js'

/** GET /orders/:id as the job shape the panels expect (no quotation). */
function toJob(data) {
  const order = data.order
  const payments = data.payments ?? []
  const history = [
    ...(data.history ?? []).map((h, i) => ({
      at: h.created_at,
      type: h.override_reason ? 'stage.overridden' : i === 0 && !h.from_stage ? 'order.created' : 'stage.changed',
      actor_name: h.changed_by_name ?? null,
      data: { stage: h.stage, notes: h.notes, reference: order.reference, override: h.override_reason ? { reason: h.override_reason, guards: h.overridden_guards ?? [] } : undefined },
    })),
    ...payments.map((p) => ({ at: p.created_at, type: 'payment.recorded', actor_name: null, data: { type: p.type, amount: p.amount, currency: p.currency, notes: p.notes } })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at))
  return {
    quotation: null, order, payments, sizes: [], purchaseOrders: [], tickets: [], conversation: null, client: null, history,
    lifecycle: data.lifecycle,
  }
}

/**
 * An order created before every order came from a quote (no job page): the
 * same order panel and next step, without the quote.
 */
export default function LegacyOrderView({ orderId }) {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: qk.order(orderId), queryFn: () => getOrder(orderId) })
  const job = data?.order ? toJob(data) : null
  const { run, pendingKey } = useJobActions(job)

  if (isLoading) return <Skeleton active paragraph={{ rows: 8 }} />
  if (error || !job) {
    return (
      <>
        <DetailHeader back={{ to: '/orders', label: 'Orders' }} title="Order" />
        <section className="braq-panel"><ErrorState title="Could not load this order" error={error} onRetry={refetch} /></section>
      </>
    )
  }
  const { order, lifecycle } = job

  return (
    <div className="braq-job">
      <DetailHeader
        back={{ to: '/orders', label: 'Orders' }}
        title={order.reference}
        meta={(
          <>
            <Link to={`/clients/${order.client_id}`} className="braq-link">{order.client_name ?? 'Client'}{order.organisation ? `, ${order.organisation}` : ''}</Link>
            {lifecycle.state && <StatusPill kind="job" value={lifecycle.state} label={lifecycle.label ?? undefined} />}
            <FlagPills flags={lifecycle.flags} />
            {order.staff_name && <span>Owner: <strong>{order.staff_name}</strong></span>}
          </>
        )}
      />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="This order was created before quotes and orders were linked, so it has no quote."
      />
      {lifecycle.state && (
        <section className="braq-panel braq-journey-panel" aria-label="Order progress">
          <JourneyBar state={lifecycle.state} flags={lifecycle.flags} />
        </section>
      )}
      <div className="braq-job-main">
        <NextStepCard lifecycle={lifecycle} run={run} pendingKey={pendingKey} />
        <OrderPanel job={job} run={run} pendingKey={pendingKey} />
        <HistoryPanel history={job.history} />
      </div>
    </div>
  )
}

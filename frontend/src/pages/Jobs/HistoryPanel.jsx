import { useState } from 'react'
import { Segmented } from 'antd'
import { useStatus } from '../../lib/status.js'
import { money, dateTime, sentence } from '../../lib/format.js'
import EmptyState from '../../components/EmptyState.jsx'

const PAYMENT_TYPE = { deposit: 'Deposit', balance: 'Balance payment', full: 'Full payment' }

/** One history entry as { title, detail?, tone? } — tone: 'warn' for overrides, 'msg' for chat. */
function describe(e, status) {
  const d = e.data ?? {}
  switch (e.type) {
    case 'quotation.created': return { title: `Quote ${d.reference ?? ''} started${d.auto_quoted ? ' by the WhatsApp assistant' : ''}` }
    case 'quotation.sent': return { title: `Quote sent to the client${d.total != null ? ` — ${money(d.total)}` : ''}` }
    case 'quotation.resent': return { title: 'Quote PDF sent again' }
    case 'quotation.accepted': return { title: 'Quote accepted', detail: d.source === 'bot' ? 'The client accepted on WhatsApp' : null }
    case 'quotation.declined': return { title: 'Quote declined' }
    case 'quotation.revised': return { title: 'Quote reopened for pricing' }
    case 'quotation.expired': return { title: 'Quote expired' }
    case 'order.created': return { title: `Order ${d.reference ?? ''} created`, detail: d.notes }
    case 'stage.changed': return { title: `Moved to ${status.label('stage', d.stage).toLowerCase()}`, detail: d.notes }
    case 'stage.overridden': return {
      title: `Moved to ${status.label('stage', d.stage).toLowerCase()} by override`,
      detail: [d.override?.reason && `Reason: ${d.override.reason}`, d.override?.guards?.length && `Skipped: ${d.override.guards.map(sentence).join(', ')}`, d.notes].filter(Boolean).join(' · '),
      tone: 'warn',
    }
    case 'payment.recorded': return { title: `${PAYMENT_TYPE[d.type] ?? sentence(d.type)} of ${money(d.amount, { currency: d.currency })} recorded`, detail: d.notes }
    case 'proof.sent': return { title: 'Design proof sent', detail: d.notes }
    case 'proof.approved': return { title: 'Proof approved', detail: d.notes }
    case 'proof.revision_requested': return { title: 'Client asked for proof changes', detail: d.notes }
    case 'po.recorded': return { title: `Purchase order ${d.poNumber ?? d.po_number ?? ''} recorded`.trim() }
    case 'ticket.opened': return { title: `Ticket opened — ${status.label('category', d.category)}`, detail: d.description }
    case 'ticket.resolved': return { title: 'Ticket resolved', detail: d.note ?? d.resolutionNote ?? d.resolution_note }
    case 'message': return { title: d.direction === 'outbound' ? 'Braq' : 'Client', detail: d.body || '(attachment)', tone: 'msg' }
    default: return { title: sentence(String(e.type).replace(/\./g, ' ')) }
  }
}

/**
 * One timeline of everything that happened on the job (quote, order, payments,
 * proof, overrides, tickets, WhatsApp messages), newest at the bottom.
 */
export default function HistoryPanel({ history = [] }) {
  const status = useStatus()
  const [view, setView] = useState('activity')
  const shown = history.filter((e) => view === 'all' || (view === 'messages' ? e.type === 'message' : e.type !== 'message'))

  return (
    <section className="braq-panel" aria-labelledby="job-history">
      <div className="braq-panel-head" style={{ flexWrap: 'wrap' }}>
        <h2 id="job-history" className="braq-panel-title">History</h2>
        <Segmented
          size="small"
          value={view}
          onChange={setView}
          options={[{ value: 'activity', label: 'Activity' }, { value: 'messages', label: 'Messages' }, { value: 'all', label: 'All' }]}
          aria-label="Which history to show"
        />
      </div>
      <div className="braq-panel-body">
        {shown.length === 0 ? (
          <EmptyState compact>{view === 'messages' ? 'No WhatsApp messages since this quote was started.' : 'Nothing has happened yet.'}</EmptyState>
        ) : (
          <ol className="braq-timeline" aria-label="Job history, oldest first">
            {shown.map((e, i) => {
              const d = describe(e, status)
              return (
                <li key={`${e.type}-${e.at}-${i}`} className={`braq-timeline-item${d.tone ? ` ${d.tone}` : ''}${i === shown.length - 1 ? ' latest' : ''}`}>
                  <div className="braq-timeline-title">{d.title}</div>
                  {d.detail && <div className="braq-timeline-detail">{d.detail}</div>}
                  <div className="braq-small">
                    <time dateTime={e.at}>{dateTime(e.at)}</time>{e.actor_name ? ` · ${e.actor_name}` : ''}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </section>
  )
}

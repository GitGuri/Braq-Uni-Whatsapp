import { useState } from 'react'
import { Link } from 'react-router-dom'
import { App, Alert, Button, Input, Modal } from 'antd'
import { CheckOutlined } from '@ant-design/icons'
import { updateTicket } from '../../api/tickets.js'
import { actionError } from '../../api/adapt.js'
import { useJobMutation } from '../../lib/queryKeys.js'
import StatusPill from '../../components/StatusPill.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { useStatus } from '../../lib/status.js'
import { date, ticketNo } from '../../lib/format.js'

const OPEN = ['open', 'in_progress']

/**
 * Resolve a ticket with an optional note — the client is told on WhatsApp.
 *   const resolve = useResolveTicket(); resolve.start(ticket) … {resolve.modal}
 */
export function useResolveTicket() {
  const { message } = App.useApp()
  const [ticket, setTicket] = useState(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)
  const mutation = useJobMutation({ mutationFn: ({ id, resolutionNote }) => updateTicket(id, { status: 'resolved', ...(resolutionNote ? { resolutionNote } : {}) }) })
  const start = (t) => { setTicket(t); setNote(t?.resolution_note ?? ''); setError(null) }
  const submit = async () => {
    setError(null)
    try {
      await mutation.mutateAsync({ id: ticket.id, resolutionNote: note.trim() || undefined })
      message.success('Ticket resolved — the client is notified on WhatsApp')
      setTicket(null)
    } catch (err) { setError(actionError(err, 'The ticket was not resolved')) }
  }
  const modal = (
    <Modal
      title="Resolve ticket"
      open={!!ticket}
      onCancel={() => setTicket(null)}
      onOk={submit}
      okText="Resolve and notify client"
      okButtonProps={{ loading: mutation.isPending }}
      destroyOnHidden
    >
      <label htmlFor="resolution-note" style={{ display: 'block', margin: '12px 0 6px', fontWeight: 600 }}>How was it resolved? (optional)</label>
      <Input.TextArea
        id="resolution-note"
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. Replacement shirts collected from the store on Friday"
      />
      <div className="braq-small" style={{ marginTop: 6 }}>Kept on the ticket and shown on the job.</div>
      {error && <Alert type="error" showIcon style={{ marginTop: 12 }} message={error.message} />}
    </Modal>
  )
  return { start, modal, pending: mutation.isPending }
}

/**
 * After-sales tickets linked to the job's order, each open one with "Resolve".
 * Opening a ticket is a next action (Next step card).
 */
export default function TicketsPanel({ tickets = [], hasOrder }) {
  const status = useStatus()
  const resolve = useResolveTicket()
  if (!tickets.length) {
    return (
      <section className="braq-panel">
        <EmptyState title="No tickets">
          {hasOrder
            ? 'Complaints or problems the client reports about this order show up here. Open one from the Next step card once the order is complete.'
            : 'Tickets are linked to the order, which hasn’t been created yet.'}
        </EmptyState>
      </section>
    )
  }
  return (
    <section className="braq-panel" aria-label="Tickets">
      <ul className="braq-list flush">
        {tickets.map((t) => (
          <li key={t.id} className="braq-ticket-row">
            <Link to={`/tickets/${t.id}`} className="braq-row-link">
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="braq-ref">#{ticketNo(t.id)}</span>
                  <StatusPill kind="ticket" value={t.status} />
                  <span className="braq-pill">{status.label('category', t.category)}</span>
                </span>
                {t.description && <span className="braq-row-sub">{t.description}</span>}
                {t.resolution_note && <span className="braq-row-sub">Resolution: {t.resolution_note}</span>}
              </span>
              <span className="braq-small" style={{ whiteSpace: 'nowrap' }}>{date(t.created_at)}</span>
            </Link>
            {OPEN.includes(t.status) && (
              <Button size="small" icon={<CheckOutlined />} onClick={() => resolve.start(t)} aria-label={`Resolve ticket #${ticketNo(t.id)}`}>
                Resolve
              </Button>
            )}
          </li>
        ))}
      </ul>
      {resolve.modal}
    </section>
  )
}

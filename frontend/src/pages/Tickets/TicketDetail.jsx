import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  App, Card, Descriptions, Button, Select, Spin, Row, Col, Modal, Input, Alert,
} from 'antd'
import { WarningOutlined, MessageOutlined, ProjectOutlined, UserOutlined, CheckOutlined } from '@ant-design/icons'
import { getTicket, updateTicket } from '../../api/tickets.js'
import { listStaff, assignableStaff } from '../../api/staff.js'
import { actionError } from '../../api/adapt.js'
import { qk, useJobMutation } from '../../lib/queryKeys.js'
import { useStatus } from '../../lib/status.js'
import { dateTime, ticketNo } from '../../lib/format.js'
import DetailHeader from '../../components/DetailHeader.jsx'
import StatusPill from '../../components/StatusPill.jsx'
import ErrorState from '../../components/ErrorState.jsx'

const STATUS_OPTIONS = [
  { value: 'open',        label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved',    label: 'Resolved' },
  { value: 'closed',      label: 'Closed' },
]

export default function TicketDetail() {
  const { id } = useParams()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const status = useStatus()
  const [resolveOpen, setResolveOpen] = useState(false)
  const [note, setNote] = useState('')
  const [resolveError, setResolveError] = useState(null)

  const { data, isLoading, error, refetch } = useQuery({ queryKey: qk.ticket(id), queryFn: () => getTicket(id) })
  const { data: staffData } = useQuery({ queryKey: qk.staff, queryFn: listStaff })

  const updateMutation = useJobMutation({
    mutationFn: (values) => updateTicket(id, values),
  })
  const update = (values, success = 'Ticket updated') => updateMutation.mutateAsync(values)
    .then(() => { message.success(success); return true })
    .catch((err) => { message.error(actionError(err, 'The ticket was not updated').message); return false })

  if (isLoading) return <Spin size="large" style={{ display: 'block', marginTop: 80 }} />
  if (error) {
    return (
      <>
        <DetailHeader back={{ to: '/tickets', label: 'Tickets' }} title="Ticket" />
        <section className="braq-panel"><ErrorState title="Could not load this ticket" error={error} onRetry={refetch} /></section>
      </>
    )
  }

  const { ticket } = data
  const staffList = staffData?.staff ?? []
  const isOverdue = ticket.is_overdue
  const jobLink = ticket.quotation_id ? `/jobs/${ticket.quotation_id}` : ticket.order_id ? `/orders/${ticket.order_id}` : null
  const isOpen = ['open', 'in_progress'].includes(ticket.status)

  const onStatus = (v) => {
    if (v === 'resolved') { setNote(ticket.resolution_note ?? ''); setResolveError(null); setResolveOpen(true); return }
    update({ status: v })
  }
  const resolve = async () => {
    setResolveError(null)
    try {
      await updateMutation.mutateAsync({ status: 'resolved', ...(note.trim() ? { resolutionNote: note.trim() } : {}) })
      message.success('Ticket resolved — the client is notified on WhatsApp')
      setResolveOpen(false)
    } catch (err) { setResolveError(actionError(err, 'The ticket was not resolved')) }
  }

  return (
    <div>
      <DetailHeader
        back={{ to: '/tickets', label: 'Tickets' }}
        title={`Ticket #${ticketNo(ticket.id)} — ${status.label('category', ticket.category)}`}
        meta={(
          <>
            <StatusPill kind="ticket" value={ticket.status} />
            {ticket.client_name && <span>{ticket.client_name}</span>}
            {ticket.order_reference && <span className="braq-ref" style={{ color: 'var(--ink-2)' }}>{ticket.order_reference}</span>}
            {isOverdue && <span className="braq-pill red"><WarningOutlined aria-hidden="true" /> Overdue</span>}
          </>
        )}
        actions={(
          <>
            {isOpen && <Button type="primary" icon={<CheckOutlined />} onClick={() => onStatus('resolved')}>Resolve</Button>}
            {jobLink && <Button icon={<ProjectOutlined />} onClick={() => navigate(jobLink)}>Open job</Button>}
            {ticket.conversation_id && <Button icon={<MessageOutlined />} onClick={() => navigate(`/inbox/${ticket.conversation_id}`)}>Open chat</Button>}
          </>
        )}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card title="What the client reported">
            {ticket.description ? (
              <p style={{ margin: '0 0 16px', whiteSpace: 'pre-wrap', color: 'var(--ink)' }}>{ticket.description}</p>
            ) : (
              <p style={{ margin: '0 0 16px', color: 'var(--ink-3)' }}>The client didn&apos;t add a description.</p>
            )}
            <Descriptions size="small" column={{ xs: 1, sm: 2 }} style={{ borderTop: '1px solid var(--line-2)', paddingTop: 16 }}>
              <Descriptions.Item label="Client">
                {ticket.client_id
                  ? <Link to={`/clients/${ticket.client_id}`} className="braq-link" style={{ fontWeight: 600 }}><UserOutlined aria-hidden="true" /> {ticket.client_name ?? 'Client'}</Link>
                  : <span style={{ fontWeight: 600 }}>{ticket.client_name ?? '—'}</span>}
              </Descriptions.Item>
              <Descriptions.Item label="WhatsApp">{ticket.client_wa ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Order">
                {ticket.order_reference
                  ? (jobLink ? <Link to={jobLink} className="braq-ref">{ticket.order_reference}</Link> : <span className="braq-ref">{ticket.order_reference}</span>)
                  : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Response due">
                <span style={{ color: isOverdue ? 'var(--thread)' : 'var(--ink-2)', fontWeight: isOverdue ? 600 : 400 }}>
                  {dateTime(ticket.sla_due_at)}
                </span>
              </Descriptions.Item>
              <Descriptions.Item label="Assigned to">
                {ticket.assigned_name ?? <span style={{ color: 'var(--ink-3)' }}>Nobody yet</span>}
              </Descriptions.Item>
              <Descriptions.Item label="Opened">{dateTime(ticket.created_at)}</Descriptions.Item>
              {ticket.resolved_at && <Descriptions.Item label="Resolved" span="filled">{dateTime(ticket.resolved_at)}</Descriptions.Item>}
              {ticket.resolution_note && <Descriptions.Item label="Resolution" span="filled">{ticket.resolution_note}</Descriptions.Item>}
            </Descriptions>
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card title="Handle this ticket">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div>
                <label htmlFor="ticket-status" style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>Update status</label>
                <Select
                  id="ticket-status"
                  value={ticket.status}
                  options={STATUS_OPTIONS}
                  style={{ width: '100%' }}
                  onChange={onStatus}
                  loading={updateMutation.isPending}
                />
                <div className="braq-small" style={{ marginTop: 6 }}>Resolving asks for a note and lets the client know on WhatsApp.</div>
              </div>

              <div>
                <label htmlFor="ticket-assignee" style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>Assign to</label>
                <Select
                  id="ticket-assignee"
                  value={ticket.assigned_staff_id ?? undefined}
                  placeholder="Nobody — choose a staff member"
                  options={assignableStaff(staffList, ticket.assigned_staff_id).map((s) => ({ value: s.id, label: `${s.name} (${s.role})` }))}
                  style={{ width: '100%' }}
                  // Clearing sends null, which unassigns the ticket.
                  onChange={(v) => update({ assignedStaffId: v ?? null }, v ? 'Ticket assigned' : 'Ticket unassigned')}
                  loading={updateMutation.isPending}
                  allowClear
                />
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      <Modal
        title="Resolve ticket"
        open={resolveOpen}
        onCancel={() => setResolveOpen(false)}
        onOk={resolve}
        okText="Resolve and notify client"
        okButtonProps={{ loading: updateMutation.isPending }}
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
        {resolveError && <Alert type="error" showIcon style={{ marginTop: 12 }} message={resolveError.message} />}
      </Modal>
    </div>
  )
}

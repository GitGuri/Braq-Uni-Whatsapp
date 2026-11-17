import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Button, Form, Input, Modal, Select, Skeleton, Alert } from 'antd'
import { PlusOutlined, CustomerServiceOutlined, PhoneOutlined, MailOutlined, RightOutlined, EditOutlined } from '@ant-design/icons'
import { getClient, updateClient } from '../api/clients.js'
import { listJobs } from '../api/jobs.js'
import { createQuotation } from '../api/quotations.js'
import { createTicket } from '../api/tickets.js'
import { actionError } from '../api/adapt.js'
import { qk, useJobMutation } from '../lib/queryKeys.js'
import { TERMINAL_JOB_STATES, useStatus } from '../lib/status.js'
import { useMeta } from '../lib/useMeta.js'
import { sentence } from '../lib/format.js'
import StatusPill, { FlagPills } from './StatusPill.jsx'
import ErrorState from './ErrorState.jsx'

/**
 * Start a quote for a client (optionally from a chat) and open the new job.
 * When the client already has an open job, asks first (a second quote is
 * usually a mistake) — `confirmed: true` skips the question.
 *   const start = useStartQuote(); start.mutate({ clientId, conversationId })
 */
export function useStartQuote() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { message, modal } = App.useApp()
  const create = useJobMutation({
    mutationFn: ({ clientId, conversationId }) => createQuotation({ clientId, ...(conversationId ? { conversationId } : {}) }),
    onSuccess: (res) => {
      message.success(`Quote ${res?.quotation?.reference ?? ''} started`.replace(/ +$/, ''))
      if (res?.quotation?.id) navigate(`/jobs/${res.quotation.id}`)
    },
    onError: (err) => message.error(actionError(err, 'The quote was not started').message),
  })
  const [checking, setChecking] = useState(false)

  const mutate = async (vars, opts) => {
    if (!vars.confirmed) {
      setChecking(true)
      let open = []
      try {
        const res = await qc.fetchQuery({ queryKey: qk.jobs({ clientId: vars.clientId, limit: 50 }), queryFn: () => listJobs({ clientId: vars.clientId, limit: 50 }), staleTime: 10_000 })
        open = (res?.items ?? []).filter((j) => !TERMINAL_JOB_STATES.includes(j.state))
      } catch { /* the check is a courtesy — carry on */ }
      setChecking(false)
      if (open.length) {
        const first = open[0]
        modal.confirm({
          title: 'This client already has an open job',
          content: `${first.order_reference ?? first.quotation_reference} is ${String(first.state_label ?? first.state).toLowerCase()}${open.length > 1 ? ` (and ${open.length - 1} more)` : ''}. Start another quote anyway?`,
          okText: 'Start another quote',
          cancelText: 'Open the existing job',
          closable: true,
          onOk: () => create.mutate(vars, opts),
          onCancel: (close) => {
            if (typeof close === 'function') close()
            navigate(`/jobs/${first.quotation_id}`)
          },
        })
        return
      }
    }
    create.mutate(vars, opts)
  }
  return { mutate, isPending: create.isPending || checking }
}

/**
 * Open a ticket for a client, optionally linked to one of their orders (the
 * order is preselected when the client has exactly one active order). Opens
 * the new ticket afterwards.
 */
export function OpenTicketModal({ open, onClose, clientId, orders = [] }) {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const status = useStatus()
  const [form] = Form.useForm()
  const [error, setError] = useState(null)
  const create = useJobMutation({ mutationFn: (v) => createTicket(v) })
  const active = orders.filter((o) => !TERMINAL_JOB_STATES.includes(o.state))
  const preselect = active.length === 1 ? active[0].order_id : (orders.length === 1 ? orders[0].order_id : undefined)
  const submit = async () => {
    let v
    try { v = await form.validateFields() } catch { return }
    setError(null)
    try {
      const res = await create.mutateAsync({ clientId, category: v.category, description: v.description.trim(), ...(v.orderId ? { orderId: v.orderId } : {}) })
      message.success('Ticket opened')
      form.resetFields()
      onClose()
      if (res?.ticket?.id) navigate(`/tickets/${res.ticket.id}`)
    } catch (err) { setError(actionError(err, 'The ticket was not opened')) }
  }
  return (
    <Modal title="Open a ticket" open={open} onCancel={onClose} onOk={submit} okText="Open ticket" okButtonProps={{ loading: create.isPending }} destroyOnHidden>
      <Form form={form} layout="vertical" name="new-ticket" requiredMark={false} style={{ marginTop: 12 }} initialValues={{ orderId: preselect }}>
        <Form.Item name="category" label="What kind of problem?" rules={[{ required: true, message: 'Choose a category' }]}>
          <Select placeholder="Choose a category" options={status.options('category')} />
        </Form.Item>
        {orders.length > 0 && (
          <Form.Item name="orderId" label="Order (optional)">
            <Select allowClear placeholder="Link it to an order" options={orders.map((o) => ({ value: o.order_id, label: o.order_reference }))} />
          </Form.Item>
        )}
        <Form.Item name="description" label="Description" rules={[{ required: true, whitespace: true, min: 5, message: 'Describe the problem (at least 5 characters)' }]}>
          <Input.TextArea rows={3} placeholder="What went wrong, and what the client wants done" />
        </Form.Item>
      </Form>
      {error && <Alert type="error" showIcon message={error.message} />}
    </Modal>
  )
}

/** Change a client's name and type (from a chat or the job page). */
export function EditClientBasicsModal({ open, onClose, client }) {
  const { message } = App.useApp()
  const meta = useMeta()
  const [form] = Form.useForm()
  const save = useJobMutation({ mutationFn: (patch) => updateClient(client.id, patch) })
  const submit = async () => {
    let v
    try { v = await form.validateFields() } catch { return }
    const patch = {}
    if ((v.name ?? '').trim() !== (client.name ?? '')) patch.name = (v.name ?? '').trim() || null
    if (v.clientType && v.clientType !== client.client_type) patch.clientType = v.clientType
    if (!Object.keys(patch).length) { onClose(); return }
    try {
      await save.mutateAsync(patch)
      message.success('Client updated')
      onClose()
    } catch (err) { message.error(actionError(err, 'Changes were not saved').message) }
  }
  return (
    <Modal title="Edit client" open={open} onCancel={onClose} onOk={submit} okText="Save" okButtonProps={{ loading: save.isPending }} destroyOnHidden>
      <Form form={form} layout="vertical" name="edit-client-basics" style={{ marginTop: 12 }}
        initialValues={{ name: client?.name ?? '', clientType: client?.client_type }}>
        <Form.Item name="name" label="Name"><Input placeholder="The client's name" /></Form.Item>
        <Form.Item name="clientType" label="Client type">
          <Select options={(meta.clientTypes ?? []).map((t) => ({ value: t, label: sentence(t) }))} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

/**
 * Who the client is and what is open for them: profile, open jobs with their
 * state and next step, and the two things staff start from a chat —
 * "Start a quote" and "Open ticket".
 *   <ClientPanel clientId={…} conversationId={…} />
 */
export default function ClientPanel({ clientId, conversationId, showProfile = true, title = 'Client' }) {
  const status = useStatus()
  const startQuote = useStartQuote()
  const [ticketOpen, setTicketOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)

  const clientQ = useQuery({ queryKey: qk.client(clientId), queryFn: () => getClient(clientId), enabled: !!clientId && showProfile })
  const jobsQ = useQuery({ queryKey: qk.jobs({ clientId, limit: 50 }), queryFn: () => listJobs({ clientId, limit: 50 }), enabled: !!clientId })

  const client = clientQ.data?.client
  const jobs = jobsQ.data?.items ?? []
  const open = jobs.filter((j) => !TERMINAL_JOB_STATES.includes(j.state))
  const withOrders = jobs.filter((j) => j.order_id)

  return (
    <section className="braq-panel braq-client-panel" aria-labelledby="client-panel-title">
      <div className="braq-panel-head">
        <h2 id="client-panel-title" className="braq-panel-title">{title}</h2>
        {clientId && <Link to={`/clients/${clientId}`} className="braq-link" style={{ fontSize: 13 }}>Client page <RightOutlined aria-hidden="true" /></Link>}
      </div>

      {showProfile && (
        <div className="braq-panel-body braq-client-profile">
          {clientQ.isLoading ? <Skeleton active title={false} paragraph={{ rows: 3 }} />
            : clientQ.error ? <ErrorState title="Could not load the client" error={clientQ.error} onRetry={clientQ.refetch} />
              : client && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ fontWeight: 650, fontSize: 15, minWidth: 0, overflowWrap: 'anywhere' }}>{client.name ?? client.whatsapp_number}</div>
                    <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditOpen(true)} aria-label="Edit client name and type">Edit</Button>
                  </div>
                  {(client.organisation || client.school_name) && <div className="braq-muted">{client.organisation ?? client.school_name}</div>}
                  <div className="braq-client-facts">
                    <span><PhoneOutlined aria-hidden="true" /> {client.whatsapp_number}</span>
                    {client.email && <span><MailOutlined aria-hidden="true" /> {client.email}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                    {client.client_type && <span className="braq-pill">{sentence(client.client_type)}</span>}
                    {client.account_terms && <span className="braq-pill blue">Account</span>}
                    {client.customer_number && <span className="braq-pill">{client.customer_number}</span>}
                    {!client.profile_complete && <span className="braq-pill amber">Profile missing details</span>}
                  </div>
                </>
              )}
        </div>
      )}

      <div className="braq-panel-body" style={{ borderTop: showProfile ? '1px solid var(--line-2)' : 0 }}>
        <div className="braq-section-label">Open jobs{open.length ? ` (${open.length})` : ''}</div>
        {jobsQ.isLoading ? <Skeleton active title={false} paragraph={{ rows: 2 }} />
          : jobsQ.error ? <ErrorState title="Could not load jobs" error={jobsQ.error} onRetry={jobsQ.refetch} />
            : open.length === 0 ? <p className="braq-muted" style={{ margin: 0 }}>Nothing open. Start a quote when the client asks for one.</p>
              : (
                <ul className="braq-list flush compact" aria-label="Open jobs">
                  {open.map((j) => (
                    <li key={j.quotation_id}>
                      <Link to={`/jobs/${j.quotation_id}`} className="braq-row-link">
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span className="braq-ref">{j.order_reference ?? j.quotation_reference}</span>
                            <StatusPill kind="job" value={j.state} size="sm" />
                            <FlagPills flags={j.flags} size="sm" exclude={['WITH_CONSULTANT']} />
                          </span>
                          <span className="braq-row-sub">Next: {status.description(j.state)}</span>
                        </span>
                        <RightOutlined aria-hidden="true" className="braq-row-chevron" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
      </div>

      <div className="braq-panel-body braq-client-actions">
        <Button type="primary" icon={<PlusOutlined />} loading={startQuote.isPending} onClick={() => startQuote.mutate({ clientId, conversationId })}>
          Start a quote
        </Button>
        <Button icon={<CustomerServiceOutlined />} onClick={() => setTicketOpen(true)}>Open ticket</Button>
      </div>

      <OpenTicketModal open={ticketOpen} onClose={() => setTicketOpen(false)} clientId={clientId} orders={withOrders} />
      {client && <EditClientBasicsModal open={editOpen} onClose={() => setEditOpen(false)} client={client} />}
    </section>
  )
}

import { useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Card, Descriptions, Button, Table, Form, Input, Select, Spin, message, Modal, Tabs, Switch, Tooltip,
} from 'antd'
import { EditOutlined, PlusOutlined, MessageOutlined, CustomerServiceOutlined } from '@ant-design/icons'
import { getClient, updateClient, setAccountTerms, openClientConversation } from '../../api/clients.js'
import { listJobs } from '../../api/jobs.js'
import { listTickets } from '../../api/tickets.js'
import { conversationForClient } from '../../api/conversations.js'
import { errorMessage } from '../../utils/errorMessage.js'
import { qk } from '../../lib/queryKeys.js'
import { useMeta } from '../../lib/useMeta.js'
import { useStatus } from '../../lib/status.js'
import { money, date, dateTime, sentence, ticketNo } from '../../lib/format.js'
import DetailHeader from '../../components/DetailHeader.jsx'
import StatusPill, { FlagPills } from '../../components/StatusPill.jsx'
import ErrorState from '../../components/ErrorState.jsx'
import { useStartQuote, OpenTicketModal } from '../../components/ClientPanel.jsx'
import { Fact } from '../Jobs/OrderPanel.jsx'
import { useCan } from '../../lib/useCan.js'

// Edit form field (camelCase, as PATCH /clients/:id expects) → clients table column
const EDIT_FIELDS = {
  name:                   'name',
  clientType:             'client_type',
  organisation:           'organisation',
  contactPerson:          'contact_person',
  email:                  'email',
  schoolName:             'school_name',
  physicalAddress:        'physical_address',
  preferredStoreLocation: 'preferred_store_location',
  deliveryPreference:     'delivery_preference',
  vatNumber:              'vat_number',
}

/** Only the fields that changed; '' clears a field (sent as null). */
function buildClientPatch(client, values) {
  const patch = {}
  for (const [field, col] of Object.entries(EDIT_FIELDS)) {
    if (!(field in values)) continue
    let next = values[field]
    if (typeof next === 'string') next = next.trim()
    if (next === '' || next === undefined) next = null
    const prev = client[col] ?? null
    if (next === prev) continue
    if (next === null && field === 'clientType') continue // NOT NULL column
    patch[field] = next
  }
  return patch
}

const muted = (v) => <span style={{ fontSize: 13, color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{v}</span>

/**
 * A client: profile, every job (with its state and next step), tickets, and
 * the things staff start from here — a quote, the chat, a ticket.
 */
export default function ClientDetail() {
  const { id }    = useParams()
  const navigate  = useNavigate()
  const qc        = useQueryClient()
  const meta      = useMeta()
  const status    = useStatus()
  const startQuote = useStartQuote()
  const can = useCan()
  const [editOpen, setEditOpen] = useState(false)
  const [ticketOpen, setTicketOpen] = useState(false)
  const [form]    = Form.useForm()
  const [msgApi, ctx] = message.useMessage()

  const { data, isLoading, error, refetch } = useQuery({ queryKey: qk.client(id), queryFn: () => getClient(id) })
  const jobsQ = useQuery({ queryKey: qk.jobs({ clientId: id, limit: 100 }), queryFn: () => listJobs({ clientId: id, limit: 100 }) })
  const ticketsQ = useQuery({ queryKey: qk.tickets({ clientId: id, limit: 100 }), queryFn: () => listTickets({ clientId: id, limit: 100 }) })
  const convQ = useQuery({ queryKey: qk.clientConversation(id), queryFn: () => conversationForClient(id) })

  const updateMutation = useMutation({
    mutationFn: (patch) => updateClient(id, patch),
    onSuccess: () => {
      msgApi.success('Client updated')
      setEditOpen(false)
      qc.invalidateQueries({ queryKey: qk.client(id) })
      qc.invalidateQueries({ queryKey: qk.clients() })
    },
    onError: (err) => msgApi.error(errorMessage(err, 'Changes were not saved')),
  })

  // Account terms: no deposit needed before production (admin / manager).
  const termsMutation = useMutation({
    mutationFn: (on) => setAccountTerms(id, on),
    onSuccess: (_, on) => {
      msgApi.success(on ? 'Account client — no deposit needed before production' : 'Deposit required again before production')
      qc.invalidateQueries({ queryKey: qk.client(id) })
      qc.invalidateQueries({ queryKey: qk.jobs() })
      qc.invalidateQueries({ queryKey: ['job'] })
    },
    onError: (err) => msgApi.error(errorMessage(err, 'Account terms were not changed')),
  })
  // The client's chat — opened, or started when there is none.
  const chatMutation = useMutation({
    mutationFn: () => openClientConversation(id),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: qk.clientConversation(id) })
      if (res?.conversation?.id) navigate(`/inbox/${res.conversation.id}`)
    },
    onError: (err) => msgApi.error(errorMessage(err, 'Could not open the chat')),
  })

  if (isLoading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
  if (error) {
    return (
      <>
        <DetailHeader back={{ to: '/clients', label: 'Clients' }} title="Client" />
        <section className="braq-panel"><ErrorState title="Could not load this client" error={error} onRetry={refetch} /></section>
      </>
    )
  }

  const { client, summary } = data
  const jobs = jobsQ.data?.items ?? []
  const tickets = ticketsQ.data?.items ?? []
  const conversation = convQ.data
  const from = `/clients/${id}`

  const jobColumns = [
    {
      title: 'Job',
      key: 'ref',
      render: (_, r) => (
        <Link to={`/jobs/${r.quotation_id}`} state={{ from }} className="braq-ref" onClick={(e) => e.stopPropagation()}>
          {r.order_reference ?? r.quotation_reference}
        </Link>
      ),
    },
    {
      title: 'State',
      key: 'state',
      render: (_, r) => (
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          <StatusPill kind="job" value={r.state} label={r.state_label} />
          <FlagPills flags={r.flags} exclude={['WITH_CONSULTANT']} />
        </span>
      ),
    },
    { title: 'Next step', key: 'next', responsive: ['md'], render: (_, r) => muted(status.description(r.state)) },
    { title: 'Total', key: 'total', align: 'right', render: (_, r) => <span style={{ whiteSpace: 'nowrap' }}>{money(r.total)}</span> },
    { title: 'Started', key: 'created', responsive: ['sm'], render: (_, r) => muted(date(r.created_at)) },
  ]

  const ticketColumns = [
    { title: 'Ticket', key: 'id', render: (_, t) => <Link to={`/tickets/${t.id}`} className="braq-ref">#{ticketNo(t.id)}</Link> },
    { title: 'Status', key: 'status', render: (_, t) => <StatusPill kind="ticket" value={t.status} /> },
    { title: 'Category', key: 'category', render: (_, t) => <span className="braq-pill">{status.label('category', t.category)}</span> },
    {
      title: 'Order',
      key: 'order',
      render: (_, t) => (t.order_reference
        ? (t.quotation_id ? <Link to={`/jobs/${t.quotation_id}`} state={{ from }} className="braq-ref">{t.order_reference}</Link> : <span className="braq-ref">{t.order_reference}</span>)
        : muted('—')),
    },
    { title: 'Opened', key: 'created', render: (_, t) => muted(date(t.created_at)) },
  ]

  const tabItems = [
    {
      key: 'jobs',
      label: `Jobs (${jobs.length})`,
      children: jobsQ.error ? <ErrorState title="Could not load jobs" error={jobsQ.error} onRetry={jobsQ.refetch} /> : (
        <Table
          dataSource={jobs}
          columns={jobColumns}
          rowKey="quotation_id"
          size="small"
          loading={jobsQ.isLoading}
          pagination={jobs.length > 20 ? { pageSize: 20, showSizeChanger: false } : false}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: 'No jobs yet. Start a quote when the client asks for one.' }}
          onRow={(r) => ({ onClick: () => navigate(`/jobs/${r.quotation_id}`, { state: { from } }), style: { cursor: 'pointer' } })}
        />
      ),
    },
    {
      key: 'tickets',
      label: `Tickets (${tickets.length})`,
      children: ticketsQ.error ? <ErrorState title="Could not load tickets" error={ticketsQ.error} onRetry={ticketsQ.refetch} /> : (
        <Table
          dataSource={tickets}
          columns={ticketColumns}
          rowKey="id"
          size="small"
          loading={ticketsQ.isLoading}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: 'No tickets. Problems the client reports after an order appear here.' }}
        />
      ),
    },
  ]

  return (
    <>
      {ctx}
      <DetailHeader
        back={{ to: '/clients', label: 'Clients' }}
        title={client.name ?? client.whatsapp_number}
        meta={(
          <>
            {client.customer_number && <span className="braq-ref" style={{ color: 'var(--ink-2)' }}>{client.customer_number}</span>}
            {client.client_type && <span className="braq-pill">{sentence(client.client_type)}</span>}
            {client.account_terms && <span className="braq-pill blue" title="No deposit needed before production">Account</span>}
            <span className={`braq-pill ${client.profile_complete ? 'green' : 'amber'}`}>
              {client.profile_complete ? 'Profile complete' : 'Profile missing details'}
            </span>
          </>
        )}
        actions={(
          <>
            <Button type="primary" icon={<PlusOutlined />} loading={startQuote.isPending} onClick={() => startQuote.mutate({ clientId: id, conversationId: conversation?.id })}>
              Start a quote
            </Button>
            <Button
              icon={<MessageOutlined />}
              loading={chatMutation.isPending}
              onClick={() => (conversation?.is_open ? navigate(`/inbox/${conversation.id}`) : chatMutation.mutate())}
            >
              {conversation?.is_open ? 'Open chat' : 'Start a chat'}
            </Button>
            <Button icon={<CustomerServiceOutlined />} onClick={() => setTicketOpen(true)}>Open ticket</Button>
            <Button
              icon={<EditOutlined />}
              onClick={() => {
                form.resetFields()
                form.setFieldsValue(Object.fromEntries(
                  Object.entries(EDIT_FIELDS).map(([field, col]) => [field, client[col] ?? undefined])
                ))
                setEditOpen(true)
              }}
            >
              Edit details
            </Button>
          </>
        )}
      />

      <section className="braq-panel" aria-labelledby="client-money" style={{ marginBottom: 16 }}>
        <div className="braq-panel-head">
          <h2 id="client-money" className="braq-panel-title">Money</h2>
          <label className="braq-switch-label" title={can('client.terms') ? undefined : 'Only an admin or manager can change this'}>
            <Tooltip title={can('client.terms') ? 'Account clients trade on terms: production can start without a deposit. The balance is still due before collection.' : 'Only an admin or manager can change this'}>
              <Switch
                size="small"
                checked={client.account_terms === true}
                disabled={!can('client.terms')}
                loading={termsMutation.isPending}
                onChange={(on) => termsMutation.mutate(on)}
                aria-label="Account client — no deposit needed"
              />
            </Tooltip>
            Account client — no deposit needed
          </label>
        </div>
        <div className="braq-panel-body">
          <div className="braq-money-grid">
            <Fact label="Orders">{summary?.orders ?? 0}</Fact>
            <Fact label="Order value">{money(summary?.total ?? 0)}</Fact>
            <Fact label="Paid">{money(summary?.paid ?? 0)}</Fact>
            <Fact label="Outstanding">
              <strong style={{ color: Number(summary?.outstanding) > 0 ? 'var(--thread)' : 'var(--good)' }}>{money(summary?.outstanding ?? 0)}</strong>
            </Fact>
          </div>
          {client.account_terms_set_at && (
            <div className="braq-small" style={{ marginTop: 10 }}>
              Account terms {client.account_terms ? 'set' : 'removed'} by {client.account_terms_set_by_name ?? 'staff'} on {dateTime(client.account_terms_set_at)}
            </div>
          )}
        </div>
      </section>

      <Card title="Details" style={{ marginBottom: 16 }}>
        <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }}>
          <Descriptions.Item label="WhatsApp">{client.whatsapp_number}</Descriptions.Item>
          <Descriptions.Item label="Client type">{client.client_type ? sentence(client.client_type) : '—'}</Descriptions.Item>
          <Descriptions.Item label="Organisation">{client.organisation ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="School">{client.school_name ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Contact person">{client.contact_person ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Email">{client.email ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Delivery preference">{client.delivery_preference ? sentence(client.delivery_preference) : '—'}</Descriptions.Item>
          <Descriptions.Item label="Store location">{client.preferred_store_location ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Physical address" span="filled">{client.physical_address ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Joined">{date(client.created_at)}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card styles={{ body: { padding: '0 16px 16px' } }}>
        <Tabs items={tabItems} />
      </Card>

      <OpenTicketModal open={ticketOpen} onClose={() => setTicketOpen(false)} clientId={id} orders={jobs.filter((j) => j.order_id)} />

      <Modal
        title="Edit client"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={async () => {
          let values
          try { values = await form.validateFields() } catch { return }
          const patch = buildClientPatch(client, values)
          if (!Object.keys(patch).length) {
            msgApi.info('Nothing changed, so there was nothing to save')
            setEditOpen(false)
            return
          }
          updateMutation.mutate(patch)
        }}
        okText="Save"
        okButtonProps={{ loading: updateMutation.isPending }}
        width={480}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="Name">
            <Input />
          </Form.Item>
          <Form.Item name="clientType" label="Client type">
            <Select options={(meta.clientTypes ?? []).map((t) => ({ value: t, label: sentence(t) }))} />
          </Form.Item>
          <Form.Item name="organisation" label="Organisation">
            <Input />
          </Form.Item>
          <Form.Item name="contactPerson" label="Contact person">
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ type: 'email', message: 'Enter a valid email address, like name@school.co.za' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="schoolName" label="School">
            <Input placeholder="For school uniform clients" />
          </Form.Item>
          <Form.Item name="deliveryPreference" label="Delivery preference">
            <Select
              allowClear
              options={[{ value: 'collection', label: 'Collection' }, { value: 'delivery', label: 'Delivery' }]}
            />
          </Form.Item>
          <Form.Item name="preferredStoreLocation" label="Preferred store">
            <Input />
          </Form.Item>
          <Form.Item name="physicalAddress" label="Physical address">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="vatNumber" label="VAT number">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

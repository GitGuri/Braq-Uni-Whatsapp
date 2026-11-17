import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Table, Card, Select, Button, message } from 'antd'
import dayjs from 'dayjs'
import { listTickets, claimTicket } from '../../api/tickets.js'
import { errorMessage } from '../../utils/errorMessage.js'
import { qk, useJobMutation } from '../../lib/queryKeys.js'
import { useStatus } from '../../lib/status.js'
import { useUrlState } from '../../lib/useUrlState.js'
import { date, ticketNo } from '../../lib/format.js'
import StatusPill from '../../components/StatusPill.jsx'
import ListPage from '../../components/ListPage.jsx'

const PAGE_SIZE = 20

const muted = (v) => <span style={{ fontSize: 13, color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{v}</span>

export default function TicketsList() {
  const navigate = useNavigate()
  const status   = useStatus()
  const [f, set] = useUrlState({ status: '', overdue: '', page: 1 })
  const [msgApi, ctx] = message.useMessage()
  const params = { status: f.status || undefined, overdue: f.overdue || undefined, page: f.page, limit: PAGE_SIZE }

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: qk.tickets(params),
    queryFn: () => listTickets(params),
    placeholderData: (prev) => prev,
  })

  const claimMutation = useJobMutation({
    mutationFn: (id) => claimTicket(id),
    onSuccess: () => msgApi.success('Ticket claimed. It is now assigned to you.'),
    onError: (err) => msgApi.error(errorMessage(err, 'Could not claim this ticket')),
  })

  const tickets = data?.items ?? []
  const filtered = Boolean(f.status || f.overdue)

  const columns = [
    {
      title: 'Ticket',
      dataIndex: 'id',
      key: 'id',
      render: (v) => <span className="braq-ref">#{ticketNo(v)}</span>,
    },
    {
      title: 'Client',
      key: 'client',
      render: (_, row) => (
        <div>
          <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{row.client_name ?? '—'}</div>
          {row.client_wa && <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>{row.client_wa}</div>}
        </div>
      ),
    },
    {
      title: 'Category',
      dataIndex: 'category',
      key: 'category',
      render: (v) => <span className="braq-pill">{status.label('category', v)}</span>,
    },
    {
      title: 'Order',
      key: 'order',
      render: (_, row) => (row.order_reference
        ? <Link to={row.quotation_id ? `/jobs/${row.quotation_id}` : `/orders/${row.order_id}`} className="braq-ref" onClick={(e) => e.stopPropagation()}>{row.order_reference}</Link>
        : <span style={{ color: 'var(--ink-3)' }}>—</span>),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (s) => <StatusPill kind="ticket" value={s} />,
    },
    {
      title: 'Assigned to',
      key: 'assigned',
      render: (_, row) =>
        row.assigned_name ? (
          <span style={{ fontSize: 13, color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{row.assigned_name}</span>
        ) : (
          <Button
            size="small"
            loading={claimMutation.isPending && claimMutation.variables === row.id}
            onClick={(e) => { e.stopPropagation(); claimMutation.mutate(row.id) }}          >
            Claim
          </Button>
        ),
    },
    {
      title: 'Response due',
      key: 'sla',
      render: (_, row) => {
        if (['resolved', 'closed'].includes(row.status)) return null
        if (row.is_overdue) return <span className="braq-pill red">Overdue</span>
        if (!row.sla_due_at) return null
        const due = dayjs(row.sla_due_at)
        return muted(due.isSame(dayjs(), 'day') ? `Today, ${due.format('HH:mm')}` : due.format('D MMM, HH:mm'))
      },
    },
    {
      title: 'Opened',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v) => muted(date(v)),
    },
  ]

  return (
    <>
      {ctx}
      <ListPage
        title="Support tickets"
        subtitle="Complaints and after-sales problems raised by clients. Claim a ticket to make it yours."
        error={error}
        onRetry={refetch}
        filters={(
          <>
            <Select
              allowClear
              placeholder="Any status"
              aria-label="Filter by status"
              value={f.status || undefined}
              style={{ flex: '1 1 140px', maxWidth: 200 }}
              options={status.options('ticket')}
              onChange={(v) => set({ status: v ?? '' })}
            />
            <Select
              allowClear
              placeholder="Overdue or not"
              aria-label="Filter by due date"
              value={f.overdue || undefined}
              style={{ flex: '1 1 140px', maxWidth: 200 }}
              options={[{ value: 'true', label: 'Overdue only' }]}
              onChange={(v) => set({ overdue: v ?? '' })}
            />
          </>
        )}
      >
        <Card styles={{ body: { padding: 0 } }} style={{ overflow: 'hidden' }}>
          <Table
            dataSource={tickets}
            columns={columns}
            rowKey="id"
            loading={isLoading || isFetching}
            size="middle"
            scroll={{ x: 'max-content' }}
            pagination={{ current: f.page, pageSize: PAGE_SIZE, total: data?.total ?? tickets.length, onChange: (page) => set({ page }), showSizeChanger: false, hideOnSinglePage: true }}
            locale={{
              emptyText: filtered
                ? 'No tickets match these filters. Clear them to see every ticket.'
                : 'No support tickets yet. Tickets are created when a client reports a problem on WhatsApp.',
            }}
            onRow={(row) => ({
              onClick: () => navigate(`/tickets/${row.id}`),
              onKeyDown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) navigate(`/tickets/${row.id}`) },
              tabIndex: 0,
              style: { cursor: 'pointer' },
            })}
            rowClassName={(row) => (row.is_overdue ? 'braq-row-overdue' : '')}
          />
        </Card>
      </ListPage>
    </>
  )
}

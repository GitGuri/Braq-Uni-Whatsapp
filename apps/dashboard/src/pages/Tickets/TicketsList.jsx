import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Table, Card, Typography, Tag, Select, Row, Col, Button, Space, message } from 'antd'
import { UserOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { listTickets, claimTicket } from '../../api/tickets.js'

const { Text } = Typography

const STATUS_COLORS = {
  open:        'processing',
  in_progress: 'warning',
  resolved:    'success',
  closed:      'default',
}

const CATEGORY_LABELS = {
  wrong_item:    'Wrong item',
  defective:     'Defective',
  missing_item:  'Missing item',
  account_query: 'Account Query',
  other:         'Other',
}

export default function TicketsList() {
  const navigate = useNavigate()
  const qc       = useQueryClient()
  const [filters, setFilters] = useState({ limit: 50 })
  const [msgApi, ctx] = message.useMessage()

  const { data, isLoading } = useQuery({
    queryKey: ['tickets', filters],
    queryFn: () => listTickets(filters),
  })

  const claimMutation = useMutation({
    mutationFn: (id) => claimTicket(id),
    onSuccess: () => {
      msgApi.success('Ticket claimed!')
      qc.invalidateQueries({ queryKey: ['tickets'] })
      qc.invalidateQueries({ queryKey: ['dashboard-kpis'] })
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Claim failed'),
  })

  const tickets = data?.tickets ?? []

  const columns = [
    {
      title: 'Ref',
      dataIndex: 'id',
      key: 'id',
      render: (v) => <Text code style={{ fontSize: 12 }}>{v?.slice(0, 8)}</Text>,
      width: 90,
    },
    {
      title: 'Client',
      key: 'client',
      render: (_, row) => (
        <span>
          <Text strong>{row.client_name ?? '—'}</Text>
          {row.client_wa && (
            <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>{row.client_wa}</Text>
          )}
        </span>
      ),
    },
    {
      title: 'Category',
      dataIndex: 'category',
      key: 'category',
      render: (v) => <Tag>{CATEGORY_LABELS[v] ?? v}</Tag>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (s) => (
        <Tag color={STATUS_COLORS[s] ?? 'default'}>
          {s?.replace('_', ' ')}
        </Tag>
      ),
    },
    {
      title: 'Assigned',
      key: 'assigned',
      render: (_, row) =>
        row.assigned_name ? (
          <Space size={4}>
            <UserOutlined style={{ color: '#999' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>{row.assigned_name}</Text>
          </Space>
        ) : (
          <Button
            size="small"
            loading={claimMutation.isPending && claimMutation.variables === row.id}
            onClick={(e) => { e.stopPropagation(); claimMutation.mutate(row.id) }}
          >
            Claim
          </Button>
        ),
    },
    {
      title: 'SLA',
      key: 'sla',
      render: (_, row) => {
        if (['resolved', 'closed'].includes(row.status)) return null
        if (row.is_overdue) return <Tag color="error">Overdue</Tag>
        return (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Due {dayjs(row.sla_due_at).format('HH:mm')}
          </Text>
        )
      },
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {dayjs(v).format('DD MMM YYYY')}
        </Text>
      ),
    },
  ]

  return (
    <div>
      {ctx}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Text style={{ fontSize: 18, fontWeight: 700 }}>Support Tickets</Text>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={8}>
            <Select
              allowClear
              placeholder="Filter by status"
              style={{ width: '100%' }}
              options={[
                { value: 'open',        label: 'Open' },
                { value: 'in_progress', label: 'In Progress' },
                { value: 'resolved',    label: 'Resolved' },
                { value: 'closed',      label: 'Closed' },
              ]}
              onChange={(v) => setFilters((f) => ({ ...f, status: v }))}
            />
          </Col>
          <Col xs={24} sm={8}>
            <Select
              allowClear
              placeholder="All tickets"
              style={{ width: '100%' }}
              options={[{ value: 'true', label: 'Overdue only' }]}
              onChange={(v) => setFilters((f) => ({ ...f, overdue: v }))}
            />
          </Col>
        </Row>
      </Card>

      <Card>
        <Table
          dataSource={tickets}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          size="middle"
          pagination={{ pageSize: 20 }}
          onRow={(row) => ({
            onClick: () => navigate(`/tickets/${row.id}`),
            style: { cursor: 'pointer' },
          })}
          rowClassName={(row) => row.is_overdue ? 'row-overdue' : ''}
        />
      </Card>
    </div>
  )
}

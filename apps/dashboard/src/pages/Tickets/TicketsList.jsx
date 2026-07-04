import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Table, Card, Typography, Tag, Select, Row, Col } from 'antd'
import dayjs from 'dayjs'
import { listTickets } from '../../api/tickets.js'

const { Title, Text } = Typography

const STATUS_COLORS = {
  open:        'processing',
  in_progress: 'warning',
  resolved:    'success',
  closed:      'default',
}

const CATEGORY_LABELS = {
  wrong_item:   'Wrong item',
  defective:    'Defective',
  missing_item: 'Missing item',
  other:        'Other',
}

export default function TicketsList() {
  const navigate = useNavigate()
  const [filters, setFilters] = useState({ limit: 50 })

  const { data, isLoading } = useQuery({
    queryKey: ['tickets', filters],
    queryFn: () => listTickets(filters),
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
      title: 'Assigned To',
      key: 'assigned',
      render: (_, row) =>
        row.assigned_name ?? <Text type="secondary">Unassigned</Text>,
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
      <Title level={4} style={{ marginBottom: 16 }}>Support Tickets</Title>

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

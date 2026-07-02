import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Table, Card, Typography, Tag, Select, Row, Col, Space } from 'antd'
import dayjs from 'dayjs'
import { listTickets } from '../../api/tickets.js'

const { Title } = Typography

const STATUS_COLORS = {
  open: 'processing',
  in_progress: 'warning',
  resolved: 'success',
  closed: 'default',
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
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      render: (v) => <code style={{ fontSize: 12 }}>{v?.slice(0, 8)}…</code>,
    },
    {
      title: 'Client',
      key: 'client',
      render: (_, row) => row.client_name ?? row.client_wa_id ?? '—',
    },
    {
      title: 'Type',
      dataIndex: 'ticket_type',
      key: 'ticket_type',
      render: (v) => <Tag>{v}</Tag>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (s) => (
        <Tag color={STATUS_COLORS[s] ?? 'default'}>
          {s?.replace('_', ' ')?.charAt(0).toUpperCase() + s?.replace('_', ' ')?.slice(1)}
        </Tag>
      ),
    },
    {
      title: 'Assigned To',
      key: 'assigned',
      render: (_, row) => row.assigned_name ?? <span style={{ color: '#999' }}>Unassigned</span>,
    },
    {
      title: 'Overdue',
      dataIndex: 'is_overdue',
      key: 'is_overdue',
      render: (v) => v ? <Tag color="error">Overdue</Tag> : null,
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v) => dayjs(v).format('DD MMM YYYY'),
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
                { value: 'open', label: 'Open' },
                { value: 'in_progress', label: 'In Progress' },
                { value: 'resolved', label: 'Resolved' },
                { value: 'closed', label: 'Closed' },
              ]}
              onChange={(v) => setFilters((f) => ({ ...f, status: v }))}
            />
          </Col>
          <Col xs={24} sm={8}>
            <Select
              allowClear
              placeholder="Overdue only"
              style={{ width: '100%' }}
              options={[{ value: 'true', label: 'Overdue tickets' }]}
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
          onRow={(row) => ({ onClick: () => navigate(`/tickets/${row.id}`) })}
          rowHoverable
          style={{ cursor: 'pointer' }}
        />
      </Card>
    </div>
  )
}

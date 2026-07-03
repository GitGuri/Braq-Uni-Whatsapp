import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Table, Card, Typography, Select, Input, Button, Tag, Space, Row, Col,
} from 'antd'
import { PlusOutlined, WarningOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { listOrders } from '../../api/orders.js'
import StageTag, { STAGES, stageLabel } from '../../components/StageTag.jsx'
import CreateOrderModal from './CreateOrderModal.jsx'

const { Title } = Typography

export default function OrdersList() {
  const navigate = useNavigate()
  const [filters, setFilters] = useState({ page: 1, limit: 20 })
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['orders', filters],
    queryFn: () => listOrders(filters),
  })

  const orders = data?.orders ?? []

  const columns = [
    {
      title: 'Reference',
      dataIndex: 'reference',
      key: 'reference',
      render: (ref) => <strong>{ref}</strong>,
    },
    {
      title: 'Client',
      key: 'client',
      render: (_, row) => row.client_name ?? '—',
    },
    {
      title: 'Type',
      dataIndex: 'client_type',
      key: 'client_type',
      render: (v) => <Tag>{v}</Tag>,
    },
    {
      title: 'Stage',
      dataIndex: 'stage',
      key: 'stage',
      render: (stage) => (
        <Space size={4}>
          <StageTag stage={stage} />
          {stage === 'quotation_submitted' && (
            <Tag
              icon={<WarningOutlined />}
              color="warning"
              style={{ fontSize: 11, padding: '0 4px' }}
            >
              Gate
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Flags',
      key: 'flags',
      render: (_, row) => (
        <Space size={4}>
          {row.is_urgent && <Tag color="red">Urgent</Tag>}
          {row.is_delayed && <Tag color="orange">Delayed</Tag>}
        </Space>
      ),
    },
    {
      title: 'Assigned To',
      key: 'assigned',
      render: (_, row) => row.assigned_name ?? <span style={{ color: '#999' }}>Unassigned</span>,
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>Orders</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          New Order
        </Button>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={8}>
            <Select
              allowClear
              placeholder="Filter by stage"
              style={{ width: '100%' }}
              options={STAGES.map((s) => ({ value: s, label: stageLabel(s) }))}
              onChange={(v) => setFilters((f) => ({ ...f, stage: v, page: 1 }))}
            />
          </Col>
          <Col xs={24} sm={8}>
            <Select
              allowClear
              placeholder="Delayed only"
              style={{ width: '100%' }}
              options={[{ value: 'true', label: 'Delayed orders' }]}
              onChange={(v) => setFilters((f) => ({ ...f, isDelayed: v, page: 1 }))}
            />
          </Col>
          <Col xs={24} sm={8}>
            <Select
              allowClear
              placeholder="Urgent only"
              style={{ width: '100%' }}
              options={[{ value: 'true', label: 'Urgent orders' }]}
              onChange={(v) => setFilters((f) => ({ ...f, isUrgent: v, page: 1 }))}
            />
          </Col>
        </Row>
      </Card>

      <Card>
        <Table
          dataSource={orders}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          pagination={{
            current: filters.page,
            pageSize: filters.limit,
            onChange: (page) => setFilters((f) => ({ ...f, page })),
          }}
          onRow={(row) => ({ onClick: () => navigate(`/orders/${row.id}`) })}
          rowHoverable
          style={{ cursor: 'pointer' }}
          size="middle"
        />
      </Card>

      <CreateOrderModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSuccess={() => { setCreateOpen(false); refetch() }}
      />
    </div>
  )
}

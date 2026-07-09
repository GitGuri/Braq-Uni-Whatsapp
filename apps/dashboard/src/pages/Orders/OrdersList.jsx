import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Table, Card, Typography, Select, Input, Button, Tag, Space } from 'antd'
import { SearchOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { listOrders } from '../../api/orders.js'
import CreateOrderModal from './CreateOrderModal.jsx'

const { Text } = Typography

const STAGES = [
  { value: 'deposit_pending', label: '1. Awaiting Deposit' },
  { value: 'in_production',   label: '2. In Production' },
  { value: 'ready',           label: '3. Ready / Dispatched' },
  { value: 'completed',       label: '4. Completed' },
]

const STAGE_COLORS = {
  deposit_pending: 'orange',
  in_production:   'blue',
  ready:           'gold',
  completed:       'green',
}

export default function OrdersList() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [searchParams] = useSearchParams()
  const [stage, setStage] = useState(null)
  const [search, setSearch] = useState('')
  const [onHold, setOnHold] = useState(searchParams.get('onHold') === 'true' ? 'true' : null)
  const [createOpen, setCreateOpen] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['orders', { stage, onHold }],
    queryFn: () => listOrders({ stage: stage || undefined, onHold: onHold || undefined }),
  })

  const orders = (data?.orders ?? []).filter(o => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      o.reference?.toLowerCase().includes(q) ||
      o.client_name?.toLowerCase().includes(q) ||
      o.organisation?.toLowerCase().includes(q)
    )
  })

  const columns = [
    {
      title: 'Reference',
      dataIndex: 'reference',
      render: (ref, row) => (
        <a style={{ fontWeight: 600, fontFamily: 'monospace' }} onClick={() => navigate(`/orders/${row.id}`)}>
          {ref}
        </a>
      ),
    },
    {
      title: 'Client',
      render: (_, r) => (
        <div>
          <Text strong style={{ fontSize: 13 }}>{r.client_name ?? '—'}</Text>
          {r.organisation && <div><Text type="secondary" style={{ fontSize: 11 }}>{r.organisation}</Text></div>}
        </div>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'client_type',
      render: (v) => <Tag style={{ fontSize: 11 }}>{v}</Tag>,
    },
    {
      title: 'Stage',
      dataIndex: 'stage',
      render: (s) => (
        <Tag color={STAGE_COLORS[s] ?? 'default'} style={{ fontSize: 11 }}>
          {STAGES.find(st => st.value === s)?.label ?? s}
        </Tag>
      ),
    },
    {
      title: 'Status',
      render: (_, r) => (
        <Space size={4}>
          {r.is_on_hold && <Tag color="red">On Hold</Tag>}
          <Tag color={r.payment_status === 'paid_in_full' ? 'green' : r.payment_status === 'deposit_paid' ? 'orange' : 'default'}>
            {r.payment_status?.replace(/_/g, ' ')}
          </Tag>
        </Space>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      render: (v) => <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).format('DD MMM YYYY')}</Text>,
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Text style={{ fontSize: 18, fontWeight: 700 }}>Orders</Text>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            Create Order
          </Button>
          <Input
            prefix={<SearchOutlined />}
            placeholder="Search by reference or client…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: 240 }}
            allowClear
          />
          <Select
            placeholder="Filter by stage"
            value={stage}
            onChange={setStage}
            allowClear
            style={{ width: 220 }}
            options={STAGES}
          />
          <Select
            placeholder="Hold status"
            value={onHold}
            onChange={setOnHold}
            allowClear
            style={{ width: 140 }}
            options={[{ value: 'true', label: 'On Hold' }]}
          />
        </Space>
      </div>

      <Card bodyStyle={{ padding: 0 }} style={{ borderRadius: 10 }}>
        <Table
          dataSource={orders}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          pagination={{ pageSize: 25, showSizeChanger: false }}
          size="middle"
          onRow={row => ({ onClick: () => navigate(`/orders/${row.id}`), style: { cursor: 'pointer' } })}
        />
      </Card>

      <CreateOrderModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSuccess={(order) => {
          setCreateOpen(false)
          qc.invalidateQueries({ queryKey: ['orders'] })
          if (order?.id) navigate(`/orders/${order.id}`)
        }}
      />
    </div>
  )
}

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Table, Card, Typography, Tag, Input } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { listClients } from '../../api/clients.js'

const { Text } = Typography

export default function ClientsList() {
  const navigate = useNavigate()
  const [page, setPage]     = useState(1)
  const [search, setSearch] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['clients', { page, search }],
    queryFn: () => listClients({ page, limit: 20, search: search || undefined }),
  })

  const clients = data?.clients ?? []

  const columns = [
    {
      title: 'Name / WhatsApp',
      key: 'name',
      render: (_, r) => (
        <div>
          <Text strong style={{ fontSize: 13 }}>{r.name ?? '—'}</Text>
          <div><Text type="secondary" style={{ fontSize: 11 }}>{r.wa_id}</Text></div>
          {r.customer_number && (
            <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace' }}>{r.customer_number}</Text>
          )}
        </div>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'client_type',
      render: (v) => v ? <Tag style={{ fontSize: 11 }}>{v}</Tag> : '—',
    },
    {
      title: 'Organisation / School',
      render: (_, r) => r.organisation ?? r.school_name ?? <Text type="secondary">—</Text>,
    },
    {
      title: 'Profile',
      dataIndex: 'profile_complete',
      render: (v) => <Tag color={v ? 'green' : 'orange'}>{v ? 'Complete' : 'Incomplete'}</Tag>,
    },
    {
      title: 'Joined',
      dataIndex: 'created_at',
      render: (v) => <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).format('DD MMM YYYY')}</Text>,
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Text style={{ fontSize: 18, fontWeight: 700 }}>Clients</Text>
        <Input
          prefix={<SearchOutlined />}
          placeholder="Search by name or WhatsApp…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
          allowClear
          style={{ width: 280 }}
        />
      </div>

      <Card bodyStyle={{ padding: 0 }} style={{ borderRadius: 10 }}>
        <Table
          dataSource={clients}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          pagination={{ current: page, pageSize: 20, onChange: setPage, showSizeChanger: false }}
          size="middle"
          onRow={r => ({ onClick: () => navigate(`/clients/${r.id}`), style: { cursor: 'pointer' } })}
        />
      </Card>
    </div>
  )
}

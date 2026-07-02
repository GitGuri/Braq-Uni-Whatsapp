import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Table, Card, Typography, Tag, Input, Row, Col } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { listClients } from '../../api/clients.js'

const { Title } = Typography

export default function ClientsList() {
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
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
      render: (_, row) => (
        <div>
          <div><strong>{row.name ?? '—'}</strong></div>
          <div style={{ color: '#999', fontSize: 12 }}>{row.wa_id}</div>
        </div>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'client_type',
      key: 'client_type',
      render: (v) => v ? <Tag>{v}</Tag> : '—',
    },
    {
      title: 'Organization',
      dataIndex: 'organization',
      key: 'organization',
      render: (v) => v ?? '—',
    },
    {
      title: 'Contact Person',
      dataIndex: 'contact_person',
      key: 'contact_person',
      render: (v) => v ?? '—',
    },
    {
      title: 'Joined',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v) => dayjs(v).format('DD MMM YYYY'),
    },
  ]

  return (
    <div>
      <Title level={4} style={{ marginBottom: 16 }}>Clients</Title>

      <Card style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder="Search by name or WhatsApp number..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          allowClear
          style={{ maxWidth: 360 }}
        />
      </Card>

      <Card>
        <Table
          dataSource={clients}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          pagination={{
            current: page,
            pageSize: 20,
            onChange: setPage,
          }}
          onRow={(row) => ({ onClick: () => navigate(`/clients/${row.id}`) })}
          rowHoverable
          style={{ cursor: 'pointer' }}
          size="middle"
        />
      </Card>
    </div>
  )
}

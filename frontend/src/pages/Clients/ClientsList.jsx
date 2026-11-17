import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Table, Card, Input } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { listClients } from '../../api/clients.js'
import { pagedTotal } from '../../utils/pagination.js'

const PAGE_SIZE = 20

export default function ClientsList() {
  const navigate = useNavigate()
  const [page, setPage]     = useState(1)
  const [search, setSearch] = useState('')

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['clients', { page, search }],
    queryFn: () => listClients({ page, limit: PAGE_SIZE, search: search || undefined }),
    placeholderData: (prev) => prev,
  })

  const clients = data?.items ?? []
  const total = pagedTotal(data, clients, page, PAGE_SIZE)

  const columns = [
    {
      title: 'Client',
      key: 'name',
      render: (_, r) => (
        <div>
          <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{r.name ?? '—'}</div>
          <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
            {r.whatsapp_number}
            {r.customer_number && <span className="braq-ref" style={{ marginLeft: 8, fontSize: 12, color: 'var(--ink-3)' }}>{r.customer_number}</span>}
          </div>
        </div>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'client_type',
      render: (v) => v ? <span className="braq-pill" style={{ textTransform: 'capitalize' }}>{v}</span> : '—',
    },
    {
      title: 'Organisation or school',
      render: (_, r) => r.organisation ?? r.school_name ?? <span style={{ color: 'var(--ink-3)' }}>—</span>,
    },
    {
      title: 'Profile',
      dataIndex: 'profile_complete',
      render: (v) => <span className={`braq-pill ${v ? 'green' : 'amber'}`}>{v ? 'Complete' : 'Missing details'}</span>,
    },
    {
      title: 'Joined',
      dataIndex: 'created_at',
      render: (v) => <span style={{ fontSize: 13, color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{dayjs(v).format('D MMM YYYY')}</span>,
    },
  ]

  return (
    <div>
      <div className="braq-page-header">
        <div>
          <h1 className="braq-page-title">Clients</h1>
          <div className="braq-page-subtitle">Everyone who has contacted Braq on WhatsApp. Open a client to see their orders and quotations.</div>
        </div>
        <Input
          prefix={<SearchOutlined style={{ color: 'var(--ink-3)' }} />}
          placeholder="Search by name or WhatsApp number"
          aria-label="Search clients"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
          allowClear
          style={{ flex: '1 1 240px', maxWidth: 320 }}
        />
      </div>

      <Card styles={{ body: { padding: 0 } }} style={{ overflow: 'hidden' }}>
        <Table
          dataSource={clients}
          columns={columns}
          rowKey="id"
          loading={isLoading || isFetching}
          pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
          scroll={{ x: 'max-content' }}
          size="middle"
          locale={{ emptyText: search ? `No clients match "${search}". Check the spelling or search by WhatsApp number.` : 'No clients yet. Clients are added when they first message Braq on WhatsApp.' }}
          onRow={r => ({
            onClick: () => navigate(`/clients/${r.id}`),
            onKeyDown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) navigate(`/clients/${r.id}`) },
            tabIndex: 0,
            style: { cursor: 'pointer' },
          })}
        />
      </Card>
    </div>
  )
}

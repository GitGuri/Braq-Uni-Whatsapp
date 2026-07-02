import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Table, Card, Typography, Tag, Button, Space } from 'antd'
import { FilePdfOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { listQuotations, getPdfUrl } from '../../api/quotations.js'

const { Title } = Typography

const STATUS_COLORS = {
  draft: 'default',
  sent: 'blue',
  accepted: 'success',
  rejected: 'error',
}

export default function QuotationsList() {
  const navigate = useNavigate()

  const { data, isLoading } = useQuery({
    queryKey: ['quotations'],
    queryFn: () => listQuotations({ limit: 50 }),
  })

  const quotations = data?.quotations ?? []

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
      title: 'Order Ref',
      dataIndex: 'order_reference',
      key: 'order_reference',
      render: (ref, row) =>
        ref ? (
          <a onClick={() => navigate(`/orders/${row.order_id}`)}>{ref}</a>
        ) : '—',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (s) => (
        <Tag color={STATUS_COLORS[s] ?? 'default'}>
          {s?.charAt(0).toUpperCase() + s?.slice(1)}
        </Tag>
      ),
    },
    {
      title: 'Total',
      dataIndex: 'total_amount',
      key: 'total_amount',
      render: (v) => v != null ? `R ${Number(v).toFixed(2)}` : '—',
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v) => dayjs(v).format('DD MMM YYYY'),
    },
    {
      title: 'PDF',
      key: 'pdf',
      render: (_, row) => (
        <Button
          size="small"
          icon={<FilePdfOutlined />}
          href={getPdfUrl(row.id)}
          target="_blank"
          rel="noopener noreferrer"
        >
          PDF
        </Button>
      ),
    },
  ]

  return (
    <div>
      <Title level={4} style={{ marginBottom: 16 }}>Quotations</Title>
      <Card>
        <Table
          dataSource={quotations}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          size="middle"
          pagination={{ pageSize: 20 }}
        />
      </Card>
    </div>
  )
}

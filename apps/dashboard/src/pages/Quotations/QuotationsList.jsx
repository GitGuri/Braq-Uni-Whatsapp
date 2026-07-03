import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Table, Card, Typography, Tag, Button, Tooltip, Badge } from 'antd'
import { FilePdfOutlined, WarningOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { listQuotations, getPdfUrl } from '../../api/quotations.js'

const { Title, Text } = Typography

const STATUS_CONFIG = {
  draft:    { color: 'orange',  label: 'Draft — needs pricing' },
  sent:     { color: 'blue',    label: 'Sent' },
  accepted: { color: 'success', label: 'Accepted' },
  rejected: { color: 'error',   label: 'Rejected' },
  expired:  { color: 'default', label: 'Expired' },
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
      title: 'Reference',
      dataIndex: 'reference',
      key: 'reference',
      render: (ref) => <Text strong style={{ fontFamily: 'monospace', fontSize: 12 }}>{ref ?? '—'}</Text>,
    },
    {
      title: 'Client',
      key: 'client',
      render: (_, row) => row.client_name ?? row.client_wa ?? '—',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (s) => {
        const cfg = STATUS_CONFIG[s] ?? { color: 'default', label: s }
        return (
          <Tag color={cfg.color} icon={s === 'draft' ? <WarningOutlined /> : undefined}>
            {cfg.label}
          </Tag>
        )
      },
    },
    {
      title: 'Items',
      key: 'items',
      render: (_, row) => {
        const items = Array.isArray(row.line_items) ? row.line_items : []
        const unmatched = items.filter((i) => !i.productId).length
        return (
          <span>
            {items.length} item{items.length !== 1 ? 's' : ''}
            {unmatched > 0 && (
              <Tooltip title={`${unmatched} item(s) need manual pricing`}>
                <Badge count={unmatched} size="small" style={{ marginLeft: 6, backgroundColor: '#faad14' }} />
              </Tooltip>
            )}
          </span>
        )
      },
    },
    {
      title: 'Total (incl. VAT)',
      dataIndex: 'total',
      key: 'total',
      render: (v) => v != null ? <Text strong>R {Number(v).toFixed(2)}</Text> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Valid Until',
      dataIndex: 'valid_until',
      key: 'valid_until',
      render: (v) => {
        if (!v) return '—'
        const expired = dayjs(v).isBefore(dayjs())
        return (
          <Text type={expired ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
            {dayjs(v).format('DD MMM YYYY')}
            {expired && ' (expired)'}
          </Text>
        )
      },
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v) => <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).format('DD MMM YYYY')}</Text>,
    },
    {
      title: 'PDF',
      key: 'pdf',
      render: (_, row) => {
        const isDraft = row.status === 'draft'
        return (
          <Tooltip title={isDraft ? 'PDF unavailable — quotation needs manual pricing first' : 'Download PDF'}>
            <Button
              size="small"
              icon={<FilePdfOutlined />}
              href={isDraft ? undefined : getPdfUrl(row.id)}
              target="_blank"
              rel="noopener noreferrer"
              disabled={isDraft}
            >
              PDF
            </Button>
          </Tooltip>
        )
      },
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
          rowClassName={(row) => row.status === 'draft' ? 'row-draft' : ''}
        />
      </Card>
    </div>
  )
}

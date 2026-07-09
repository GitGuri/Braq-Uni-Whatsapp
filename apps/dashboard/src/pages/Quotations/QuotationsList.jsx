import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table, Tag, Typography, Button, Space, Modal, Form, Input,
  Select, Segmented, Card, message,
} from 'antd'
import { SwapOutlined, UserOutlined, FilePdfOutlined, EditOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime.js'
import { listQuotations, claimQuotation } from '../../api/quotations.js'
import { convertFromQuotation } from '../../api/orders.js'

dayjs.extend(relativeTime)

const { Text } = Typography

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'

export default function QuotationsList() {
  const navigate   = useNavigate()
  const qc         = useQueryClient()
  const [status, setStatus]         = useState('all')
  const [convertingId, setConvertingId] = useState(null)
  const [convertForm] = Form.useForm()
  const [msgApi, ctx] = message.useMessage()

  const { data, isLoading } = useQuery({
    queryKey: ['quotations', status],
    queryFn:  () => listQuotations(status !== 'all' ? { status } : {}),
  })

  const claimMutation = useMutation({
    mutationFn: (id) => claimQuotation(id),
    onSuccess: () => {
      msgApi.success('Quotation claimed!')
      qc.invalidateQueries({ queryKey: ['quotations'] })
      qc.invalidateQueries({ queryKey: ['dashboard-kpis'] })
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Claim failed'),
  })

  const convertMutation = useMutation({
    mutationFn: ({ id, vals }) => convertFromQuotation(id, vals),
    onSuccess: (res) => {
      msgApi.success(`Order ${res.order.reference} created`)
      setConvertingId(null)
      qc.invalidateQueries({ queryKey: ['quotations'] })
      navigate(`/orders/${res.order.id}`)
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Conversion failed'),
  })

  const quotations = data?.quotations ?? []

  const columns = [
    {
      title: 'Reference',
      dataIndex: 'reference',
      render: (v) => <Text strong style={{ fontFamily: 'monospace' }}>{v}</Text>,
    },
    {
      title: 'Client',
      render: (_, r) => (
        <div>
          <Text strong style={{ fontSize: 13 }}>{r.client_name ?? '—'}</Text>
          {r.client_org && (
            <div><Text type="secondary" style={{ fontSize: 11 }}>{r.client_org}</Text></div>
          )}
        </div>
      ),
    },
    {
      title: 'Total',
      dataIndex: 'total',
      render: (v) => v != null ? `R ${Number(v).toFixed(2)}` : '—',
    },
    {
      title: 'SLA',
      render: (_, r) => {
        if (r.status !== 'draft' || !r.sla_remind_at) return '—'
        const over = dayjs(r.sla_remind_at).isBefore(dayjs())
        return (
          <Text style={{ color: over ? '#cf1322' : '#d46b08', fontSize: 12 }}>
            {over ? '⚠ Overdue' : `Due ${dayjs(r.sla_remind_at).fromNow()}`}
          </Text>
        )
      },
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      render: (v) => <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).format('DD MMM YYYY')}</Text>,
    },
    {
      title: 'Assigned',
      dataIndex: 'assigned_name',
      render: (v, r) =>
        v ? (
          <Space size={4}>
            <UserOutlined style={{ color: '#999' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text>
          </Space>
        ) : (
          <Button
            size="small"
            loading={claimMutation.isPending && claimMutation.variables === r.id}
            onClick={(e) => { e.stopPropagation(); claimMutation.mutate(r.id) }}
          >
            Claim
          </Button>
        ),
    },
    {
      title: 'PDF',
      key: 'pdf',
      width: 100,
      render: (_, r) =>
        r.status !== 'draft' ? (
          <Button
            size="small"
            icon={<FilePdfOutlined />}
            onClick={() => window.open(`${API_BASE}/quotations/${r.id}/pdf`, '_blank')}
            style={{ fontSize: 12 }}
          >
            View PDF
          </Button>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>Pending</Text>
        ),
    },
    {
      title: 'Actions',
      render: (_, r) => (
        <Space size="small">
          {r.status === 'draft' && (
            <Button
              size="small"
              type="primary"
              icon={<EditOutlined />}
              onClick={() => navigate(`/quotations/${r.id}/build`)}
            >
              Build Quotation
            </Button>
          )}
          {r.status === 'accepted' && !r.order_id && (
            <Button
              size="small"
              icon={<SwapOutlined />}
              onClick={() => { setConvertingId(r.id); convertForm.resetFields() }}
            >
              Convert to Order
            </Button>
          )}
          {r.order_id && (
            <Button size="small" type="link" onClick={() => navigate(`/orders/${r.order_id}`)}>
              View Order →
            </Button>
          )}
        </Space>
      ),
    },
  ]

  return (
    <>
      {ctx}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Text style={{ fontSize: 18, fontWeight: 700 }}>Quotations</Text>
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            { label: 'All',      value: 'all' },
            { label: 'Draft',    value: 'draft' },
            { label: 'Sent',     value: 'sent' },
            { label: 'Accepted', value: 'accepted' },
            { label: 'Rejected', value: 'rejected' },
          ]}
        />
      </div>

      <Card styles={{ body: { padding: 0 } }} style={{ borderRadius: 10 }}>
        <Table
          dataSource={quotations}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          size="middle"
        />
      </Card>

      {/* Convert to Order Modal */}
      <Modal
        title="Convert to Order"
        open={!!convertingId}
        onCancel={() => setConvertingId(null)}
        onOk={() => convertMutation.mutate({ id: convertingId, vals: convertForm.getFieldsValue() })}
        okText="Create Order"
        okButtonProps={{ loading: convertMutation.isPending }}
      >
        <Form form={convertForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="PO Number (optional)" name="poNumber">
            <Input placeholder="Client's purchase order reference" />
          </Form.Item>
        </Form>
        <Text type="secondary" style={{ fontSize: 13 }}>
          An order will be created at stage <strong>Quotation Requested</strong> with a{' '}
          <strong>60% deposit</strong> pre-calculated from the quotation total.
        </Text>
      </Modal>
    </>
  )
}

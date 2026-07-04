import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table, Tag, Typography, Button, Space, Modal, Form, Input, InputNumber,
  Select, Segmented, Card, Row, Col, message,
} from 'antd'
import { CheckOutlined, PlusOutlined, SwapOutlined, DeleteOutlined, UserOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime.js'
import { listQuotations, approveQuotation, claimQuotation } from '../../api/quotations.js'
import { convertFromQuotation } from '../../api/orders.js'
import { useAuth } from '../../auth/AuthContext.jsx'

dayjs.extend(relativeTime)

const { Text } = Typography

const STATUS_COLORS = {
  draft: 'orange', sent: 'blue', accepted: 'green', rejected: 'red', expired: 'default',
}

export default function QuotationsList() {
  const navigate  = useNavigate()
  const qc        = useQueryClient()
  const { staff } = useAuth()
  const [status, setStatus] = useState('all')
  const [approvingId, setApprovingId]   = useState(null)
  const [convertingId, setConvertingId] = useState(null)
  const [editedItems, setEditedItems]   = useState([])
  const [convertForm] = Form.useForm()
  const [msgApi, ctx] = message.useMessage()

  const { data, isLoading } = useQuery({
    queryKey: ['quotations', status],
    queryFn:  () => listQuotations(status !== 'all' ? { status } : {}),
  })

  const approveMutation = useMutation({
    mutationFn: ({ id, items }) => approveQuotation(id, items),
    onSuccess: () => {
      msgApi.success('Approved — PDF sent to client via WhatsApp')
      setApprovingId(null)
      qc.invalidateQueries({ queryKey: ['quotations'] })
      qc.invalidateQueries({ queryKey: ['dashboard-kpis'] })
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Approval failed'),
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

  function openApprove(q) {
    setApprovingId(q.id)
    setEditedItems((q.line_items ?? []).map(i => ({ ...i })))
  }

  function updateItem(idx, field, value) {
    setEditedItems(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], [field]: value }
      const p   = Number(next[idx].price ?? 0)
      const qty = Number(next[idx].quantity ?? 0)
      next[idx].lineTotal = parseFloat((p * qty).toFixed(2))
      return next
    })
  }

  const approving  = quotations.find(q => q.id === approvingId)
  const subtotal   = editedItems.reduce((s, i) => s + Number(i.lineTotal ?? 0), 0)
  const vat        = parseFloat((subtotal * 0.15).toFixed(2))
  const total      = subtotal + vat

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
          {r.client_org && <div><Text type="secondary" style={{ fontSize: 11 }}>{r.client_org}</Text></div>}
        </div>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      render: (s) => <Tag color={STATUS_COLORS[s] ?? 'default'}>{s}</Tag>,
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
      title: 'Actions',
      render: (_, r) => (
        <Space size="small">
          {r.status === 'draft' && (
            <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => openApprove(r)}>
              Price &amp; Approve
            </Button>
          )}
          {r.status === 'accepted' && !r.order_id && (
            <Button
              size="small" icon={<SwapOutlined />}
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
            { label: 'All', value: 'all' },
            { label: 'Draft', value: 'draft' },
            { label: 'Sent', value: 'sent' },
            { label: 'Accepted', value: 'accepted' },
            { label: 'Rejected', value: 'rejected' },
          ]}
        />
      </div>

      <Card bodyStyle={{ padding: 0 }} style={{ borderRadius: 10 }}>
        <Table
          dataSource={quotations}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          size="middle"
        />
      </Card>

      {/* Price & Approve Modal */}
      <Modal
        title={`Approve Quotation — ${approving?.reference}`}
        open={!!approvingId}
        onCancel={() => setApprovingId(null)}
        onOk={() => approveMutation.mutate({ id: approvingId, items: editedItems })}
        okText="Approve & Send PDF"
        okButtonProps={{ loading: approveMutation.isPending }}
        width={760}
      >
        <Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 12 }}>
          Review and adjust pricing below. AI-estimated items are flagged — confirm before approving.
        </Text>

        <Row gutter={4} style={{ marginBottom: 6 }}>
          <Col span={9}><Text type="secondary" style={{ fontSize: 12 }}>Item</Text></Col>
          <Col span={4}><Text type="secondary" style={{ fontSize: 12 }}>Qty</Text></Col>
          <Col span={5}><Text type="secondary" style={{ fontSize: 12 }}>Unit Price</Text></Col>
          <Col span={5}><Text type="secondary" style={{ fontSize: 12 }}>Line Total</Text></Col>
        </Row>

        {editedItems.map((item, idx) => (
          <Row key={idx} gutter={4} style={{ marginBottom: 8, alignItems: 'flex-start' }}>
            <Col span={9}>
              <Input
                size="small"
                value={item.name ?? item.description ?? ''}
                onChange={e => updateItem(idx, 'name', e.target.value)}
              />
              {item.aiSuggested && !item.priceConfirmed && (
                <Text style={{ fontSize: 11, color: '#d46b08' }}>AI estimate ({item.confidence})</Text>
              )}
            </Col>
            <Col span={4}>
              <InputNumber
                size="small" min={1} style={{ width: '100%' }}
                value={item.quantity}
                onChange={v => updateItem(idx, 'quantity', v)}
              />
            </Col>
            <Col span={5}>
              <InputNumber
                size="small" min={0} prefix="R" style={{ width: '100%' }} step={0.5}
                value={item.price}
                onChange={v => updateItem(idx, 'price', v)}
              />
            </Col>
            <Col span={5}>
              <Input
                size="small"
                value={`R ${Number(item.lineTotal ?? 0).toFixed(2)}`}
                readOnly style={{ background: '#f5f5f5' }}
              />
            </Col>
            <Col span={1}>
              <Button
                size="small" danger type="text" icon={<DeleteOutlined />}
                onClick={() => setEditedItems(p => p.filter((_, i) => i !== idx))}
              />
            </Col>
          </Row>
        ))}

        <Button
          icon={<PlusOutlined />} size="small" style={{ marginBottom: 16 }}
          onClick={() => setEditedItems(p => [...p, { name: '', quantity: 1, price: 0, lineTotal: 0, priceConfirmed: true }])}
        >
          Add line item
        </Button>

        <div style={{ textAlign: 'right', borderTop: '1px solid #f0f0f0', paddingTop: 12 }}>
          <Text type="secondary">Subtotal: R {subtotal.toFixed(2)}</Text><br />
          <Text type="secondary">VAT (15%): R {vat.toFixed(2)}</Text><br />
          <Text strong style={{ fontSize: 15 }}>Total: R {total.toFixed(2)}</Text>
        </div>
      </Modal>

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
          An order will be created at stage <strong>Quotation Requested</strong> with a 50% deposit pre-calculated from the quotation total.
        </Text>
      </Modal>
    </>
  )
}

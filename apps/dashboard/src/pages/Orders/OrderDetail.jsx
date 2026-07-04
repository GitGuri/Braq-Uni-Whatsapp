import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Card, Descriptions, Button, Tag, Space, Typography, Modal, Form, Input,
  Select, InputNumber, Table, Spin, message, Divider, Row, Col, Switch, Alert,
} from 'antd'
import {
  ArrowRightOutlined, DollarOutlined, StopOutlined, UserOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { getOrder, advanceStage, setHold, recordPayment, assignOrder } from '../../api/orders.js'

const { Text, Title } = Typography

const STAGES = [
  'quotation_requested', 'quotation_submitted', 'po_received',
  'materials_procurement', 'production_scheduled', 'manufacturing',
  'branding_embroidery', 'quality_control', 'packing_dispatch', 'completed',
]

const STAGE_LABELS = {
  quotation_requested:   '1. Quotation Requested',
  quotation_submitted:   '2. Quotation Submitted',
  po_received:           '3. PO Received',
  materials_procurement: '4. Materials Procurement',
  production_scheduled:  '5. Production Scheduled',
  manufacturing:         '6. Manufacturing',
  branding_embroidery:   '7. Branding & Embroidery',
  quality_control:       '8. Quality Control',
  packing_dispatch:      '9. Packing & Dispatch',
  completed:             '10. Completed',
}

const STAGE_COLORS = {
  quotation_requested: 'default', quotation_submitted: 'blue',
  po_received: 'cyan', materials_procurement: 'geekblue',
  production_scheduled: 'purple', manufacturing: 'magenta',
  branding_embroidery: 'volcano', quality_control: 'orange',
  packing_dispatch: 'gold', completed: 'green',
}

export default function OrderDetail() {
  const { id }    = useParams()
  const navigate  = useNavigate()
  const qc        = useQueryClient()
  const [advanceModal, setAdvanceModal]   = useState(false)
  const [paymentModal, setPaymentModal]   = useState(false)
  const [holdModal, setHoldModal]         = useState(false)
  const [advanceForm] = Form.useForm()
  const [paymentForm] = Form.useForm()
  const [holdForm]    = Form.useForm()
  const [msgApi, ctx] = message.useMessage()

  const { data, isLoading } = useQuery({
    queryKey: ['order', id],
    queryFn: () => getOrder(id),
  })

  const advanceMutation = useMutation({
    mutationFn: (vals) => advanceStage(id, vals),
    onSuccess: (res) => {
      msgApi.success(`Moved to: ${STAGE_LABELS[res.to] ?? res.to}`)
      setAdvanceModal(false)
      qc.invalidateQueries({ queryKey: ['order', id] })
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Advance failed'),
  })

  const holdMutation = useMutation({
    mutationFn: (vals) => setHold(id, vals),
    onSuccess: () => {
      setHoldModal(false)
      qc.invalidateQueries({ queryKey: ['order', id] })
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Failed'),
  })

  const paymentMutation = useMutation({
    mutationFn: (vals) => recordPayment(id, vals),
    onSuccess: () => {
      msgApi.success('Payment recorded')
      setPaymentModal(false)
      qc.invalidateQueries({ queryKey: ['order', id] })
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Failed'),
  })

  if (isLoading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>

  const order    = data?.order
  const payments = data?.payments ?? []
  if (!order) return <Text type="danger">Order not found.</Text>

  const stageIdx    = STAGES.indexOf(order.stage)
  const nextStageName = stageIdx >= 0 && stageIdx < STAGES.length - 1 ? STAGES[stageIdx + 1] : null
  const isCompleted = order.stage === 'completed'

  const lineItems = (() => {
    try {
      const q = data?.quotation
      if (q?.line_items) return Array.isArray(q.line_items) ? q.line_items : []
    } catch {}
    return []
  })()

  const paymentCols = [
    { title: 'Type', dataIndex: 'type', render: (v) => <Tag>{v}</Tag> },
    { title: 'Amount', dataIndex: 'amount', render: (v) => `R ${Number(v).toFixed(2)}` },
    { title: 'Currency', dataIndex: 'currency' },
    { title: 'Notes', dataIndex: 'notes', render: (v) => v ?? '—' },
    { title: 'Date', dataIndex: 'created_at', render: (v) => dayjs(v).format('DD MMM YYYY HH:mm') },
  ]

  return (
    <>
      {ctx}
      <Button type="link" onClick={() => navigate(-1)} style={{ paddingLeft: 0, marginBottom: 12 }}>
        ← Back to Orders
      </Button>

      {order.is_on_hold && (
        <Alert
          type="warning"
          showIcon
          message={`Order on hold${order.hold_reason ? ` — ${order.hold_reason}` : ''}`}
          style={{ marginBottom: 16, borderRadius: 8 }}
        />
      )}

      <Row gutter={[16, 16]}>
        {/* Order info */}
        <Col span={16}>
          <Card
            title={
              <Space>
                <Text strong style={{ fontSize: 16 }}>{order.reference}</Text>
                <Tag color={STAGE_COLORS[order.stage] ?? 'default'} style={{ fontSize: 12 }}>
                  {STAGE_LABELS[order.stage] ?? order.stage}
                </Tag>
              </Space>
            }
            extra={
              <Space>
                {!isCompleted && !order.is_on_hold && (
                  <Button type="primary" icon={<ArrowRightOutlined />} onClick={() => setAdvanceModal(true)}>
                    Advance Stage
                  </Button>
                )}
                <Button
                  icon={<StopOutlined />}
                  danger={!order.is_on_hold}
                  onClick={() => { holdForm.resetFields(); setHoldModal(true) }}
                >
                  {order.is_on_hold ? 'Release Hold' : 'Put on Hold'}
                </Button>
              </Space>
            }
            style={{ borderRadius: 10 }}
          >
            <Descriptions column={2} size="small">
              <Descriptions.Item label="Client">{order.client_name ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Organisation">{order.organisation ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Client Type"><Tag>{order.client_type}</Tag></Descriptions.Item>
              <Descriptions.Item label="PO Number">{order.po_number ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Tracking Number">{order.tracking_number ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Est. Completion">
                {order.estimated_completion_date ? dayjs(order.estimated_completion_date).format('DD MMM YYYY') : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Payment Status">
                <Tag color={
                  order.payment_status === 'paid_in_full' ? 'green'
                  : order.payment_status === 'deposit_paid' ? 'orange' : 'default'
                }>
                  {order.payment_status?.replace(/_/g, ' ')}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Created">{dayjs(order.created_at).format('DD MMM YYYY HH:mm')}</Descriptions.Item>
            </Descriptions>
          </Card>

          {/* Stage progress bar */}
          <Card style={{ marginTop: 16, borderRadius: 10 }}>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'nowrap', overflowX: 'auto' }}>
              {STAGES.map((s, i) => {
                const done    = i < stageIdx
                const current = i === stageIdx
                return (
                  <div
                    key={s}
                    style={{
                      flex: '1 1 0', minWidth: 60, textAlign: 'center', padding: '6px 4px',
                      background: current ? '#1677ff' : done ? '#e6f4ff' : '#f5f5f5',
                      borderRadius: 6,
                    }}
                  >
                    <Text style={{ fontSize: 10, color: current ? '#fff' : done ? '#1677ff' : '#aaa', fontWeight: current ? 700 : 400 }}>
                      {i + 1}
                    </Text>
                  </div>
                )
              })}
            </div>
            <Text type="secondary" style={{ fontSize: 12, marginTop: 6, display: 'block' }}>
              Step {stageIdx + 1} of {STAGES.length}: {STAGE_LABELS[order.stage]}
            </Text>
          </Card>

          {/* Line items from quotation */}
          {lineItems.length > 0 && (
            <Card title="Line Items" style={{ marginTop: 16, borderRadius: 10 }}>
              <Table
                dataSource={lineItems}
                rowKey={(r, i) => i}
                size="small"
                pagination={false}
                columns={[
                  { title: 'Item', render: (_, r) => r.name ?? r.description },
                  { title: 'Qty', dataIndex: 'quantity' },
                  { title: 'Sizes', dataIndex: 'sizes', render: v => v ?? '—' },
                  { title: 'Unit Price', dataIndex: 'price', render: v => `R ${Number(v).toFixed(2)}` },
                  { title: 'Total', dataIndex: 'lineTotal', render: v => `R ${Number(v).toFixed(2)}` },
                ]}
              />
            </Card>
          )}
        </Col>

        {/* Payments sidebar */}
        <Col span={8}>
          <Card
            title="Payments"
            extra={
              <Button size="small" icon={<DollarOutlined />} onClick={() => { paymentForm.resetFields(); setPaymentModal(true) }}>
                Record
              </Button>
            }
            style={{ borderRadius: 10 }}
          >
            {order.deposit_amount && (
              <div style={{ marginBottom: 12 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>Deposit (50%)</Text>
                <div><Text strong>R {Number(order.deposit_amount).toFixed(2)}</Text></div>
                <Text type="secondary" style={{ fontSize: 12 }}>Balance</Text>
                <div><Text strong>R {Number(order.balance_amount ?? 0).toFixed(2)}</Text></div>
              </div>
            )}
            <Divider style={{ margin: '8px 0' }} />
            {payments.length === 0 ? (
              <Text type="secondary" style={{ fontSize: 13 }}>No payments recorded yet.</Text>
            ) : (
              payments.map(p => (
                <div key={p.id} style={{ marginBottom: 10 }}>
                  <Space>
                    <Tag>{p.type}</Tag>
                    <Text strong>R {Number(p.amount).toFixed(2)}</Text>
                  </Space>
                  <div><Text type="secondary" style={{ fontSize: 11 }}>{dayjs(p.created_at).format('DD MMM YYYY')}</Text></div>
                  {p.notes && <Text type="secondary" style={{ fontSize: 12 }}>{p.notes}</Text>}
                </div>
              ))
            )}
          </Card>
        </Col>
      </Row>

      {/* Advance Stage Modal */}
      <Modal
        title={`Advance to: ${nextStageName ? STAGE_LABELS[nextStageName] : '—'}`}
        open={advanceModal}
        onCancel={() => setAdvanceModal(false)}
        onOk={() => advanceMutation.mutate(advanceForm.getFieldsValue())}
        okText="Advance"
        okButtonProps={{ loading: advanceMutation.isPending }}
      >
        <Form form={advanceForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item label="Notes (optional)" name="notes">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="Estimated Completion Date" name="estimatedCompletion">
            <Input type="date" />
          </Form.Item>
          {nextStageName === 'packing_dispatch' && (
            <Form.Item label="Tracking Number" name="trackingNumber">
              <Input placeholder="Courier tracking number" />
            </Form.Item>
          )}
          {nextStageName === 'completed' && (
            <Form.Item label="Delivery Type" name="deliveryType" initialValue="collection">
              <Select options={[
                { value: 'collection', label: 'Collection' },
                { value: 'delivery', label: 'Delivery' },
              ]} />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* Hold Modal */}
      <Modal
        title={order.is_on_hold ? 'Release Hold' : 'Put Order on Hold'}
        open={holdModal}
        onCancel={() => setHoldModal(false)}
        onOk={() => holdMutation.mutate({ isOnHold: !order.is_on_hold, holdReason: holdForm.getFieldValue('holdReason') })}
        okText={order.is_on_hold ? 'Release' : 'Hold'}
        okButtonProps={{ loading: holdMutation.isPending, danger: !order.is_on_hold }}
      >
        {!order.is_on_hold && (
          <Form form={holdForm} layout="vertical" style={{ marginTop: 12 }}>
            <Form.Item label="Reason" name="holdReason">
              <Select
                placeholder="Select reason"
                options={[
                  { value: 'supplier_delay', label: 'Supplier Delay (auto-notifies client)' },
                  { value: 'payment_outstanding', label: 'Payment Outstanding' },
                  { value: 'design_revision', label: 'Design Revision' },
                  { value: 'client_request', label: 'Client Request' },
                  { value: 'other', label: 'Other' },
                ]}
              />
            </Form.Item>
          </Form>
        )}
        {order.is_on_hold && (
          <Text>Are you sure you want to release the hold on this order?</Text>
        )}
      </Modal>

      {/* Record Payment Modal */}
      <Modal
        title="Record Payment"
        open={paymentModal}
        onCancel={() => setPaymentModal(false)}
        onOk={() => paymentMutation.mutate(paymentForm.getFieldsValue())}
        okText="Record Payment"
        okButtonProps={{ loading: paymentMutation.isPending }}
      >
        <Form form={paymentForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item label="Payment Type" name="type" rules={[{ required: true }]}>
            <Select options={[
              { value: 'deposit', label: 'Deposit' },
              { value: 'balance', label: 'Balance' },
              { value: 'full', label: 'Full Payment' },
            ]} />
          </Form.Item>
          <Form.Item label="Amount (R)" name="amount" rules={[{ required: true }]}>
            <InputNumber min={0} step={0.01} style={{ width: '100%' }} prefix="R" />
          </Form.Item>
          <Form.Item label="Notes (optional)" name="notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

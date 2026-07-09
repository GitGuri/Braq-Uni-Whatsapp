import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Card, Descriptions, Button, Tag, Space, Typography, Modal, Form, Input,
  Select, InputNumber, Table, Spin, message, Divider, Row, Col, Alert,
  Badge,
} from 'antd'
import {
  ArrowRightOutlined, DollarOutlined, StopOutlined, FilePdfOutlined,
  CheckCircleOutlined, EditOutlined, SendOutlined, ExperimentOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { getOrder, advanceStage, setHold, recordPayment, updateMaterials, sendProof, updateProofStatus } from '../../api/orders.js'

const { Text, Title } = Typography

const STAGES = ['deposit_pending', 'in_production', 'ready', 'completed']

const STAGE_LABELS = {
  deposit_pending: '1. Awaiting Deposit',
  in_production:   '2. In Production',
  ready:           '3. Ready / Dispatched',
  completed:       '4. Completed',
}

const STAGE_COLORS = {
  deposit_pending: 'orange',
  in_production:   'blue',
  ready:           'gold',
  completed:       'green',
}

const STAGE_DESCRIPTIONS = {
  deposit_pending: 'Order placed — awaiting 60% deposit to begin production',
  in_production:   'Deposit received — manufacturing & branding underway',
  ready:           'Production complete — ready for collection or dispatched',
  completed:       'Order collected / delivered — all done',
}

export default function OrderDetail() {
  const { id }    = useParams()
  const navigate  = useNavigate()
  const qc        = useQueryClient()
  const [advanceModal, setAdvanceModal]   = useState(false)
  const [paymentModal, setPaymentModal]   = useState(false)
  const [holdModal, setHoldModal]         = useState(false)
  const [proofModal, setProofModal]       = useState(false)
  const [materialsModal, setMaterialsModal] = useState(false)
  const [advanceForm]   = Form.useForm()
  const [paymentForm]   = Form.useForm()
  const [holdForm]      = Form.useForm()
  const [proofForm]     = Form.useForm()
  const [materialsForm] = Form.useForm()
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

  const proofMutation = useMutation({
    mutationFn: (vals) => sendProof(id, vals),
    onSuccess: () => {
      msgApi.success('Proof sent to client via WhatsApp')
      setProofModal(false)
      proofForm.resetFields()
      qc.invalidateQueries({ queryKey: ['order', id] })
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Failed to send proof'),
  })

  const proofStatusMutation = useMutation({
    mutationFn: (vals) => updateProofStatus(id, vals),
    onSuccess: () => {
      msgApi.success('Proof status updated')
      qc.invalidateQueries({ queryKey: ['order', id] })
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Failed'),
  })

  const materialsMutation = useMutation({
    mutationFn: (vals) => updateMaterials(id, vals),
    onSuccess: () => {
      msgApi.success('Material notes saved')
      setMaterialsModal(false)
      qc.invalidateQueries({ queryKey: ['order', id] })
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Failed to save notes'),
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
      const items = order?.quotation_line_items
      if (!items) return []
      return Array.isArray(items) ? items : JSON.parse(items)
    } catch {
      return []
    }
  })()

  const materialNotes = (() => {
    try {
      const raw = order?.material_notes
      if (!raw) return {}
      return typeof raw === 'object' ? raw : JSON.parse(raw)
    } catch { return {} }
  })()

  const PROOF_STATUS_COLOR = { none: 'default', sent: 'processing', approved: 'success', revision_requested: 'warning' }
  const PROOF_STATUS_LABEL = { none: 'No Proof', sent: 'Awaiting Approval', approved: 'Approved', revision_requested: 'Revision Requested' }

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
                {lineItems.length > 0 && (
                  <Button
                    icon={<FilePdfOutlined />}
                    href={`/api/orders/${id}/size-run-sheet`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Size Run Sheet
                  </Button>
                )}
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
            <div style={{ display: 'flex', gap: 6 }}>
              {STAGES.map((s, i) => {
                const done    = i < stageIdx
                const current = i === stageIdx
                return (
                  <div key={s} style={{ flex: 1, textAlign: 'center' }}>
                    <div style={{
                      padding: '10px 6px 8px',
                      background: current ? '#c0392b' : done ? '#2d2d2d' : '#1a1a1a',
                      borderRadius: 8,
                      border: current ? '2px solid #c0392b' : done ? '1px solid #333' : '1px solid #222',
                    }}>
                      <div style={{
                        fontSize: 18, fontWeight: 700, lineHeight: 1,
                        color: current ? '#fff' : done ? '#aaa' : '#444',
                      }}>{i + 1}</div>
                      <div style={{
                        fontSize: 10, marginTop: 4, lineHeight: 1.2,
                        color: current ? '#ffccc7' : done ? '#666' : '#333',
                      }}>
                        {STAGE_LABELS[s].replace(/^\d+\.\s*/, '')}
                      </div>
                    </div>
                    {i < STAGES.length - 1 && (
                      <div style={{
                        position: 'absolute', display: 'none', // connector handled by gap
                      }} />
                    )}
                  </div>
                )
              })}
            </div>
            <Text type="secondary" style={{ fontSize: 12, marginTop: 10, display: 'block' }}>
              Stage {stageIdx + 1} of {STAGES.length}: <Text style={{ fontSize: 12 }}>{STAGE_DESCRIPTIONS[order.stage] ?? STAGE_LABELS[order.stage]}</Text>
            </Text>
          </Card>

          {/* Line items from quotation */}
          {lineItems.length > 0 && (
            <>
              <Card title="Line Items" style={{ marginTop: 16, borderRadius: 10 }}>
                <Table
                  dataSource={lineItems}
                  rowKey={(_, i) => i}
                  size="small"
                  pagination={false}
                  columns={[
                    {
                      title: 'Item',
                      render: (_, r) => (
                        <div>
                          <Text strong style={{ fontSize: 13 }}>{r.name ?? r.description}</Text>
                          {r.colour && <Tag style={{ marginLeft: 6 }}>{r.colour}</Tag>}
                        </div>
                      ),
                    },
                    { title: 'Qty', dataIndex: 'quantity', width: 60 },
                    {
                      title: 'Unit Price',
                      width: 100,
                      render: (_, r) => `R ${Number(r.effectiveUnitPrice ?? r.price ?? 0).toFixed(2)}`,
                    },
                    {
                      title: 'Total',
                      dataIndex: 'lineTotal',
                      width: 110,
                      render: v => <Text strong>R {Number(v).toFixed(2)}</Text>,
                    },
                  ]}
                />
              </Card>

              {/* Production Size Run */}
              {lineItems.some(i => Array.isArray(i.sizes) && i.sizes.some(s => s.qty > 0)) && (
                <Card title="Production Size Run" style={{ marginTop: 16, borderRadius: 10 }}>
                  {lineItems.map((item, idx) => {
                    const activeSizes = Array.isArray(item.sizes) ? item.sizes.filter(s => s.qty > 0) : []
                    const total = activeSizes.reduce((s, sz) => s + (Number(sz.qty) || 0), 0)
                    const brandingText = (() => {
                      if (!item.branding) return null
                      if (typeof item.branding === 'string') return item.branding || null
                      const { type, position, detail } = item.branding
                      if (!type || type === 'none') return null
                      return [type.replace(/_/g, ' '), position, detail].filter(Boolean).join(' · ')
                    })()
                    return (
                      <div key={idx}>
                        <Space style={{ marginBottom: 8 }}>
                          <Text strong>{item.name ?? item.description}</Text>
                          {item.colour && <Tag>{item.colour}</Tag>}
                          {brandingText && (
                            <Text type="secondary" style={{ fontSize: 12 }}>({brandingText})</Text>
                          )}
                        </Space>
                        {activeSizes.length > 0 ? (
                          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 4 }}>
                            {activeSizes.map(({ size, qty }) => (
                              <div key={size} style={{ textAlign: 'center', minWidth: 40 }}>
                                <div style={{ fontSize: 11, color: '#888', marginBottom: 2 }}>{size}</div>
                                <div style={{ fontWeight: 700, fontSize: 18, lineHeight: 1 }}>{qty}</div>
                              </div>
                            ))}
                            <div style={{ textAlign: 'center', minWidth: 50, borderLeft: '1px solid #444', paddingLeft: 16 }}>
                              <div style={{ fontSize: 11, color: '#888', marginBottom: 2 }}>TOTAL</div>
                              <div style={{ fontWeight: 700, fontSize: 18, color: '#c0392b', lineHeight: 1 }}>{total}</div>
                            </div>
                          </div>
                        ) : typeof item.sizes === 'string' && item.sizes ? (
                          <Text type="secondary" style={{ fontSize: 12 }}>Sizes: {item.sizes}</Text>
                        ) : null}
                        {idx < lineItems.length - 1 && <Divider style={{ margin: '12px 0' }} />}
                      </div>
                    )
                  })}
                </Card>
              )}
            </>
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
                <Text type="secondary" style={{ fontSize: 12 }}>Deposit (60%)</Text>
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

          {/* Digital Proof Card */}
          <Card
            title={
              <Space>
                <ExperimentOutlined />
                Digital Proof
                <Badge status={PROOF_STATUS_COLOR[order.proof_status ?? 'none']}
                  text={<Text style={{ fontSize: 11 }}>{PROOF_STATUS_LABEL[order.proof_status ?? 'none']}</Text>} />
              </Space>
            }
            extra={
              <Button size="small" icon={<SendOutlined />} onClick={() => { proofForm.resetFields(); setProofModal(true) }}>
                Send Proof
              </Button>
            }
            style={{ marginTop: 16, borderRadius: 10 }}
          >
            {order.proof_url ? (
              <>
                <a href={order.proof_url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                  View Current Proof
                </a>
                {order.proof_notes && (
                  <div style={{ marginTop: 6 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>{order.proof_notes}</Text>
                  </div>
                )}
                {order.proof_sent_at && (
                  <div style={{ marginTop: 4 }}>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      Sent {dayjs(order.proof_sent_at).format('DD MMM YYYY HH:mm')}
                    </Text>
                  </div>
                )}
                {order.proof_status !== 'approved' && (
                  <Space style={{ marginTop: 10 }}>
                    <Button
                      size="small" type="primary" icon={<CheckCircleOutlined />}
                      onClick={() => proofStatusMutation.mutate({ status: 'approved' })}
                      loading={proofStatusMutation.isPending}
                    >
                      Mark Approved
                    </Button>
                    <Button
                      size="small" icon={<EditOutlined />}
                      onClick={() => proofStatusMutation.mutate({ status: 'revision_requested' })}
                      loading={proofStatusMutation.isPending}
                    >
                      Mark Revision
                    </Button>
                  </Space>
                )}
              </>
            ) : (
              <Text type="secondary" style={{ fontSize: 13 }}>
                No proof sent yet. Upload a design proof URL and send it to the client via WhatsApp.
              </Text>
            )}
          </Card>

          {/* Material / Stock Notes Card */}
          <Card
            title="Material & Stock Notes"
            extra={
              <Button
                size="small"
                icon={<EditOutlined />}
                onClick={() => {
                  materialsForm.setFieldsValue(materialNotes)
                  setMaterialsModal(true)
                }}
              >
                Edit
              </Button>
            }
            style={{ marginTop: 16, borderRadius: 10 }}
          >
            {Object.keys(materialNotes).length === 0 ? (
              <Text type="secondary" style={{ fontSize: 13 }}>No material notes yet.</Text>
            ) : (
              Object.entries(materialNotes).map(([k, v]) => v && (
                <div key={k} style={{ marginBottom: 6 }}>
                  <Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>{k.replace(/_/g, ' ')}</Text>
                  <div><Text style={{ fontSize: 13 }}>{v}</Text></div>
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
          {nextStageName === 'in_production' && (
            <Form.Item label="Estimated Completion Date" name="estimatedCompletion">
              <Input type="date" />
            </Form.Item>
          )}
          {nextStageName === 'ready' && (
            <>
              <Form.Item label="Delivery or Collection?" name="deliveryType" initialValue="collection">
                <Select options={[
                  { value: 'collection', label: 'Collection — customer collects from store' },
                  { value: 'delivery',   label: 'Delivery — courier dispatched' },
                ]} />
              </Form.Item>
              <Form.Item
                noStyle
                shouldUpdate={(prev, cur) => prev.deliveryType !== cur.deliveryType}
              >
                {({ getFieldValue }) =>
                  getFieldValue('deliveryType') === 'delivery' ? (
                    <Form.Item label="Tracking Number" name="trackingNumber">
                      <Input placeholder="Courier tracking number" />
                    </Form.Item>
                  ) : null
                }
              </Form.Item>
            </>
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

      {/* Send Proof Modal */}
      <Modal
        title="Send Design Proof to Client"
        open={proofModal}
        onCancel={() => { setProofModal(false); proofForm.resetFields() }}
        onOk={() => proofMutation.mutate(proofForm.getFieldsValue())}
        okText="Send via WhatsApp"
        okButtonProps={{ loading: proofMutation.isPending }}
      >
        <Alert
          type="info" showIcon
          message="The proof URL will be sent to the client via WhatsApp. They can reply 'approve' or 'revise'."
          style={{ marginBottom: 16 }}
        />
        <Form form={proofForm} layout="vertical">
          <Form.Item label="Proof URL" name="proofUrl" rules={[{ required: true, message: 'Provide the proof URL' }, { type: 'url', message: 'Must be a valid URL' }]}>
            <Input placeholder="https://drive.google.com/..." />
          </Form.Item>
          <Form.Item label="Message to client (optional)" name="notes">
            <Input.TextArea rows={2} placeholder="e.g. Please review the logo placement on the left chest." />
          </Form.Item>
        </Form>
      </Modal>

      {/* Materials Modal */}
      <Modal
        title="Material & Stock Notes"
        open={materialsModal}
        onCancel={() => setMaterialsModal(false)}
        onOk={() => materialsMutation.mutate(materialsForm.getFieldsValue())}
        okText="Save Notes"
        okButtonProps={{ loading: materialsMutation.isPending }}
        width={520}
      >
        <Form form={materialsForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item label="Fabric / Material" name="fabric">
            <Input placeholder="e.g. 65/35 polycotton, navy blue" />
          </Form.Item>
          <Form.Item label="Supplier" name="supplier">
            <Input placeholder="e.g. Bella Fabrics — Johannesburg" />
          </Form.Item>
          <Form.Item label="Lead Time" name="lead_time">
            <Input placeholder="e.g. 7-10 business days from order" />
          </Form.Item>
          <Form.Item label="Stock Status" name="stock_status">
            <Select
              allowClear
              options={[
                { value: 'in_stock', label: 'In Stock' },
                { value: 'ordered', label: 'Ordered from Supplier' },
                { value: 'awaiting', label: 'Awaiting Allocation' },
                { value: 'out_of_stock', label: 'Out of Stock' },
              ]}
            />
          </Form.Item>
          <Form.Item label="Additional Notes" name="notes">
            <Input.TextArea rows={3} placeholder="Any other relevant manufacturing or stock notes..." />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

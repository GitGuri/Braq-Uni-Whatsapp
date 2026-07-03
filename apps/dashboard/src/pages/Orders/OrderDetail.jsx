import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Card, Descriptions, Button, Tag, Space, Typography, Modal, Form, Input,
  Select, InputNumber, Timeline, Table, Spin, Alert, message, Upload, Divider,
  Row, Col, Statistic,
} from 'antd'
import {
  ArrowRightOutlined, ClockCircleOutlined, DollarOutlined,
  UploadOutlined, ArrowLeftOutlined, UserOutlined, WarningOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import {
  getOrder, advanceStage, delayOrder, assignOrder,
  recordPayment, listPayments, listSizes, uploadSizes,
} from '../../api/orders.js'
import { listStaff } from '../../api/staff.js'
import StageTag from '../../components/StageTag.jsx'
import OrderProgress from '../../components/OrderProgress.jsx'

const { Title, Text } = Typography

export default function OrderDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [advanceOpen, setAdvanceOpen] = useState(false)
  const [delayOpen, setDelayOpen] = useState(false)
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [advanceForm] = Form.useForm()
  const [delayForm] = Form.useForm()
  const [paymentForm] = Form.useForm()

  const { data, isLoading, error } = useQuery({
    queryKey: ['order', id],
    queryFn: () => getOrder(id),
  })

  const { data: paymentsData } = useQuery({
    queryKey: ['order-payments', id],
    queryFn: () => listPayments(id),
  })

  const { data: sizesData } = useQuery({
    queryKey: ['order-sizes', id],
    queryFn: () => listSizes(id),
  })

  const { data: staffData } = useQuery({
    queryKey: ['staff-list'],
    queryFn: listStaff,
    enabled: assignOpen,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['order', id] })

  const [advanceError, setAdvanceError] = useState(null)

  const advanceMutation = useMutation({
    mutationFn: (values) => advanceStage(id, values),
    onSuccess: () => {
      message.success('Stage advanced')
      setAdvanceOpen(false)
      setAdvanceError(null)
      advanceForm.resetFields()
      invalidate()
    },
    onError: (err) => {
      const resp = err.response?.data
      if (resp?.missing?.length) {
        setAdvanceError(resp)
      } else {
        message.error(resp?.error ?? 'Failed to advance stage')
      }
    },
  })

  const delayMutation = useMutation({
    mutationFn: (values) => delayOrder(id, values),
    onSuccess: () => { message.success('Order flagged as delayed'); setDelayOpen(false); delayForm.resetFields(); invalidate() },
    onError: (err) => message.error(err.response?.data?.error ?? 'Failed to flag delay'),
  })

  const paymentMutation = useMutation({
    mutationFn: (values) => recordPayment(id, values),
    onSuccess: () => {
      message.success('Payment recorded')
      setPaymentOpen(false)
      paymentForm.resetFields()
      invalidate()
      qc.invalidateQueries({ queryKey: ['order-payments', id] })
    },
    onError: (err) => message.error(err.response?.data?.error ?? 'Failed to record payment'),
  })

  const assignMutation = useMutation({
    mutationFn: (staffId) => assignOrder(id, staffId),
    onSuccess: () => { message.success('Consultant assigned'); setAssignOpen(false); invalidate() },
    onError: (err) => message.error(err.response?.data?.error ?? 'Failed to assign'),
  })

  const uploadMutation = useMutation({
    mutationFn: (file) => uploadSizes(id, file),
    onSuccess: () => {
      message.success('Size roster uploaded')
      qc.invalidateQueries({ queryKey: ['order-sizes', id] })
    },
    onError: (err) => message.error(err.response?.data?.error ?? 'Upload failed'),
  })

  if (isLoading) return <Spin size="large" style={{ display: 'block', marginTop: 80 }} />
  if (error) return <Alert type="error" message="Failed to load order" />

  const { order, history: stageHistory, validation } = data
  const payments = paymentsData?.payments ?? []
  const sizes = sizesData?.entries ?? []
  const staffList = staffData?.staff ?? []
  const requirementsMet = validation?.canAdvance !== false
  const requirementsMissing = validation?.missing ?? []

  const paymentColumns = [
    { title: 'Type', dataIndex: 'payment_type', render: (v) => <Tag color="blue">{v}</Tag> },
    { title: 'Amount', dataIndex: 'amount', render: (v) => <Text strong>R {Number(v).toFixed(2)}</Text> },
    { title: 'Notes', dataIndex: 'notes', render: (v) => v ?? '—' },
    { title: 'Date', dataIndex: 'received_at', render: (v) => dayjs(v).format('DD MMM YYYY') },
  ]

  const sizeColumns = [
    { title: 'Name', dataIndex: 'person_name' },
    { title: 'Size', dataIndex: 'size', render: (v) => <Tag>{v}</Tag> },
    { title: 'Notes', dataIndex: 'notes', render: (v) => v ?? '—' },
  ]

  return (
    <div>
      <Button
        icon={<ArrowLeftOutlined />}
        onClick={() => navigate('/orders')}
        style={{ marginBottom: 16 }}
      >
        Back to Orders
      </Button>

      <Card
        title={
          <Space>
            <Title level={4} style={{ margin: 0 }}>{order.reference}</Title>
            <StageTag stage={order.stage} />
            {order.is_urgent && <Tag color="red">Urgent</Tag>}
            {order.is_delayed && <Tag color="orange">Delayed</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Button onClick={() => setAssignOpen(true)} icon={<UserOutlined />}>
              Assign
            </Button>
            <Button onClick={() => setDelayOpen(true)} icon={<ClockCircleOutlined />} danger>
              Flag Delay
            </Button>
            <Button onClick={() => setPaymentOpen(true)} icon={<DollarOutlined />}>
              Record Payment
            </Button>
            <Button
              type="primary"
              onClick={() => { setAdvanceError(null); setAdvanceOpen(true) }}
              icon={requirementsMet ? <ArrowRightOutlined /> : <WarningOutlined />}
              disabled={order.stage === 'completed'}
              danger={!requirementsMet && order.stage !== 'quotation_requested'}
            >
              {requirementsMet ? 'Advance Stage' : 'Advance Stage (blocked)'}
            </Button>
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <div style={{ marginBottom: 16 }}>
          <OrderProgress stage={order.stage} />
        </div>

        {/* Requirements panel — shown when the advance gate is not yet met */}
        {!requirementsMet && requirementsMissing.length > 0 && (
          <Alert
            type="warning"
            icon={<WarningOutlined />}
            showIcon
            style={{ marginBottom: 16 }}
            message="Stage advance blocked — resolve the following first"
            description={
              <ul style={{ margin: '4px 0 0 0', paddingLeft: 20 }}>
                {requirementsMissing.map((m, i) => (
                  <li key={i} style={{ fontSize: 13 }}>{m}</li>
                ))}
              </ul>
            }
          />
        )}
        {requirementsMet && order.stage !== 'completed' && order.stage !== 'quotation_requested' && (
          <Alert
            type="success"
            icon={<CheckCircleOutlined />}
            showIcon
            message="All requirements met — ready to advance"
            style={{ marginBottom: 16 }}
          />
        )}

        <Descriptions bordered size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
          <Descriptions.Item label="Client">{order.client_name ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="WhatsApp">{order.client_wa_id ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Client Type">
            <Tag>{order.client_type}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Assigned To">{order.assigned_name ?? 'Unassigned'}</Descriptions.Item>
          <Descriptions.Item label="Payment Status">
            <Tag color={order.payment_status === 'paid' ? 'success' : 'warning'}>
              {order.payment_status}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Quantity">{order.quantity ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Est. Completion">
            {order.estimated_completion ? dayjs(order.estimated_completion).format('DD MMM YYYY') : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Created">
            {dayjs(order.created_at).format('DD MMM YYYY HH:mm')}
          </Descriptions.Item>
          <Descriptions.Item label="Description" span={3}>
            {order.description}
          </Descriptions.Item>
          {order.special_notes && (
            <Descriptions.Item label="Special Notes" span={3}>
              {order.special_notes}
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            title="Stage History"
            size="small"
            style={{ marginBottom: 16 }}
          >
            <Timeline
              items={(stageHistory ?? []).map((h) => ({
                children: (
                  <div>
                    <StageTag stage={h.to_stage} />
                    <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                      {dayjs(h.created_at).format('DD MMM HH:mm')}
                      {h.staff_name ? ` — ${h.staff_name}` : ''}
                    </Text>
                    {h.notes && <div style={{ fontSize: 12, color: '#666' }}>{h.notes}</div>}
                  </div>
                ),
              }))}
            />
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card title="Payments" size="small" style={{ marginBottom: 16 }}>
            <Table
              dataSource={payments}
              columns={paymentColumns}
              rowKey="id"
              size="small"
              pagination={false}
              locale={{ emptyText: 'No payments recorded' }}
            />
          </Card>
        </Col>
      </Row>

      <Card
        title="Size Roster"
        size="small"
        extra={
          <Upload
            accept=".xlsx,.csv"
            showUploadList={false}
            beforeUpload={(file) => { uploadMutation.mutate(file); return false }}
          >
            <Button icon={<UploadOutlined />} loading={uploadMutation.isPending} size="small">
              Upload Roster (.xlsx / .csv)
            </Button>
          </Upload>
        }
      >
        <Table
          dataSource={sizes}
          columns={sizeColumns}
          rowKey="id"
          size="small"
          pagination={false}
          locale={{ emptyText: 'No size roster uploaded yet' }}
        />
      </Card>

      {/* Advance Stage Modal */}
      <Modal
        title="Advance to Next Stage"
        open={advanceOpen}
        onCancel={() => { setAdvanceOpen(false); setAdvanceError(null) }}
        footer={null}
      >
        {advanceError && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            message={advanceError.error}
            description={
              <ul style={{ margin: '4px 0 0 0', paddingLeft: 20 }}>
                {advanceError.missing.map((m, i) => <li key={i} style={{ fontSize: 13 }}>{m}</li>)}
              </ul>
            }
          />
        )}
        <Form form={advanceForm} layout="vertical" onFinish={(v) => advanceMutation.mutate(v)}>
          <Form.Item name="notes" label="Notes (optional)">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="estimatedCompletion" label="Updated Est. Completion (optional)">
            <Input placeholder="e.g. 2025-08-20" />
          </Form.Item>
          <Form.Item name="trackingNumber" label="Tracking Number (for dispatch)">
            <Input />
          </Form.Item>
          <Form.Item name="deliveryType" label="Delivery Type" initialValue="collection">
            <Select options={[{ value: 'collection', label: 'Collection' }, { value: 'delivery', label: 'Delivery' }]} />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Button onClick={() => setAdvanceOpen(false)} style={{ marginRight: 8 }}>Cancel</Button>
            <Button type="primary" htmlType="submit" loading={advanceMutation.isPending}>Advance Stage</Button>
          </Form.Item>
        </Form>
      </Modal>

      {/* Flag Delay Modal */}
      <Modal
        title="Flag Order as Delayed"
        open={delayOpen}
        onCancel={() => setDelayOpen(false)}
        footer={null}
      >
        <Form form={delayForm} layout="vertical" onFinish={(v) => delayMutation.mutate(v)}>
          <Form.Item name="reason" label="Reason for delay">
            <Input.TextArea rows={3} placeholder="Explain the delay to the client..." />
          </Form.Item>
          <Form.Item name="newEstimate" label="New estimated completion (optional)">
            <Input placeholder="e.g. 2025-08-30" />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Button onClick={() => setDelayOpen(false)} style={{ marginRight: 8 }}>Cancel</Button>
            <Button danger htmlType="submit" loading={delayMutation.isPending}>Flag Delay & Notify Client</Button>
          </Form.Item>
        </Form>
      </Modal>

      {/* Record Payment Modal */}
      <Modal
        title="Record Payment"
        open={paymentOpen}
        onCancel={() => setPaymentOpen(false)}
        footer={null}
      >
        <Form form={paymentForm} layout="vertical" onFinish={(v) => paymentMutation.mutate(v)}>
          <Form.Item name="type" label="Payment Type" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'deposit', label: 'Deposit' },
                { value: 'balance', label: 'Balance' },
                { value: 'full', label: 'Full Payment' },
              ]}
            />
          </Form.Item>
          <Form.Item name="amount" label="Amount (R)" rules={[{ required: true }]}>
            <InputNumber min={0.01} precision={2} prefix="R" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="notes" label="Notes (optional)">
            <Input />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Button onClick={() => setPaymentOpen(false)} style={{ marginRight: 8 }}>Cancel</Button>
            <Button type="primary" htmlType="submit" loading={paymentMutation.isPending}>Record Payment</Button>
          </Form.Item>
        </Form>
      </Modal>

      {/* Assign Modal */}
      <Modal
        title="Assign Consultant"
        open={assignOpen}
        onCancel={() => setAssignOpen(false)}
        footer={null}
      >
        <Select
          style={{ width: '100%', marginTop: 8 }}
          placeholder="Select staff member"
          options={(staffList).map((s) => ({ value: s.id, label: `${s.name} (${s.role})` }))}
          onChange={(v) => assignMutation.mutate(v)}
          loading={assignMutation.isPending}
        />
      </Modal>
    </div>
  )
}

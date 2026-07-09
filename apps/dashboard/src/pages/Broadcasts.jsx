import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Card, Typography, Button, Modal, Form, Input, Select, message,
  Alert, Space, Row, Col, Table, Tag, Divider, Upload, Image,
} from 'antd'
import {
  NotificationOutlined, ClockCircleOutlined, SendOutlined, HistoryOutlined,
  PictureOutlined, DeleteOutlined, FilePdfOutlined, PaperClipOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../api/client.js'
import { listBroadcasts, sendDelayBroadcast, sendBusyBroadcast, sendCustomBroadcast } from '../api/broadcasts.js'

const { Title, Paragraph, Text } = Typography

const AUDIENCE_OPTIONS = [
  { value: 'active_orders', label: 'Clients with active orders' },
  { value: 'all_clients',   label: 'All clients' },
  { value: 'corporate',     label: 'Corporate clients only' },
  { value: 'retail',        label: 'Retail clients only' },
]

export default function Broadcasts() {
  const qc = useQueryClient()
  const [customOpen,    setCustomOpen]    = useState(false)
  const [delayOpen,     setDelayOpen]     = useState(false)
  const [busyOpen,      setBusyOpen]      = useState(false)
  const [uploadedImage, setUploadedImage] = useState(null)  // { mediaId, previewUrl, filename }
  const [uploading,     setUploading]     = useState(false)
  const [customForm] = Form.useForm()
  const [delayForm]  = Form.useForm()

  const { data, isLoading } = useQuery({
    queryKey: ['broadcasts'],
    queryFn: listBroadcasts,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['broadcasts'] })

  const handleAttachmentSelect = async (file) => {
    setUploading(true)
    try {
      const form = new FormData()
      form.append('attachment', file)
      // Do NOT set Content-Type — axios sets it with the boundary automatically
      const { data } = await api.post('/broadcasts/upload-attachment', form)
      const isPdf     = file.type === 'application/pdf'
      const previewUrl = isPdf ? null : URL.createObjectURL(file)
      setUploadedImage({ mediaId: data.mediaId, previewUrl, filename: data.filename, type: data.type })
    } catch (err) {
      message.error(err.response?.data?.error ?? 'Upload failed')
    } finally {
      setUploading(false)
    }
    return false
  }

  const customMut = useMutation({
    mutationFn: (vals) => sendCustomBroadcast({
      ...vals,
      mediaId:       uploadedImage?.mediaId,
      mediaType:     uploadedImage?.type,
      mediaFilename: uploadedImage?.filename,
    }),
    onSuccess: (r) => {
      message.success(`Message sent to ${r.sent} client${r.sent !== 1 ? 's' : ''}`)
      setCustomOpen(false)
      customForm.resetFields()
      setUploadedImage(null)
      invalidate()
    },
    onError: (err) => message.error(err.response?.data?.error ?? 'Broadcast failed'),
  })

  const delayMut = useMutation({
    mutationFn: sendDelayBroadcast,
    onSuccess: (r) => {
      message.success(`Delay notice sent to ${r.sent} clients`)
      setDelayOpen(false)
      delayForm.resetFields()
      invalidate()
    },
    onError: (err) => message.error(err.response?.data?.error ?? 'Broadcast failed'),
  })

  const busyMut = useMutation({
    mutationFn: sendBusyBroadcast,
    onSuccess: (r) => {
      message.success(`Busy notice sent to ${r.sent} clients`)
      setBusyOpen(false)
      invalidate()
    },
    onError: (err) => message.error(err.response?.data?.error ?? 'Broadcast failed'),
  })

  const broadcasts = data?.broadcasts ?? []

  const typeLabel = (t) => {
    if (t === 'delay')  return <Tag color="red">Delay</Tag>
    if (t === 'busy')   return <Tag color="orange">Busy</Tag>
    if (t?.startsWith('custom:')) {
      const aud = t.split(':')[1] ?? 'all'
      return <Tag color="blue">Custom · {aud.replace(/_/g, ' ')}</Tag>
    }
    return <Tag>{t}</Tag>
  }

  const columns = [
    { title: 'Type',       dataIndex: 'message_type', render: typeLabel, width: 180 },
    { title: 'Sent by',    dataIndex: 'sent_by_name', render: (v) => v ?? '—', width: 140 },
    { title: 'Recipients', dataIndex: 'recipient_count', width: 110, align: 'right',
      render: (v) => <Tag color="blue">{v} sent</Tag> },
    { title: 'Message',    dataIndex: 'body',
      render: (v) => <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{v}</Text> },
    { title: 'Date',       dataIndex: 'created_at', width: 160,
      render: (v) => <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).format('DD MMM YYYY HH:mm')}</Text> },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Title level={4} style={{ margin: 0 }}>WhatsApp Broadcasts</Title>
        <Button type="primary" icon={<SendOutlined />} onClick={() => setCustomOpen(true)}>
          Send Custom Broadcast
        </Button>
      </div>
      <Paragraph type="secondary" style={{ marginBottom: 24 }}>
        Send WhatsApp messages to specific client audiences. Use with care — messages are delivered immediately.
      </Paragraph>

      <Alert
        type="warning"
        showIcon
        message="Broadcasts send real WhatsApp messages. Only use when necessary."
        style={{ marginBottom: 24 }}
      />

      <Row gutter={[16, 16]} style={{ marginBottom: 32 }}>
        <Col xs={24} md={8}>
          <Card
            actions={[
              <Button key="send" danger icon={<ClockCircleOutlined />} onClick={() => setDelayOpen(true)} block>
                Send Delay Notice
              </Button>,
            ]}
          >
            <Card.Meta
              avatar={<ClockCircleOutlined style={{ fontSize: 28, color: '#cf1322' }} />}
              title="Supplier Delay"
              description="Notify all clients with active orders of a production delay."
            />
          </Card>
        </Col>

        <Col xs={24} md={8}>
          <Card
            actions={[
              <Button key="send" icon={<NotificationOutlined />} onClick={() => busyMut.mutate({})} loading={busyMut.isPending} block>
                Send Busy Notice
              </Button>,
            ]}
          >
            <Card.Meta
              avatar={<NotificationOutlined style={{ fontSize: 28, color: '#1677ff' }} />}
              title="High-Volume Notice"
              description="Let all active clients know response times may be longer than usual."
            />
          </Card>
        </Col>

        <Col xs={24} md={8}>
          <Card
            actions={[
              <Button key="send" type="primary" icon={<SendOutlined />} onClick={() => setCustomOpen(true)} block>
                Compose Broadcast
              </Button>,
            ]}
          >
            <Card.Meta
              avatar={<SendOutlined style={{ fontSize: 28, color: '#52c41a' }} />}
              title="Custom Message"
              description="Write your own message and choose which audience receives it."
            />
          </Card>
        </Col>
      </Row>

      <Divider orientation="left"><HistoryOutlined /> Broadcast History</Divider>

      <Card bodyStyle={{ padding: 0 }}>
        <Table
          dataSource={broadcasts}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          size="small"
          pagination={{ pageSize: 20, showSizeChanger: false }}
        />
      </Card>

      {/* Custom Broadcast Modal */}
      <Modal
        title="Send Custom Broadcast"
        open={customOpen}
        onCancel={() => { setCustomOpen(false); customForm.resetFields() }}
        footer={null}
        width={540}
      >
        <Alert
          type="info"
          showIcon
          message="Messages are sent immediately via WhatsApp. Preview your message before sending."
          style={{ marginBottom: 16 }}
        />
        <Form form={customForm} layout="vertical" onFinish={(v) => customMut.mutate(v)}>
          <Form.Item name="audience" label="Send to" initialValue="active_orders" rules={[{ required: true }]}>
            <Select options={AUDIENCE_OPTIONS} />
          </Form.Item>

          {/* Attachment — image or PDF */}
          <Form.Item label="Attachment (optional)">
            {uploadedImage ? (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 14px', borderRadius: 8,
                border: '1px solid #2a2a2a', background: '#141414',
              }}>
                {uploadedImage.type === 'pdf' ? (
                  <FilePdfOutlined style={{ fontSize: 32, color: '#c0392b', flexShrink: 0 }} />
                ) : (
                  <Image
                    src={uploadedImage.previewUrl}
                    alt="preview"
                    style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6 }}
                    preview={{ mask: false }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {uploadedImage.filename}
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                    {uploadedImage.type === 'pdf' ? 'PDF document' : 'Image'} · ready to send
                  </div>
                </div>
                <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setUploadedImage(null)} />
              </div>
            ) : (
              <Upload.Dragger
                accept="image/jpeg,image/png,image/webp,application/pdf"
                showUploadList={false}
                beforeUpload={(file) => { handleAttachmentSelect(file); return false }}
                disabled={uploading}
                style={{ padding: '10px 0' }}
              >
                <p style={{ color: '#888', margin: 0 }}>
                  <PaperClipOutlined style={{ fontSize: 22, marginBottom: 6, display: 'block' }} />
                  {uploading ? 'Uploading to WhatsApp…' : 'Click or drag a file here'}
                </p>
                <p style={{ fontSize: 11, color: '#555', margin: '4px 0 0' }}>
                  JPG · PNG · WebP (max 5 MB) &nbsp;|&nbsp; PDF (max 20 MB)
                </p>
              </Upload.Dragger>
            )}
          </Form.Item>

          <Form.Item
            name="message"
            label={uploadedImage ? 'Caption (optional)' : 'Message'}
            rules={[{
              validator(_, value) {
                if (value?.trim() || uploadedImage) return Promise.resolve()
                return Promise.reject(new Error('Enter a message or attach a file'))
              },
            }]}
          >
            <Input.TextArea
              rows={4}
              placeholder={uploadedImage ? 'Add a caption to accompany the file (optional)…' : 'Type your WhatsApp message here…'}
              maxLength={1000}
              showCount
            />
          </Form.Item>

          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Space>
              <Button onClick={() => { setCustomOpen(false); customForm.resetFields(); setUploadedImage(null) }}>
                Cancel
              </Button>
              <Button type="primary" htmlType="submit" loading={customMut.isPending || uploading} icon={<SendOutlined />}
                disabled={uploading}>
                {uploading ? 'Uploading…' : 'Send Broadcast'}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* Delay Modal */}
      <Modal
        title="Send Delay Notice"
        open={delayOpen}
        onCancel={() => { setDelayOpen(false); delayForm.resetFields() }}
        footer={null}
        width={480}
      >
        <Alert type="warning" showIcon
          message="Sends a personalised delay WhatsApp to all clients with active orders."
          style={{ marginBottom: 16 }} />
        <Form form={delayForm} layout="vertical" onFinish={(v) => delayMut.mutate(v)}>
          <Form.Item name="reason" label="Delay Reason">
            <Input.TextArea rows={3} placeholder="e.g. Supplier fabric allocation delayed by ~5 business days." />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Space>
              <Button onClick={() => setDelayOpen(false)}>Cancel</Button>
              <Button danger htmlType="submit" loading={delayMut.isPending} icon={<ClockCircleOutlined />}>
                Send to Active Orders
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

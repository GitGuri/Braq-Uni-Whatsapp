import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  App, Button, Modal, Form, Input, Select,
  Alert, Space, Row, Col, Table, Upload, Image,
} from 'antd'
import {
  NotificationOutlined, ClockCircleOutlined, SendOutlined,
  DeleteOutlined, FilePdfOutlined, PaperClipOutlined, EditOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../api/client.js'
import { listBroadcasts, sendDelayBroadcast, sendBusyBroadcast, sendCustomBroadcast } from '../api/broadcasts.js'
import { errorMessage } from '../utils/errorMessage.js'
import { useCan } from '../lib/useCan.js'

/** "sent to 12 clients" / "on its way" — the send may be queued (202) rather than finished. */
const sentTo = (r) => {
  const n = r?.sent ?? r?.recipientCount ?? r?.recipient_count ?? r?.broadcast?.recipient_count
  if (n == null) return 'queued — it goes out in the next few moments'
  return `${r?.queued || r?.status === 'queued' ? 'queued for' : 'sent to'} ${n} client${Number(n) !== 1 ? 's' : ''}`
}

const AUDIENCE_OPTIONS = [
  { value: 'active_orders', label: 'Clients with active orders' },
  { value: 'all_clients',   label: 'All clients' },
  { value: 'corporate',     label: 'Corporate clients only' },
  { value: 'retail',        label: 'Retail clients only' },
]

const AUDIENCE_LABEL = Object.fromEntries(AUDIENCE_OPTIONS.map((o) => [o.value, o.label]))

/** A quick-send panel: what it does, then one button. */
function ActionPanel({ icon, iconColor, title, description, action }) {
  return (
    <section className="braq-panel" style={{ height: '100%', padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flex: 1 }}>
        <span aria-hidden="true" style={{ fontSize: 18, color: iconColor, lineHeight: 1, marginTop: 2 }}>{icon}</span>
        <div>
          <h2 className="braq-panel-title">{title}</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--ink-2)', fontSize: 13 }}>{description}</p>
        </div>
      </div>
      {action}
    </section>
  )
}

export default function Broadcasts() {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const can = useCan()
  const canSend = can('broadcast.send')
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
      message.error(errorMessage(err, 'The file could not be uploaded. Check its size and type, then try again.'))
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
      message.success(`Message ${sentTo(r)}`)
      setCustomOpen(false)
      customForm.resetFields()
      setUploadedImage(null)
      invalidate()
    },
    onError: (err) => message.error(errorMessage(err, 'The broadcast was not sent')),
  })

  const delayMut = useMutation({
    mutationFn: sendDelayBroadcast,
    onSuccess: (r) => {
      message.success(`Delay notice ${sentTo(r)}`)
      setDelayOpen(false)
      delayForm.resetFields()
      invalidate()
    },
    onError: (err) => message.error(errorMessage(err, 'The delay notice was not sent')),
  })

  const busyMut = useMutation({
    mutationFn: sendBusyBroadcast,
    onSuccess: (r) => {
      message.success(`Busy notice ${sentTo(r)}`)
      setBusyOpen(false)
      invalidate()
    },
    onError: (err) => message.error(errorMessage(err, 'The busy notice was not sent')),
  })

  const broadcasts = data?.broadcasts ?? []

  const typeLabel = (t) => {
    if (t === 'delay')  return <span className="braq-pill red">Delay notice</span>
    if (t === 'busy')   return <span className="braq-pill amber">Busy notice</span>
    if (t?.startsWith('custom:')) {
      const aud = t.split(':')[1] ?? 'all'
      return <span className="braq-pill blue">Custom · {(AUDIENCE_LABEL[aud] ?? aud.replace(/_/g, ' ')).toLowerCase()}</span>
    }
    return <span className="braq-pill">{t}</span>
  }

  const columns = [
    { title: 'Type',       dataIndex: 'message_type', render: typeLabel },
    { title: 'Sent by',    dataIndex: 'sent_by_name', render: (v) => v ?? '—' },
    { title: 'Recipients', dataIndex: 'recipient_count', align: 'right',
      render: (v) => <span style={{ whiteSpace: 'nowrap' }}>{v} client{Number(v) !== 1 ? 's' : ''}</span> },
    { title: 'Message',    dataIndex: 'body',
      render: (v) => (
        <div style={{ minWidth: 220, maxWidth: 440, fontSize: 13, color: 'var(--ink-2)', whiteSpace: 'pre-wrap' }}>{v}</div>
      ) },
    { title: 'Sent',       dataIndex: 'created_at',
      render: (v) => <span style={{ whiteSpace: 'nowrap', fontSize: 13, color: 'var(--ink-2)' }}>{dayjs(v).format('D MMM YYYY, HH:mm')}</span> },
  ]

  const closeCustom = () => { setCustomOpen(false); customForm.resetFields(); setUploadedImage(null) }

  return (
    <div>
      <div className="braq-page-header">
        <div>
          <h1 className="braq-page-title">WhatsApp broadcasts</h1>
          <div className="braq-page-subtitle">
            Send one WhatsApp message to a group of clients. Messages go out the moment you send them and can't be recalled.
          </div>
        </div>
        {canSend && (
          <Button type="primary" icon={<EditOutlined />} onClick={() => setCustomOpen(true)}>
            Write a broadcast
          </Button>
        )}
      </div>

      {!canSend && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 20 }}
          message="You can see what was sent, but only an admin or manager can send a broadcast."
        />
      )}

      {canSend && <Row gutter={[16, 16]} style={{ marginBottom: 28 }}>
        <Col xs={24} md={8}>
          <ActionPanel
            icon={<ClockCircleOutlined />}
            iconColor="var(--thread)"
            title="Supplier delay"
            description="Tell every client with an active order that production is running late."
            action={
              <Button danger icon={<ClockCircleOutlined />} onClick={() => setDelayOpen(true)} block>
                Send delay notice
              </Button>
            }
          />
        </Col>

        <Col xs={24} md={8}>
          <ActionPanel
            icon={<NotificationOutlined />}
            iconColor="var(--warn)"
            title="Busy period"
            description="Let active clients know replies may take longer than usual. Sends straight away."
            action={
              <Button icon={<NotificationOutlined />} onClick={() => busyMut.mutate({})} loading={busyMut.isPending} block>
                Send busy notice
              </Button>
            }
          />
        </Col>

        <Col xs={24} md={8}>
          <ActionPanel
            icon={<SendOutlined />}
            iconColor="var(--info)"
            title="Custom message"
            description="Write your own message, add an image or PDF, and choose who receives it."
            action={
              <Button icon={<EditOutlined />} onClick={() => setCustomOpen(true)} block>
                Write a broadcast
              </Button>
            }
          />
        </Col>
      </Row>}

      <section className="braq-panel" aria-labelledby="history-title" style={{ overflow: 'hidden' }}>
        <div className="braq-panel-head">
          <h2 id="history-title" className="braq-panel-title">Sent broadcasts</h2>
          {broadcasts.length > 0 && <span className="braq-pill">{broadcasts.length}</span>}
        </div>
        <Table
          dataSource={broadcasts}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          size="middle"
          scroll={{ x: 'max-content' }}
          pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{ emptyText: 'No broadcasts sent yet. Messages you send from this page will be listed here.' }}
        />
      </section>

      {/* Custom broadcast modal */}
      <Modal
        title="Write a broadcast"
        open={customOpen}
        onCancel={() => { setCustomOpen(false); customForm.resetFields() }}
        footer={null}
        width={540}
      >
        <p style={{ margin: '4px 0 16px', color: 'var(--ink-2)' }}>
          This goes out on WhatsApp as soon as you press send. Check the audience and wording first.
        </p>
        <Form form={customForm} layout="vertical" onFinish={(v) => customMut.mutate(v)}>
          <Form.Item name="audience" label="Send to" initialValue="active_orders" rules={[{ required: true, message: 'Choose who should receive this' }]}>
            <Select options={AUDIENCE_OPTIONS} />
          </Form.Item>

          {/* Attachment — image or PDF */}
          <Form.Item label="Attachment (optional)">
            {uploadedImage ? (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 14px', borderRadius: 8,
                border: '1px solid var(--line)', background: 'var(--surface-2)',
              }}>
                {uploadedImage.type === 'pdf' ? (
                  <FilePdfOutlined style={{ fontSize: 28, color: 'var(--thread)', flexShrink: 0 }} />
                ) : (
                  <Image
                    src={uploadedImage.previewUrl}
                    alt="Attachment preview"
                    style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6 }}
                    preview={{ mask: false }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {uploadedImage.filename}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>
                    {uploadedImage.type === 'pdf' ? 'PDF document' : 'Image'} · ready to send
                  </div>
                </div>
                <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setUploadedImage(null)} aria-label="Remove attachment" />
              </div>
            ) : (
              <Upload.Dragger
                accept="image/jpeg,image/png,image/webp,application/pdf"
                showUploadList={false}
                beforeUpload={(file) => { handleAttachmentSelect(file); return false }}
                disabled={uploading}
                style={{ padding: '10px 0' }}
              >
                <p style={{ color: 'var(--ink-2)', margin: 0 }}>
                  <PaperClipOutlined style={{ fontSize: 20, marginBottom: 6, display: 'block', color: 'var(--ink-3)' }} />
                  {uploading ? 'Uploading to WhatsApp…' : 'Click or drag an image or PDF here'}
                </p>
                <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '4px 0 0' }}>
                  JPG, PNG or WebP up to 5 MB · PDF up to 20 MB
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
                return Promise.reject(new Error('Write a message or attach a file'))
              },
            }]}
          >
            <Input.TextArea
              rows={4}
              placeholder={uploadedImage ? 'Add a caption to go with the file (optional)' : 'Type the WhatsApp message clients will receive'}
              maxLength={1000}
              showCount
            />
          </Form.Item>

          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Space wrap>
              <Button onClick={closeCustom}>
                Cancel
              </Button>
              <Button type="primary" htmlType="submit" loading={customMut.isPending || uploading} icon={<SendOutlined />}
                disabled={uploading}>
                {uploading ? 'Uploading…' : 'Send broadcast'}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* Delay modal */}
      <Modal
        title="Send delay notice"
        open={delayOpen}
        onCancel={() => { setDelayOpen(false); delayForm.resetFields() }}
        footer={null}
        width={480}
      >
        <Alert type="warning" showIcon
          message="Every client with an active order gets a personalised WhatsApp about the delay."
          style={{ margin: '4px 0 16px' }} />
        <Form form={delayForm} layout="vertical" onFinish={(v) => delayMut.mutate(v)}>
          <Form.Item name="reason" label="Reason for the delay">
            <Input.TextArea rows={3} placeholder="e.g. Our fabric supplier is about 5 working days behind." />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Space wrap>
              <Button onClick={() => setDelayOpen(false)}>Cancel</Button>
              <Button danger htmlType="submit" loading={delayMut.isPending} icon={<ClockCircleOutlined />}>
                Send to clients with active orders
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

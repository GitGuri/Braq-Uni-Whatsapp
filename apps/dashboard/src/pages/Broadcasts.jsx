import { useState } from 'react'
import { Card, Typography, Button, Modal, Form, Input, message, Alert, Space, Row, Col } from 'antd'
import { NotificationOutlined, ClockCircleOutlined } from '@ant-design/icons'
import { sendDelayBroadcast, sendBusyBroadcast } from '../api/broadcasts.js'

const { Title, Paragraph, Text } = Typography

export default function Broadcasts() {
  const [delayOpen, setDelayOpen] = useState(false)
  const [busyOpen, setBusyOpen] = useState(false)
  const [delayLoading, setDelayLoading] = useState(false)
  const [busyLoading, setBusyLoading] = useState(false)
  const [delayForm] = Form.useForm()
  const [busyForm] = Form.useForm()

  const handleDelay = async (values) => {
    setDelayLoading(true)
    try {
      const result = await sendDelayBroadcast(values)
      message.success(`Delay notice sent to ${result.sent ?? 'all'} clients`)
      setDelayOpen(false)
      delayForm.resetFields()
    } catch (err) {
      message.error(err.response?.data?.error ?? 'Failed to send delay broadcast')
    } finally {
      setDelayLoading(false)
    }
  }

  const handleBusy = async (values) => {
    setBusyLoading(true)
    try {
      const result = await sendBusyBroadcast(values)
      message.success(`High-volume notice sent to ${result.sent ?? 'all'} clients`)
      setBusyOpen(false)
      busyForm.resetFields()
    } catch (err) {
      message.error(err.response?.data?.error ?? 'Failed to send broadcast')
    } finally {
      setBusyLoading(false)
    }
  }

  return (
    <div>
      <Title level={4} style={{ marginBottom: 8 }}>Broadcasts</Title>
      <Paragraph type="secondary" style={{ marginBottom: 24 }}>
        Send WhatsApp broadcasts to clients with active orders.
        Use with care — these go out to all affected clients immediately.
      </Paragraph>

      <Alert
        type="warning"
        showIcon
        message="Broadcasts send real WhatsApp messages to clients. Only use when necessary."
        style={{ marginBottom: 24 }}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card
            style={{ height: '100%' }}
            actions={[
              <Button
                key="send"
                type="primary"
                icon={<ClockCircleOutlined />}
                onClick={() => setDelayOpen(true)}
                danger
              >
                Send Delay Notice
              </Button>,
            ]}
          >
            <Card.Meta
              avatar={<ClockCircleOutlined style={{ fontSize: 32, color: '#cf1322' }} />}
              title="Delay Notice"
              description={
                <Paragraph type="secondary">
                  Notify all clients with active orders that production is experiencing delays.
                  Each client will receive a personalised WhatsApp message with their order reference.
                </Paragraph>
              }
            />
          </Card>
        </Col>

        <Col xs={24} md={12}>
          <Card
            style={{ height: '100%' }}
            actions={[
              <Button
                key="send"
                icon={<NotificationOutlined />}
                onClick={() => setBusyOpen(true)}
              >
                Send Busy Notice
              </Button>,
            ]}
          >
            <Card.Meta
              avatar={<NotificationOutlined style={{ fontSize: 32, color: '#1677ff' }} />}
              title="High-Volume Notice"
              description={
                <Paragraph type="secondary">
                  Notify all clients that Braq Uni is experiencing high order volume and response
                  times may be longer than usual.
                </Paragraph>
              }
            />
          </Card>
        </Col>
      </Row>

      {/* Delay Notice Modal */}
      <Modal
        title="Send Delay Notice"
        open={delayOpen}
        onCancel={() => { setDelayOpen(false); delayForm.resetFields() }}
        footer={null}
        width={480}
      >
        <Alert
          type="warning"
          showIcon
          message="This will send a WhatsApp message to ALL clients with active orders."
          style={{ marginBottom: 16 }}
        />
        <Form form={delayForm} layout="vertical" onFinish={handleDelay}>
          <Form.Item name="reason" label="Delay Reason" rules={[{ required: true, message: 'Provide a reason' }]}>
            <Input.TextArea
              rows={3}
              placeholder="e.g. Material supplier delays have pushed back production timelines by approximately 5 business days."
            />
          </Form.Item>
          <Form.Item name="newEstimate" label="Updated Timeline (optional)">
            <Input placeholder="e.g. end of August 2025" />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Button onClick={() => setDelayOpen(false)} style={{ marginRight: 8 }}>Cancel</Button>
            <Button danger htmlType="submit" loading={delayLoading} icon={<ClockCircleOutlined />}>
              Send to All Active Orders
            </Button>
          </Form.Item>
        </Form>
      </Modal>

      {/* Busy Notice Modal */}
      <Modal
        title="Send High-Volume Notice"
        open={busyOpen}
        onCancel={() => { setBusyOpen(false); busyForm.resetFields() }}
        footer={null}
        width={480}
      >
        <Alert
          type="info"
          showIcon
          message="This will send a WhatsApp message to ALL clients."
          style={{ marginBottom: 16 }}
        />
        <Form form={busyForm} layout="vertical" onFinish={handleBusy}>
          <Form.Item name="message" label="Custom Message (optional)">
            <Input.TextArea
              rows={3}
              placeholder="Leave blank to use the default high-volume message template."
            />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Button onClick={() => setBusyOpen(false)} style={{ marginRight: 8 }}>Cancel</Button>
            <Button type="primary" htmlType="submit" loading={busyLoading} icon={<NotificationOutlined />}>
              Send Notice
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

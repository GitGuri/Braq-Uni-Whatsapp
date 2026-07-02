import { useState } from 'react'
import {
  Modal, Form, Input, Select, InputNumber, Switch, Button, message,
} from 'antd'
import { useQuery } from '@tanstack/react-query'
import { listClients } from '../../api/clients.js'
import { createOrder } from '../../api/orders.js'

const CLIENT_TYPES = ['retail', 'school', 'corporate', 'hospitality', 'church', 'security', 'government', 'reseller']

export default function CreateOrderModal({ open, onClose, onSuccess }) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const { data: clientsData } = useQuery({
    queryKey: ['clients', 'all'],
    queryFn: () => listClients({ limit: 200 }),
    enabled: open,
  })

  const clients = clientsData?.clients ?? []

  const onFinish = async (values) => {
    setLoading(true)
    try {
      await createOrder(values)
      message.success('Order created successfully')
      form.resetFields()
      onSuccess()
    } catch (err) {
      message.error(err.response?.data?.error ?? 'Failed to create order')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title="Create New Order"
      open={open}
      onCancel={onClose}
      footer={null}
      width={520}
    >
      <Form form={form} layout="vertical" onFinish={onFinish} style={{ marginTop: 16 }}>
        <Form.Item name="clientId" label="Client" rules={[{ required: true }]}>
          <Select
            showSearch
            placeholder="Select client"
            optionFilterProp="label"
            options={clients.map((c) => ({
              value: c.id,
              label: `${c.name ?? c.wa_id} (${c.wa_id})`,
            }))}
          />
        </Form.Item>

        <Form.Item name="clientType" label="Client Type" rules={[{ required: true }]}>
          <Select
            options={CLIENT_TYPES.map((t) => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))}
          />
        </Form.Item>

        <Form.Item name="description" label="Order Description" rules={[{ required: true }]}>
          <Input.TextArea rows={3} placeholder="Describe the order..." />
        </Form.Item>

        <Form.Item name="quantity" label="Quantity">
          <InputNumber min={1} style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item name="estimatedCompletion" label="Estimated Completion (ISO date)">
          <Input placeholder="e.g. 2025-08-15" />
        </Form.Item>

        <Form.Item name="specialNotes" label="Special Notes">
          <Input.TextArea rows={2} />
        </Form.Item>

        <Form.Item name="isUrgent" label="Urgent?" valuePropName="checked" initialValue={false}>
          <Switch />
        </Form.Item>

        <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
          <Button onClick={onClose} style={{ marginRight: 8 }}>Cancel</Button>
          <Button type="primary" htmlType="submit" loading={loading}>Create Order</Button>
        </Form.Item>
      </Form>
    </Modal>
  )
}

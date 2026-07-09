import { useState } from 'react'
import { Modal, Form, Input, Select, Button, message } from 'antd'
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
      const res = await createOrder(values)
      message.success('Order created successfully')
      form.resetFields()
      onSuccess(res.order ?? res)
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
        <Form.Item name="clientId" label="Client" rules={[{ required: true, message: 'Select a client' }]}>
          <Select
            showSearch
            placeholder="Select client"
            optionFilterProp="label"
            options={clients.map((c) => ({
              value: c.id,
              label: `${c.name ?? c.whatsapp_number} (${c.whatsapp_number})`,
            }))}
          />
        </Form.Item>

        <Form.Item name="clientType" label="Client Type" rules={[{ required: true, message: 'Select client type' }]}>
          <Select
            options={CLIENT_TYPES.map((t) => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))}
          />
        </Form.Item>

        <Form.Item name="quotationId" label="Linked Quotation (optional)">
          <Input placeholder="Quotation ID (leave blank to skip)" />
        </Form.Item>

        <Form.Item name="poNumber" label="PO Number (optional)">
          <Input placeholder="e.g. PO-2026-0042" />
        </Form.Item>

        <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
          <Button onClick={onClose} style={{ marginRight: 8 }}>Cancel</Button>
          <Button type="primary" htmlType="submit" loading={loading}>Create Order</Button>
        </Form.Item>
      </Form>
    </Modal>
  )
}

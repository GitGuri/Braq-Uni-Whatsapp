import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table, Card, Typography, Button, Tag, Modal, Form, Input, message,
} from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { listPurchaseOrders, createPurchaseOrder } from '../../api/purchaseOrders.js'

const { Title } = Typography

export default function PurchaseOrdersList() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [form] = Form.useForm()

  const { data, isLoading } = useQuery({
    queryKey: ['purchase-orders'],
    queryFn: () => listPurchaseOrders({ limit: 50 }),
  })

  const pos = data?.purchaseOrders ?? data?.purchase_orders ?? []

  const createMutation = useMutation({
    mutationFn: (values) => createPurchaseOrder(values),
    onSuccess: () => {
      message.success('Purchase order recorded')
      setModalOpen(false)
      form.resetFields()
      qc.invalidateQueries({ queryKey: ['purchase-orders'] })
    },
    onError: (err) => message.error(err.response?.data?.error ?? 'Failed to create PO'),
  })

  const columns = [
    {
      title: 'PO Number',
      dataIndex: 'po_number',
      key: 'po_number',
      render: (v) => <strong>{v}</strong>,
    },
    {
      title: 'Client',
      key: 'client',
      render: (_, row) => row.client_name ?? '—',
    },
    {
      title: 'Order Ref',
      dataIndex: 'order_reference',
      key: 'order_reference',
      render: (v) => v ?? '—',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (s) => (
        <Tag color={s === 'accepted' ? 'success' : s === 'rejected' ? 'error' : 'processing'}>
          {s ? s.charAt(0).toUpperCase() + s.slice(1) : '—'}
        </Tag>
      ),
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      render: (v) => v != null ? `R ${Number(v).toFixed(2)}` : '—',
    },
    {
      title: 'Received',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v) => dayjs(v).format('DD MMM YYYY'),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>Purchase Orders</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
          Record PO
        </Button>
      </div>

      <Card>
        <Table
          dataSource={pos}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          size="middle"
          pagination={{ pageSize: 20 }}
        />
      </Card>

      <Modal
        title="Record Purchase Order"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields() }}
        footer={null}
        width={480}
      >
        <Form form={form} layout="vertical" onFinish={(v) => createMutation.mutate(v)} style={{ marginTop: 16 }}>
          <Form.Item name="poNumber" label="PO Number" rules={[{ required: true }]}>
            <Input placeholder="e.g. PO-2025-001" />
          </Form.Item>
          <Form.Item name="quotationId" label="Quotation ID" rules={[{ required: true }]}>
            <Input placeholder="UUID of the related quotation" />
          </Form.Item>
          <Form.Item name="amount" label="PO Amount (R)">
            <Input type="number" placeholder="0.00" />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Button onClick={() => { setModalOpen(false); form.resetFields() }} style={{ marginRight: 8 }}>
              Cancel
            </Button>
            <Button type="primary" htmlType="submit" loading={createMutation.isPending}>
              Record
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

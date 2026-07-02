import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table, Card, Typography, Button, Tag, Modal, Form, Input, InputNumber, Select, message,
} from 'antd'
import { PlusOutlined, EditOutlined } from '@ant-design/icons'
import { listProducts, createProduct, updateProduct } from '../../api/products.js'

const { Title } = Typography

const CATEGORIES = ['uniform', 'corporate', 'hospitality', 'sports', 'accessories', 'other']
const CLIENT_TYPES = ['retail', 'school', 'corporate', 'hospitality', 'church', 'security', 'government', 'reseller']

export default function ProductsList() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form] = Form.useForm()

  const { data, isLoading } = useQuery({
    queryKey: ['products'],
    queryFn: () => listProducts({ limit: 100 }),
  })

  const products = data?.products ?? []

  const saveMutation = useMutation({
    mutationFn: (values) =>
      editing ? updateProduct(editing.id, values) : createProduct(values),
    onSuccess: () => {
      message.success(editing ? 'Product updated' : 'Product created')
      setModalOpen(false)
      setEditing(null)
      form.resetFields()
      qc.invalidateQueries({ queryKey: ['products'] })
    },
    onError: (err) => message.error(err.response?.data?.error ?? 'Failed to save product'),
  })

  const openEdit = (product) => {
    setEditing(product)
    form.setFieldsValue(product)
    setModalOpen(true)
  }

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  const columns = [
    { title: 'Name', dataIndex: 'name', key: 'name', render: (v) => <strong>{v}</strong> },
    {
      title: 'Category',
      dataIndex: 'category',
      key: 'category',
      render: (v) => <Tag>{v}</Tag>,
    },
    {
      title: 'Client Type',
      dataIndex: 'client_type',
      key: 'client_type',
      render: (v) => v ? <Tag color="blue">{v}</Tag> : '—',
    },
    {
      title: 'Unit Price',
      dataIndex: 'unit_price',
      key: 'unit_price',
      render: (v) => v != null ? `R ${Number(v).toFixed(2)}` : '—',
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
    },
    {
      title: '',
      key: 'actions',
      render: (_, row) => (
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
          Edit
        </Button>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>Product Catalog</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Add Product
        </Button>
      </div>

      <Card>
        <Table
          dataSource={products}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          size="middle"
          pagination={{ pageSize: 20 }}
        />
      </Card>

      <Modal
        title={editing ? 'Edit Product' : 'Add Product'}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setEditing(null); form.resetFields() }}
        footer={null}
        width={480}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMutation.mutate(v)} style={{ marginTop: 16 }}>
          <Form.Item name="name" label="Product Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="category" label="Category" rules={[{ required: true }]}>
            <Select options={CATEGORIES.map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))} />
          </Form.Item>
          <Form.Item name="client_type" label="Client Type (optional)">
            <Select
              allowClear
              options={CLIENT_TYPES.map((t) => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))}
            />
          </Form.Item>
          <Form.Item name="unit_price" label="Unit Price (R)">
            <InputNumber min={0} precision={2} prefix="R" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Button onClick={() => { setModalOpen(false); setEditing(null) }} style={{ marginRight: 8 }}>
              Cancel
            </Button>
            <Button type="primary" htmlType="submit" loading={saveMutation.isPending}>
              {editing ? 'Update' : 'Create'}
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

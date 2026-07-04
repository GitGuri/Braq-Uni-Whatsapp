import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table, Card, Typography, Button, Tag, Modal, Form, Input, InputNumber, Select, message, Space,
} from 'antd'
import { PlusOutlined, EditOutlined } from '@ant-design/icons'
import { listProducts, createProduct, updateProduct } from '../../api/products.js'

const { Title, Text } = Typography

const CATEGORIES = ['uniform', 'corporate', 'hospitality', 'sports', 'accessories', 'other']
const CLIENT_TYPES = ['retail', 'school', 'corporate', 'hospitality', 'church', 'security', 'government', 'reseller']

function sizesArrayToString(sizes) {
  if (!sizes) return ''
  if (Array.isArray(sizes)) return sizes.join(', ')
  return sizes
}

function sizesStringToArray(str) {
  if (!str?.trim()) return []
  return str.split(',').map((s) => s.trim()).filter(Boolean)
}

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
    mutationFn: (values) => {
      const payload = {
        name:       values.name,
        category:   values.category,
        price:      values.price,
        currency:   values.currency || 'ZAR',
        clientType: values.clientType || null,
        sizes:      sizesStringToArray(values.sizes),
      }
      return editing ? updateProduct(editing.id, payload) : createProduct(payload)
    },
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
    form.setFieldsValue({
      name:       product.name,
      category:   product.category,
      price:      Number(product.price),
      currency:   product.currency || 'ZAR',
      clientType: product.client_type,
      sizes:      sizesArrayToString(product.sizes),
    })
    setModalOpen(true)
  }

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ currency: 'ZAR' })
    setModalOpen(true)
  }

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (v) => <Text strong>{v}</Text>,
    },
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
      render: (v) => v ? <Tag color="blue">{v}</Tag> : <Text type="secondary">All</Text>,
    },
    {
      title: 'Sizes',
      dataIndex: 'sizes',
      key: 'sizes',
      render: (v) => {
        const arr = Array.isArray(v) ? v : []
        return arr.length
          ? arr.map((s) => <Tag key={s} style={{ marginBottom: 2 }}>{s}</Tag>)
          : <Text type="secondary">—</Text>
      },
    },
    {
      title: 'Unit Price',
      dataIndex: 'price',
      key: 'price',
      render: (v, row) => v != null
        ? <Text strong>R {Number(v).toFixed(2)}</Text>
        : <Text type="secondary">—</Text>,
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
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMutation.mutate(v)} style={{ marginTop: 16 }}>
          <Form.Item name="name" label="Product Name" rules={[{ required: true, message: 'Required' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="category" label="Category" rules={[{ required: true, message: 'Required' }]}>
            <Select options={CATEGORIES.map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))} />
          </Form.Item>
          <Form.Item name="clientType" label="Client Type (optional — leave blank for all)">
            <Select
              allowClear
              options={CLIENT_TYPES.map((t) => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))}
            />
          </Form.Item>
          <Space style={{ width: '100%' }}>
            <Form.Item name="price" label="Unit Price" rules={[{ required: true, message: 'Required' }]} style={{ flex: 1 }}>
              <InputNumber min={0} precision={2} prefix="R" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="currency" label="Currency" initialValue="ZAR" style={{ width: 90 }}>
              <Select options={[{ value: 'ZAR', label: 'ZAR' }, { value: 'USD', label: 'USD' }]} />
            </Form.Item>
          </Space>
          <Form.Item
            name="sizes"
            label="Available Sizes"
            extra="Comma-separated, e.g. XS, S, M, L, XL, XXL"
          >
            <Input placeholder="XS, S, M, L, XL, XXL" />
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

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Tabs, Card, Table, Typography, Button, Tag, Modal, Form, Input, InputNumber,
  Select, Switch, message, Space,
} from 'antd'
import { PlusOutlined, EditOutlined } from '@ant-design/icons'
import { listProducts, createProduct, updateProduct } from '../../api/products.js'

const { Text } = Typography

const CATEGORIES = [
  { value: 'school_wear',   label: 'School Wear' },
  { value: 'knitwear',      label: 'Knitwear' },
  { value: 'medical_wear',  label: 'Medical Wear' },
  { value: 'outdoor_wear',  label: 'Outdoor Wear' },
  { value: 'corporate_wear',label: 'Corporate Wear' },
  { value: 'safety_wear',   label: 'Safety Wear' },
]

function ProductModal({ open, onClose, initial, onSave, loading }) {
  const [form] = Form.useForm()
  const category = Form.useWatch('category', form)

  function handleOk() {
    form.validateFields().then(vals => {
      onSave({ ...vals, sizes: (vals.sizes ?? '').split(',').map(s => s.trim()).filter(Boolean) })
    })
  }

  return (
    <Modal
      title={initial ? 'Edit Product' : 'Add Product'}
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      okText={initial ? 'Save' : 'Add'}
      okButtonProps={{ loading }}
      afterOpenChange={(v) => {
        if (v && initial) {
          form.setFieldsValue({
            ...initial,
            sizes: Array.isArray(initial.sizes) ? initial.sizes.join(', ') : '',
          })
        } else if (v) {
          form.resetFields()
        }
      }}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
        <Form.Item label="Category" name="category" rules={[{ required: true }]}>
          <Select options={CATEGORIES} placeholder="Select category" />
        </Form.Item>

        {category === 'school_wear' && (
          <Form.Item label="School Name" name="schoolName">
            <Input placeholder="e.g. Laerskool Dalview (leave blank for generic school wear)" />
          </Form.Item>
        )}

        <Form.Item label="Product Name" name="name" rules={[{ required: true }]}>
          <Input placeholder="e.g. Polo Shirt" />
        </Form.Item>

        <Form.Item label="Price (ZAR)" name="price" rules={[{ required: true }]}>
          <InputNumber min={0} step={0.5} prefix="R" style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item label="Sizes (comma-separated)" name="sizes" help='e.g. XS, S, M, L, XL or 6, 8, 10, 12'>
          <Input placeholder="XS, S, M, L, XL" />
        </Form.Item>

        <Form.Item label="Description (optional)" name="description">
          <Input.TextArea rows={2} />
        </Form.Item>

        <Form.Item label="Active" name="isActive" valuePropName="checked" initialValue={true}>
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  )
}

export default function ProductsList() {
  const qc        = useQueryClient()
  const [editing, setEditing]   = useState(null)
  const [adding,  setAdding]    = useState(false)
  const [msgApi, ctx] = message.useMessage()

  const { data, isLoading } = useQuery({
    queryKey: ['products'],
    queryFn:  () => listProducts({}),
  })

  const createMutation = useMutation({
    mutationFn: createProduct,
    onSuccess: () => {
      msgApi.success('Product added')
      setAdding(false)
      qc.invalidateQueries({ queryKey: ['products'] })
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Failed to add product'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateProduct(id, data),
    onSuccess: () => {
      msgApi.success('Product updated')
      setEditing(null)
      qc.invalidateQueries({ queryKey: ['products'] })
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Failed to update'),
  })

  const products = data?.products ?? []

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      render: (v, r) => (
        <div>
          <Text strong style={{ fontSize: 13 }}>{v}</Text>
          {r.school_name && <div><Text type="secondary" style={{ fontSize: 11 }}>🏫 {r.school_name}</Text></div>}
          {r.description && <div><Text type="secondary" style={{ fontSize: 11 }}>{r.description}</Text></div>}
        </div>
      ),
    },
    {
      title: 'Sizes',
      dataIndex: 'sizes',
      render: (v) => Array.isArray(v) && v.length ? v.join(', ') : '—',
    },
    {
      title: 'Price',
      dataIndex: 'price',
      render: (v, r) => `${r.currency ?? 'ZAR'} ${Number(v).toFixed(2)}`,
    },
    {
      title: 'Status',
      dataIndex: 'is_active',
      render: (v) => <Tag color={v ? 'green' : 'default'}>{v ? 'Active' : 'Inactive'}</Tag>,
    },
    {
      title: '',
      render: (_, r) => (
        <Button size="small" icon={<EditOutlined />} onClick={e => { e.stopPropagation(); setEditing(r) }}>
          Edit
        </Button>
      ),
    },
  ]

  const tabItems = CATEGORIES.map(cat => ({
    key:   cat.value,
    label: cat.label,
    children: (
      <Table
        dataSource={products.filter(p => p.category === cat.value)}
        columns={columns}
        rowKey="id"
        size="small"
        pagination={false}
        loading={isLoading}
      />
    ),
  }))

  return (
    <>
      {ctx}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Text style={{ fontSize: 18, fontWeight: 700 }}>Products</Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
          Add Product
        </Button>
      </div>

      <Card style={{ borderRadius: 10 }} bodyStyle={{ padding: '0 16px 16px' }}>
        <Tabs items={tabItems} />
      </Card>

      <ProductModal
        open={adding}
        onClose={() => setAdding(false)}
        onSave={(vals) => createMutation.mutate(vals)}
        loading={createMutation.isPending}
      />

      <ProductModal
        open={!!editing}
        initial={editing}
        onClose={() => setEditing(null)}
        onSave={(vals) => updateMutation.mutate({ id: editing?.id, data: vals })}
        loading={updateMutation.isPending}
      />
    </>
  )
}

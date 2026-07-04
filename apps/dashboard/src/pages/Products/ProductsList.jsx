import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Row, Col, Card, Typography, Button, Tag, Modal, Form, Input, InputNumber,
  Checkbox, message, Drawer, Table,
} from 'antd'
import {
  PlusOutlined, EditOutlined, ReadOutlined, MedicineBoxOutlined,
  CompassOutlined, BankOutlined, ToolOutlined, SkinOutlined,
} from '@ant-design/icons'
import { listProducts, createProduct, updateProduct } from '../../api/products.js'

const { Title, Text } = Typography

const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL']

const CATEGORIES = [
  {
    key:   'school_wear',
    label: 'School Wear',
    icon:  <ReadOutlined style={{ fontSize: 26 }} />,
    color: '#1677ff',
    desc:  'Ties, socks, jerseys, skirts, shorts, trousers, blazers, windbreakers, shirts',
  },
  {
    key:   'knitwear',
    label: 'Knitwear',
    icon:  <SkinOutlined style={{ fontSize: 26 }} />,
    color: '#722ed1',
    desc:  'Knitted garments and knitwear products',
  },
  {
    key:   'medical_wear',
    label: 'Medical Wear',
    icon:  <MedicineBoxOutlined style={{ fontSize: 26 }} />,
    color: '#eb2f96',
    desc:  'Scrubs, doctors coats, surgical gowns, patient gowns',
  },
  {
    key:   'outdoor_wear',
    label: 'Outdoor Wear',
    icon:  <CompassOutlined style={{ fontSize: 26 }} />,
    color: '#52c41a',
    desc:  'Outdoor and activewear garments',
  },
  {
    key:   'corporate_wear',
    label: 'Corporate Wear',
    icon:  <BankOutlined style={{ fontSize: 26 }} />,
    color: '#d46b08',
    desc:  'Shirts, blazers, pencil skirts, chino pants, trousers, ties, polo shirts',
  },
  {
    key:   'safety_wear',
    label: 'Safety Wear',
    icon:  <ToolOutlined style={{ fontSize: 26 }} />,
    color: '#cf1322',
    desc:  'Denim worksuits, polyester worksuits, safety aprons, heavy duty work pants',
  },
]

export default function ProductsList() {
  const qc = useQueryClient()
  const [activeCategory, setActiveCategory] = useState(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form] = Form.useForm()

  const { data, isLoading } = useQuery({
    queryKey: ['products'],
    queryFn: () => listProducts({}),
  })

  const allProducts = data?.products ?? []
  const categoryConfig = CATEGORIES.find((c) => c.key === activeCategory)
  const categoryProducts = activeCategory
    ? allProducts.filter((p) => p.category === activeCategory)
    : []

  const saveMutation = useMutation({
    mutationFn: (values) => {
      const payload = {
        name:     values.name,
        category: values.category,
        price:    values.price,
        currency: 'ZAR',
        sizes:    values.sizes || [],
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

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ category: activeCategory })
    setModalOpen(true)
  }

  const openEdit = (product) => {
    setEditing(product)
    form.setFieldsValue({
      name:     product.name,
      category: product.category,
      price:    Number(product.price),
      sizes:    Array.isArray(product.sizes) ? product.sizes : [],
    })
    setModalOpen(true)
  }

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      render: (v) => <Text strong>{v}</Text>,
    },
    {
      title: 'Sizes',
      dataIndex: 'sizes',
      render: (v) => {
        const arr = Array.isArray(v) ? v : []
        return arr.length
          ? arr.map((s) => <Tag key={s}>{s}</Tag>)
          : <Text type="secondary">—</Text>
      },
    },
    {
      title: 'Unit Price',
      dataIndex: 'price',
      render: (v) => v != null
        ? <Text strong>R {Number(v).toFixed(2)}</Text>
        : <Text type="secondary">—</Text>,
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_, row) => (
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
          Edit
        </Button>
      ),
    },
  ]

  return (
    <div>
      <Title level={4} style={{ marginBottom: 20 }}>Product Catalog</Title>

      <Row gutter={[16, 16]}>
        {CATEGORIES.map((cat) => {
          const count = allProducts.filter((p) => p.category === cat.key).length
          return (
            <Col xs={24} sm={12} lg={8} key={cat.key}>
              <Card
                hoverable
                onClick={() => setActiveCategory(cat.key)}
                style={{ borderRadius: 10, borderTop: `3px solid ${cat.color}`, cursor: 'pointer' }}
                bodyStyle={{ padding: '20px 24px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{
                    width: 56, height: 56, borderRadius: 12, flexShrink: 0,
                    background: `${cat.color}18`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: cat.color,
                  }}>
                    {cat.icon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{cat.label}</div>
                    <div style={{ fontSize: 11, color: '#888', marginTop: 2, lineHeight: 1.4 }}>
                      {cat.desc}
                    </div>
                    <Tag color={cat.color} style={{ marginTop: 8, fontSize: 11 }}>
                      {count} product{count !== 1 ? 's' : ''}
                    </Tag>
                  </div>
                </div>
              </Card>
            </Col>
          )
        })}
      </Row>

      {/* Category drawer */}
      <Drawer
        title={
          categoryConfig && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: categoryConfig.color }}>{categoryConfig.icon}</span>
              <span>{categoryConfig.label}</span>
            </div>
          )
        }
        open={!!activeCategory}
        onClose={() => setActiveCategory(null)}
        width={700}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Add Product
          </Button>
        }
      >
        <Table
          dataSource={categoryProducts}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          size="middle"
          pagination={{ pageSize: 20 }}
          locale={{ emptyText: 'No products yet — click Add Product to get started.' }}
        />
      </Drawer>

      {/* Add / Edit modal */}
      <Modal
        title={
          editing
            ? `Edit — ${editing.name}`
            : `New Product — ${categoryConfig?.label ?? ''}`
        }
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setEditing(null); form.resetFields() }}
        footer={null}
        width={480}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => saveMutation.mutate(v)}
          style={{ marginTop: 16 }}
        >
          <Form.Item name="category" hidden><Input /></Form.Item>

          <Form.Item name="name" label="Product Name" rules={[{ required: true, message: 'Required' }]}>
            <Input placeholder="e.g. Polo Shirt" />
          </Form.Item>

          <Form.Item name="price" label="Unit Price (ZAR)" rules={[{ required: true, message: 'Required' }]}>
            <InputNumber min={0} precision={2} prefix="R" style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item name="sizes" label="Available Sizes">
            <Checkbox.Group>
              <Row gutter={[8, 8]}>
                {SIZES.map((s) => (
                  <Col key={s}>
                    <Checkbox value={s}>{s}</Checkbox>
                  </Col>
                ))}
              </Row>
            </Checkbox.Group>
          </Form.Item>

          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Button
              onClick={() => { setModalOpen(false); setEditing(null) }}
              style={{ marginRight: 8 }}
            >
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

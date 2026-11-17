import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Tabs, Table, Button, Modal, Form, Input, InputNumber,
  Select, Switch, message,
} from 'antd'
import { PlusOutlined, EditOutlined } from '@ant-design/icons'
import { listProducts, createProduct, updateProduct } from '../../api/products.js'
import { errorMessage } from '../../utils/errorMessage.js'
import { useCan } from '../../lib/useCan.js'
import { money } from '../../lib/format.js'
import ErrorState from '../../components/ErrorState.jsx'

const CATEGORIES = [
  { value: 'school_wear',   label: 'School wear' },
  { value: 'knitwear',      label: 'Knitwear' },
  { value: 'medical_wear',  label: 'Medical wear' },
  { value: 'outdoor_wear',  label: 'Outdoor wear' },
  { value: 'corporate_wear',label: 'Corporate wear' },
  { value: 'safety_wear',   label: 'Safety wear' },
]

function ProductModal({ open, onClose, initial, onSave, loading }) {
  const [form] = Form.useForm()
  const category = Form.useWatch('category', form)

  function handleOk() {
    form.validateFields().then(vals => {
      // Blank optional text: clear it (null) when editing, omit it when creating.
      const blank = initial ? null : undefined
      const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : blank)
      onSave({
        ...vals,
        schoolName:  vals.category === 'school_wear' ? text(vals.schoolName) : blank,
        description: text(vals.description),
        sizes: (vals.sizes ?? '').split(',').map(s => s.trim()).filter(Boolean),
      })
    }).catch(() => {})
  }

  return (
    <Modal
      title={initial ? 'Edit product' : 'Add product'}
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      okText={initial ? 'Save changes' : 'Add product'}
      okButtonProps={{ loading }}
      afterOpenChange={(v) => {
        if (v && initial) {
          // API rows are snake_case; the form (and the PATCH body) are camelCase.
          form.resetFields()
          form.setFieldsValue({
            category:    initial.category,
            name:        initial.name,
            schoolName:  initial.school_name ?? undefined,
            price:       initial.price != null ? Number(initial.price) : undefined,
            sizes:       Array.isArray(initial.sizes) ? initial.sizes.join(', ') : '',
            description: initial.description ?? undefined,
            isActive:    initial.is_active !== false,
          })
        } else if (v) {
          form.resetFields()
        }
      }}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
        <Form.Item label="Category" name="category" rules={[{ required: true }]}>
          <Select options={CATEGORIES} placeholder="Choose a category" />
        </Form.Item>

        {category === 'school_wear' && (
          <Form.Item label="School" name="schoolName">
            <Input placeholder="e.g. Laerskool Dalview. Leave blank for generic school wear." />
          </Form.Item>
        )}

        <Form.Item label="Product name" name="name" rules={[{ required: true }]}>
          <Input placeholder="e.g. Polo Shirt" />
        </Form.Item>

        <Form.Item label="Price per unit" name="price" rules={[{ required: true }]}>
          <InputNumber min={0} step={0.5} precision={2} prefix="R" style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item label="Sizes" name="sizes" help="Separate sizes with commas, e.g. XS, S, M, L, XL or 6, 8, 10, 12">
          <Input placeholder="XS, S, M, L, XL" />
        </Form.Item>

        <Form.Item label="Description (optional)" name="description">
          <Input.TextArea rows={2} />
        </Form.Item>

        <Form.Item label="Show in quotations and on WhatsApp" name="isActive" valuePropName="checked" initialValue={true}>
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  )
}

export default function ProductsList() {
  const qc        = useQueryClient()
  const can       = useCan()
  // The API only lets admins and managers create or change products.
  const canEdit   = can('product.write')
  const [editing, setEditing]   = useState(null)
  const [adding,  setAdding]    = useState(false)
  const [msgApi, ctx] = message.useMessage()

  const { data, isLoading, error, refetch } = useQuery({
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
    onError: (err) => msgApi.error(errorMessage(err, 'Could not add the product')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateProduct(id, data),
    onSuccess: () => {
      msgApi.success('Product updated')
      setEditing(null)
      qc.invalidateQueries({ queryKey: ['products'] })
    },
    onError: (err) => msgApi.error(errorMessage(err, 'Could not save the product')),
  })

  const products = data?.products ?? []

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      render: (v, r) => (
        <div style={{ minWidth: 180, maxWidth: 420 }}>
          <div style={{ fontWeight: 600 }}>{v}</div>
          {r.school_name && <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>{r.school_name}</div>}
          {r.description && <div style={{ fontSize: 13, color: 'var(--ink-3)', whiteSpace: 'normal' }}>{r.description}</div>}
        </div>
      ),
    },
    {
      title: 'Sizes',
      dataIndex: 'sizes',
      render: (v) => (Array.isArray(v) && v.length
        ? <span style={{ color: 'var(--ink-2)' }}>{v.join(', ')}</span>
        : <span style={{ color: 'var(--ink-3)' }}>—</span>),
    },
    {
      title: 'Price',
      dataIndex: 'price',
      align: 'right',
      render: (v, r) => (
        <span style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>
          {money(v, { currency: r.currency })}
        </span>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'is_active',
      render: (v) => <span className={`braq-pill ${v ? 'green' : ''}`}>{v ? 'Active' : 'Hidden'}</span>,
    },
    ...(canEdit ? [{
      title: '',
      render: (_, r) => (
        <Button size="small" icon={<EditOutlined />} aria-label={`Edit ${r.name}`} onClick={e => { e.stopPropagation(); setEditing(r) }}>
          Edit
        </Button>
      ),
    }] : []),
  ]

  const tabItems = CATEGORIES.map(cat => {
    const rows = products.filter(p => p.category === cat.value)
    return {
    key:   cat.value,
    label: (
      <span>
        {cat.label}
        {!isLoading && <span style={{ marginLeft: 6, color: 'var(--ink-3)', fontWeight: 400 }}>{rows.length}</span>}
      </span>
    ),
    children: (
      <Table
        dataSource={rows}
        columns={columns}
        rowKey="id"
        size="small"
        pagination={false}
        loading={isLoading}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: canEdit ? `No ${cat.label.toLowerCase()} yet. Use Add product to create one.` : `No ${cat.label.toLowerCase()} yet.` }}
      />
    ),
    }
  })

  return (
    <>
      {ctx}
      <div>

      <div className="braq-page-header">
        <div>
          <h1 className="braq-page-title">Products</h1>
          <div className="braq-page-subtitle">The garments you sell, with their prices and sizes. Quotations are priced from this list.</div>
        </div>
        {canEdit && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
            Add product
          </Button>
        )}
      </div>

      <section className="braq-panel" style={{ padding: '0 16px 12px', minWidth: 0 }}>
        {/* A failed load is not an empty catalogue. */}
        {error
          ? <div style={{ paddingTop: 12 }}><ErrorState title="Could not load products" error={error} onRetry={refetch} /></div>
          : <Tabs items={tabItems} />}
      </section>

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
      </div>
    </>
  )
}

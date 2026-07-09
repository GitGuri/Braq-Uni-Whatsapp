import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Row, Col, Card, Button, Input, InputNumber, Select, Typography,
  Space, Tag, Divider, Alert, Spin, Tooltip, message, AutoComplete, Modal, Form,
} from 'antd'
import {
  PlusOutlined, DeleteOutlined, ArrowLeftOutlined, CheckOutlined,
  UserOutlined, PhoneOutlined, MessageOutlined, SwapOutlined, FilePdfOutlined,
} from '@ant-design/icons'
import { getQuotation, approveQuotation, claimQuotation } from '../../api/quotations.js'
import { listProducts } from '../../api/products.js'
import { convertFromQuotation } from '../../api/orders.js'

const { Text, Title } = Typography

const BRANDING_SURCHARGES = {
  none: 0, embroidery: 15, screen_print: 12, sublimation: 25, heat_transfer: 10,
}
const BRANDING_OPTIONS = [
  { value: 'none',          label: 'No Branding' },
  { value: 'embroidery',    label: 'Embroidery (+R15/unit)' },
  { value: 'screen_print',  label: 'Screen Print (+R12/unit)' },
  { value: 'sublimation',   label: 'Sublimation (+R25/unit)' },
  { value: 'heat_transfer', label: 'Heat Transfer (+R10/unit)' },
]
const BRANDING_POSITIONS = [
  'Left Chest', 'Right Chest', 'Centre Front', 'Full Back',
  'Left Sleeve', 'Right Sleeve', 'Other',
]
const SIZE_PRESETS = {
  Adults:  ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'],
  Kids:    ['4', '6', '8', '10', '12', '14'],
  Numeric: ['30', '32', '34', '36', '38', '40', '42'],
}
const SIZE_ORDER = [
  'XS','S','M','L','XL','XXL','3XL','4XL',
  '2','4','6','8','10','12','14',
  '30','32','34','36','38','40','42','44',
]

let _keySeq = 0
function makeKey() { return ++_keySeq }

function blankItem() {
  return {
    _key: makeKey(),
    productId: null,
    name: '',
    category: 'custom',
    colour: '',
    sizes: [],
    unitPrice: 0,
    branding: { type: 'none', position: '', detail: '' },
    aiNote: null,
  }
}

function normalizeItem(raw) {
  return {
    _key: makeKey(),
    productId: raw.productId ?? null,
    name: raw.name ?? raw.description ?? '',
    category: raw.category ?? 'custom',
    colour: raw.colour ?? '',
    sizes: Array.isArray(raw.sizes) ? raw.sizes : [],
    unitPrice: Number(raw.unitPrice ?? raw.price ?? 0),
    branding: raw.branding && typeof raw.branding === 'object'
      ? raw.branding
      : { type: 'none', position: '', detail: '' },
    aiNote: raw.aiNote
      ?? (typeof raw.sizes === 'string' && raw.sizes ? `Customer requested: ${raw.sizes}` : null)
      ?? (raw.aiNotes ?? null),
  }
}

function deriveItem(item) {
  const qty = item.sizes.reduce((s, sz) => s + (Number(sz.qty) || 0), 0)
  const surcharge = BRANDING_SURCHARGES[item.branding?.type] || 0
  const effectiveUnitPrice = Number(item.unitPrice || 0) + surcharge
  return { ...item, quantity: qty, brandingSurcharge: surcharge, effectiveUnitPrice, lineTotal: effectiveUnitPrice * qty }
}

function sortedSizes(sizes) {
  return [...sizes].sort((a, b) => {
    const ai = SIZE_ORDER.indexOf(a.size), bi = SIZE_ORDER.indexOf(b.size)
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
  })
}

export default function QuotationBuilder() {
  const { id }   = useParams()
  const navigate = useNavigate()
  const qc       = useQueryClient()
  const [items, setItems]             = useState([])
  const [custInputs, setCustInputs]   = useState({})
  const [convertModal, setConvertModal] = useState(false)
  const [convertForm]                 = Form.useForm()
  const [msgApi, ctx]                 = message.useMessage()

  const { data: qData, isLoading } = useQuery({
    queryKey: ['quotation', id],
    queryFn:  () => getQuotation(id),
  })

  const { data: pData } = useQuery({
    queryKey: ['products'],
    queryFn:  () => listProducts({}),
  })

  const claimMut = useMutation({
    mutationFn: () => claimQuotation(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['quotation', id] }),
    onError:    () => {},
  })

  useEffect(() => {
    const q = qData?.quotation
    if (!q) return
    setItems((q.line_items ?? []).map(normalizeItem))
    if (!q.assigned_staff_id) claimMut.mutate()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qData?.quotation?.id])

  const approveMut = useMutation({
    mutationFn: () => approveQuotation(id, items.map(deriveItem)),
    onSuccess: (data) => {
      if (data?.whatsappSent) msgApi.success('Approved — PDF sent to client via WhatsApp ✅')
      else msgApi.warning('Quotation approved. WhatsApp delivery failed — send PDF manually')
      qc.invalidateQueries({ queryKey: ['quotations'] })
      qc.invalidateQueries({ queryKey: ['dashboard-kpis'] })
      navigate('/quotations')
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Approval failed'),
  })

  const convertMut = useMutation({
    mutationFn: (vals) => convertFromQuotation(id, vals),
    onSuccess: (res) => {
      msgApi.success(`Order ${res.order.reference} created`)
      setConvertModal(false)
      qc.invalidateQueries({ queryKey: ['quotations'] })
      navigate(`/orders/${res.order.id}`)
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Conversion failed'),
  })

  function updateItem(idx, patch) {
    setItems(prev => { const n = [...prev]; n[idx] = { ...n[idx], ...patch }; return n })
  }

  function updateBranding(idx, patch) {
    setItems(prev => {
      const n = [...prev]
      n[idx] = { ...n[idx], branding: { ...n[idx].branding, ...patch } }
      return n
    })
  }

  function toggleSize(idx, size) {
    setItems(prev => {
      const item = prev[idx]
      const exists = item.sizes.find(s => s.size === size)
      const sizes = exists
        ? item.sizes.filter(s => s.size !== size)
        : sortedSizes([...item.sizes, { size, qty: 0 }])
      const n = [...prev]; n[idx] = { ...item, sizes }; return n
    })
  }

  function setSizeQty(idx, size, qty) {
    setItems(prev => {
      const item = prev[idx]
      const n = [...prev]
      n[idx] = { ...item, sizes: item.sizes.map(s => s.size === size ? { ...s, qty: Number(qty) || 0 } : s) }
      return n
    })
  }

  function addPreset(idx, presetName) {
    setItems(prev => {
      const item = prev[idx]
      const existing = new Set(item.sizes.map(s => s.size))
      const toAdd = (SIZE_PRESETS[presetName] ?? []).filter(s => !existing.has(s)).map(s => ({ size: s, qty: 0 }))
      const n = [...prev]
      n[idx] = { ...item, sizes: sortedSizes([...item.sizes, ...toAdd]) }
      return n
    })
  }

  function addCustomSize(idx) {
    const s = (custInputs[idx] || '').trim().toUpperCase()
    if (!s) return
    toggleSize(idx, s)
    setCustInputs(p => ({ ...p, [idx]: '' }))
  }

  const derived  = items.map(deriveItem)
  const subtotal = derived.reduce((s, i) => s + i.lineTotal, 0)
  const vat      = subtotal * 0.15
  const total    = subtotal + vat
  const deposit  = total * 0.60

  const quot       = qData?.quotation
  const isDraft    = quot?.status === 'draft'
  const isAccepted = quot?.status === 'accepted'
  const hasOrder   = !!quot?.order_id
  const products   = pData?.products ?? []

  const canApprove = derived.length > 0 && derived.every(i => i.name.trim())

  if (isLoading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
  if (!quot)    return <Text type="danger">Quotation not found.</Text>

  const productOptions = products.map(p => ({
    value: p.name,
    label: `${p.name}  —  R${Number(p.price || 0).toFixed(2)}`,
    _product: p,
  }))

  return (
    <>
      {ctx}

      {/* Top bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/quotations')}>Quotations</Button>
          <Title level={4} style={{ margin: 0 }}>{quot.reference}</Title>
          <Tag color={
            quot.status === 'draft' ? 'orange' : quot.status === 'sent' ? 'blue' :
            quot.status === 'accepted' ? 'green' : 'red'
          }>{quot.status}</Tag>
          {quot.auto_quoted && (
            <Tag color="purple">AI Auto-Quoted</Tag>
          )}
        </Space>
        <Space>
          {!isDraft && (
            <Button
              icon={<FilePdfOutlined />}
              onClick={() => window.open(`/api/quotations/${id}/pdf`, '_blank')}
            >
              View PDF
            </Button>
          )}
          {isAccepted && !hasOrder && (
            <Button
              icon={<SwapOutlined />}
              onClick={() => { convertForm.resetFields(); setConvertModal(true) }}
            >
              Convert to Order
            </Button>
          )}
          {hasOrder && (
            <Button type="default" onClick={() => navigate(`/orders/${quot.order_id}`)}>
              View Order →
            </Button>
          )}
          {isDraft && (
            <Tooltip title={!canApprove ? 'All items need a name' : ''}>
              <Button
                type="primary"
                size="large"
                icon={<CheckOutlined />}
                loading={approveMut.isPending}
                disabled={!canApprove}
                onClick={() => approveMut.mutate()}
                style={{ background: '#c0392b', borderColor: '#c0392b', minWidth: 180 }}
              >
                Approve &amp; Send PDF
              </Button>
            </Tooltip>
          )}
        </Space>
      </div>

      {!isDraft && (
        <Alert
          type={isAccepted ? 'success' : quot.status === 'sent' ? 'info' : 'error'}
          message={
            isAccepted ? 'Customer accepted this quotation.' :
            quot.status === 'sent' ? 'Quotation sent to customer — awaiting their response.' :
            'Customer rejected this quotation.'
          }
          style={{ marginBottom: 16 }}
          showIcon
        />
      )}

      <Row gutter={16} align="top">
        {/* Left: context panel */}
        <Col span={7}>
          <Card
            title={<Space><UserOutlined />Client</Space>}
            size="small"
            style={{ marginBottom: 12, borderRadius: 8 }}
          >
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Text strong>{quot.client_name || 'Unknown Client'}</Text>
              {quot.client_org && <Text type="secondary" style={{ fontSize: 12 }}>{quot.client_org}</Text>}
              {quot.client_wa && (
                <Space size={4}>
                  <PhoneOutlined style={{ color: '#52c41a', fontSize: 12 }} />
                  <Text style={{ fontSize: 12 }}>{quot.client_wa}</Text>
                </Space>
              )}
              {quot.client_type && <Tag style={{ marginTop: 2 }}>{quot.client_type}</Tag>}
            </Space>
          </Card>

          {quot.notes && (
            <Card
              title={<Space><MessageOutlined />Customer Request</Space>}
              size="small"
              style={{ borderRadius: 8 }}
              styles={{ body: { maxHeight: 320, overflowY: 'auto' } }}
            >
              <Text style={{ fontSize: 12, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                {quot.notes}
              </Text>
            </Card>
          )}
        </Col>

        {/* Right: item builder */}
        <Col span={17}>
          {items.map((item, idx) => {
            const d = deriveItem(item)
            return (
              <Card
                key={item._key}
                size="small"
                style={{ marginBottom: 12, borderRadius: 8, borderLeft: '3px solid #c0392b' }}
                title={<Text strong style={{ fontSize: 13 }}>Item {idx + 1}</Text>}
                extra={
                  <Button
                    size="small" danger type="text" icon={<DeleteOutlined />}
                    onClick={() => setItems(p => p.filter((_, i) => i !== idx))}
                  />
                }
              >
                {/* Name + Colour */}
                <Row gutter={10} style={{ marginBottom: 12 }}>
                  <Col span={15}>
                    <Text style={{ fontSize: 11, display: 'block', marginBottom: 3, color: '#aaa' }}>
                      Description / Product
                    </Text>
                    <AutoComplete
                      value={item.name}
                      options={productOptions}
                      onSelect={(_, opt) => updateItem(idx, {
                        name: opt._product.name,
                        productId: opt._product.id,
                        category: opt._product.category,
                        unitPrice: Number(opt._product.price || 0),
                      })}
                      onChange={(v) => updateItem(idx, { name: v, productId: null })}
                      filterOption={(input, opt) =>
                        opt.value.toLowerCase().includes(input.toLowerCase())
                      }
                      style={{ width: '100%' }}
                    >
                      <Input placeholder="Search catalog or type custom item name..." />
                    </AutoComplete>
                  </Col>
                  <Col span={9}>
                    <Text style={{ fontSize: 11, display: 'block', marginBottom: 3, color: '#aaa' }}>Colour</Text>
                    <Input
                      value={item.colour}
                      onChange={e => updateItem(idx, { colour: e.target.value })}
                      placeholder="e.g. Navy Blue"
                    />
                  </Col>
                </Row>

                {item.aiNote && (
                  <Alert
                    type="info"
                    showIcon
                    message={item.aiNote}
                    style={{ marginBottom: 12, fontSize: 12 }}
                  />
                )}

                {/* Sizes */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <Text style={{ fontSize: 12, fontWeight: 600 }}>Sizes &amp; Quantities</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Total: <strong>{d.quantity}</strong> units
                    </Text>
                  </div>

                  {/* Preset buttons */}
                  <Space size={6} style={{ marginBottom: 10, flexWrap: 'wrap' }}>
                    <Text type="secondary" style={{ fontSize: 11 }}>Quick add:</Text>
                    {Object.keys(SIZE_PRESETS).map(preset => (
                      <Button key={preset} size="small" onClick={() => addPreset(idx, preset)}>
                        + {preset}
                      </Button>
                    ))}
                  </Space>

                  {/* Active sizes */}
                  {item.sizes.length === 0 ? (
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                      No sizes added — click a preset above or use custom below
                    </Text>
                  ) : (
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10, alignItems: 'flex-start' }}>
                      {item.sizes.map(({ size, qty }) => (
                        <div key={size} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                          <Tag
                            closable
                            onClose={() => toggleSize(idx, size)}
                            color="blue"
                            style={{ marginRight: 0, cursor: 'default', userSelect: 'none' }}
                          >
                            {size}
                          </Tag>
                          <InputNumber
                            size="small"
                            min={0}
                            style={{ width: 60 }}
                            value={qty}
                            onChange={v => setSizeQty(idx, size, v)}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Custom size input */}
                  <Space.Compact size="small">
                    <Input
                      placeholder="Custom size"
                      style={{ width: 110 }}
                      value={custInputs[idx] || ''}
                      onChange={e => setCustInputs(p => ({ ...p, [idx]: e.target.value }))}
                      onPressEnter={() => addCustomSize(idx)}
                    />
                    <Button icon={<PlusOutlined />} onClick={() => addCustomSize(idx)}>Add</Button>
                  </Space.Compact>
                </div>

                <Divider style={{ margin: '10px 0' }} />

                {/* Branding */}
                <Row gutter={8} style={{ marginBottom: 12 }}>
                  <Col span={24}>
                    <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 8 }}>
                      Branding Specification
                    </Text>
                  </Col>
                  <Col span={8}>
                    <Text style={{ fontSize: 11, display: 'block', marginBottom: 3, color: '#aaa' }}>Type</Text>
                    <Select
                      value={item.branding.type}
                      onChange={v => updateBranding(idx, { type: v })}
                      options={BRANDING_OPTIONS}
                      style={{ width: '100%' }}
                      size="small"
                    />
                  </Col>
                  {item.branding.type !== 'none' && (
                    <>
                      <Col span={7}>
                        <Text style={{ fontSize: 11, display: 'block', marginBottom: 3, color: '#aaa' }}>Position</Text>
                        <Select
                          value={item.branding.position || undefined}
                          onChange={v => updateBranding(idx, { position: v })}
                          options={BRANDING_POSITIONS.map(p => ({ value: p, label: p }))}
                          style={{ width: '100%' }}
                          size="small"
                          placeholder="Select..."
                        />
                      </Col>
                      <Col span={9}>
                        <Text style={{ fontSize: 11, display: 'block', marginBottom: 3, color: '#aaa' }}>Detail / Spec</Text>
                        <Input
                          value={item.branding.detail}
                          onChange={e => updateBranding(idx, { detail: e.target.value })}
                          placeholder="e.g. Logo 8cm, 2 colours"
                          size="small"
                        />
                      </Col>
                    </>
                  )}
                </Row>

                <Divider style={{ margin: '10px 0' }} />

                {/* Pricing */}
                <Row gutter={8} align="middle">
                  <Col span={7}>
                    <Text style={{ fontSize: 11, display: 'block', marginBottom: 3, color: '#aaa' }}>Unit Price (R)</Text>
                    <InputNumber
                      min={0}
                      step={0.5}
                      prefix="R"
                      style={{ width: '100%' }}
                      value={item.unitPrice}
                      onChange={v => updateItem(idx, { unitPrice: Number(v) || 0 })}
                    />
                  </Col>
                  {item.branding.type !== 'none' && (
                    <Col span={6}>
                      <Text style={{ fontSize: 11, display: 'block', marginBottom: 3, color: '#aaa' }}>
                        Branding / unit
                      </Text>
                      <Input
                        readOnly
                        value={`+ R ${d.brandingSurcharge.toFixed(2)}`}
                        style={{ background: 'transparent', color: '#d46b08' }}
                      />
                    </Col>
                  )}
                  <Col span={item.branding.type !== 'none' ? 5 : 10}>
                    <Text style={{ fontSize: 11, display: 'block', marginBottom: 3, color: '#aaa' }}>Eff. unit price</Text>
                    <Input
                      readOnly
                      value={`R ${d.effectiveUnitPrice.toFixed(2)}`}
                      style={{ background: 'transparent', fontWeight: 600 }}
                    />
                  </Col>
                  <Col span={6}>
                    <Text style={{ fontSize: 11, display: 'block', marginBottom: 3, color: '#aaa' }}>Line Total</Text>
                    <Input
                      readOnly
                      value={`R ${d.lineTotal.toFixed(2)}`}
                      style={{ background: 'transparent', fontWeight: 700, fontSize: 15, color: '#c0392b' }}
                    />
                  </Col>
                </Row>
              </Card>
            )
          })}

          {isDraft && (
            <Button
              block
              icon={<PlusOutlined />}
              style={{ marginBottom: 16, borderStyle: 'dashed', height: 44 }}
              onClick={() => setItems(p => [...p, blankItem()])}
            >
              Add Line Item
            </Button>
          )}

          {/* Summary */}
          <Card style={{ borderRadius: 8 }}>
            <div style={{ maxWidth: 320, marginLeft: 'auto' }}>
              <Row justify="space-between" style={{ marginBottom: 6 }}>
                <Text type="secondary">Subtotal</Text>
                <Text>R {subtotal.toFixed(2)}</Text>
              </Row>
              <Row justify="space-between" style={{ marginBottom: 6 }}>
                <Text type="secondary">VAT (15%)</Text>
                <Text>R {vat.toFixed(2)}</Text>
              </Row>
              <Divider style={{ margin: '8px 0' }} />
              <Row justify="space-between" style={{ marginBottom: 10 }}>
                <Text strong style={{ fontSize: 16 }}>TOTAL</Text>
                <Text strong style={{ fontSize: 16 }}>R {total.toFixed(2)}</Text>
              </Row>
              <Row
                justify="space-between"
                style={{ background: '#fff3cd', padding: '8px 12px', borderRadius: 6 }}
              >
                <Text style={{ color: '#d46b08', fontWeight: 600 }}>60% Deposit Required</Text>
                <Text style={{ color: '#d46b08', fontWeight: 700, fontSize: 15 }}>
                  R {deposit.toFixed(2)}
                </Text>
              </Row>
            </div>
          </Card>
        </Col>
      </Row>

      {/* Convert to Order Modal */}
      <Modal
        title="Convert to Order"
        open={convertModal}
        onCancel={() => setConvertModal(false)}
        onOk={() => convertMut.mutate(convertForm.getFieldsValue())}
        okText="Create Order"
        okButtonProps={{ loading: convertMut.isPending }}
      >
        <Form form={convertForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="PO Number (optional)" name="poNumber">
            <Input placeholder="Client's purchase order reference" />
          </Form.Item>
        </Form>
        <Text type="secondary" style={{ fontSize: 13 }}>
          An order will be created with a <strong>60% deposit</strong> pre-calculated from the
          quotation total of <strong>R {total.toFixed(2)}</strong>.
        </Text>
      </Modal>
    </>
  )
}

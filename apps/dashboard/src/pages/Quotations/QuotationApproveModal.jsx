import { useState, useMemo } from 'react'
import {
  Modal, Table, InputNumber, Input, Button, Tag, Space,
  Typography, Divider, Alert, Tooltip, message,
} from 'antd'
import { RobotOutlined, CheckCircleOutlined, WarningOutlined } from '@ant-design/icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { approveQuotation } from '../../api/quotations.js'

const { Text } = Typography

const VAT_RATE = 0.15

const CONFIDENCE_CONFIG = {
  high:   { color: 'success', label: 'AI: High confidence' },
  medium: { color: 'warning', label: 'AI: Medium confidence' },
  low:    { color: 'error',   label: 'AI: Low confidence' },
}

function ConfidenceBadge({ confidence }) {
  const cfg = CONFIDENCE_CONFIG[confidence]
  if (!cfg) return null
  return (
    <Tooltip title="Price suggested by AI — please verify before approving">
      <Tag color={cfg.color} icon={<RobotOutlined />} style={{ fontSize: 11 }}>
        {cfg.label}
      </Tag>
    </Tooltip>
  )
}

export default function QuotationApproveModal({ quotation, open, onClose }) {
  const queryClient = useQueryClient()
  const [messageApi, contextHolder] = message.useMessage()

  const initialItems = useMemo(() => {
    if (!quotation) return []
    return (quotation.line_items ?? []).map((item, idx) => ({
      ...item,
      _key: idx,
      price: Number(item.price ?? 0),
      quantity: Number(item.quantity ?? 1),
    }))
  }, [quotation])

  const [items, setItems] = useState(initialItems)

  // Reset when a new quotation is opened
  useMemo(() => {
    setItems(initialItems)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotation?.id])

  const totals = useMemo(() => {
    const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0)
    const vat = subtotal * VAT_RATE
    return { subtotal, vat, total: subtotal + vat }
  }, [items])

  const updateItem = (key, field, value) => {
    setItems((prev) =>
      prev.map((item) =>
        item._key === key ? { ...item, [field]: value, priceConfirmed: true } : item,
      ),
    )
  }

  const { mutate: doApprove, isPending } = useMutation({
    mutationFn: () =>
      approveQuotation(
        quotation.id,
        items.map(({ _key, ...rest }) => ({
          ...rest,
          lineTotal: rest.price * rest.quantity,
          priceConfirmed: true,
        })),
      ),
    onSuccess: () => {
      messageApi.success('Quotation approved — PDF sent to client via WhatsApp')
      queryClient.invalidateQueries({ queryKey: ['quotations'] })
      onClose()
    },
    onError: (err) => {
      messageApi.error(err?.response?.data?.error ?? 'Approval failed. Please try again.')
    },
  })

  const hasUnconfirmedLow = items.some(
    (i) => i.aiSuggested && !i.priceConfirmed && i.confidence === 'low',
  )

  const columns = [
    {
      title: 'Item',
      key: 'name',
      width: '30%',
      render: (_, row) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Input
            size="small"
            value={row.name}
            onChange={(e) => updateItem(row._key, 'name', e.target.value)}
          />
          {row.aiSuggested && <ConfidenceBadge confidence={row.confidence} />}
          {row.aiNotes && (
            <Text type="secondary" style={{ fontSize: 11 }}>{row.aiNotes}</Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Sizes / Branding',
      key: 'details',
      width: '20%',
      render: (_, row) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          {(row.sizes || row.aiSuggested) && (
            <Input
              size="small"
              placeholder="Sizes"
              value={row.sizes ?? ''}
              onChange={(e) => updateItem(row._key, 'sizes', e.target.value)}
            />
          )}
          {(row.branding || row.aiSuggested) && (
            <Input
              size="small"
              placeholder="Branding"
              value={row.branding ?? ''}
              onChange={(e) => updateItem(row._key, 'branding', e.target.value)}
            />
          )}
        </Space>
      ),
    },
    {
      title: 'Qty',
      key: 'quantity',
      width: '10%',
      render: (_, row) => (
        <InputNumber
          size="small"
          min={1}
          style={{ width: '100%' }}
          value={row.quantity}
          onChange={(v) => updateItem(row._key, 'quantity', v ?? 1)}
        />
      ),
    },
    {
      title: 'Unit Price (R)',
      key: 'price',
      width: '15%',
      render: (_, row) => (
        <InputNumber
          size="small"
          min={0}
          precision={2}
          prefix="R"
          style={{ width: '100%' }}
          value={row.price}
          onChange={(v) => updateItem(row._key, 'price', v ?? 0)}
          status={row.aiSuggested && !row.priceConfirmed && row.confidence === 'low' ? 'warning' : undefined}
        />
      ),
    },
    {
      title: 'Line Total',
      key: 'lineTotal',
      width: '15%',
      render: (_, row) => (
        <Text strong>R {(row.price * row.quantity).toFixed(2)}</Text>
      ),
    },
    {
      title: '',
      key: 'status',
      width: '10%',
      render: (_, row) => {
        if (!row.aiSuggested) return <CheckCircleOutlined style={{ color: '#52c41a' }} />
        if (row.priceConfirmed) return <CheckCircleOutlined style={{ color: '#52c41a' }} />
        return <WarningOutlined style={{ color: '#faad14' }} />
      },
    },
  ]

  const aiItemCount = items.filter((i) => i.aiSuggested).length

  return (
    <>
      {contextHolder}
      <Modal
        open={open}
        onCancel={onClose}
        title={
          <Space>
            <span>Price &amp; Approve Quotation</span>
            {quotation?.reference && (
              <Text type="secondary" style={{ fontSize: 13, fontFamily: 'monospace' }}>
                #{quotation.reference}
              </Text>
            )}
          </Space>
        }
        width={900}
        footer={null}
        destroyOnClose
      >
        {aiItemCount > 0 && (
          <Alert
            type="info"
            icon={<RobotOutlined />}
            showIcon
            message={`${aiItemCount} item${aiItemCount > 1 ? 's' : ''} have AI-suggested pricing`}
            description="Review and adjust prices before approving. Low-confidence items are highlighted — these need the most attention."
            style={{ marginBottom: 16 }}
          />
        )}

        {hasUnconfirmedLow && (
          <Alert
            type="warning"
            showIcon
            message="One or more low-confidence AI prices have not been reviewed"
            description="Edit the price fields above before approving."
            style={{ marginBottom: 16 }}
          />
        )}

        <Table
          dataSource={items}
          columns={columns}
          rowKey="_key"
          size="small"
          pagination={false}
          rowClassName={(row) =>
            row.aiSuggested && !row.priceConfirmed ? 'row-ai-unconfirmed' : ''
          }
        />

        <Divider style={{ margin: '12px 0' }} />

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Space direction="vertical" align="end" size={4}>
            <Text>Subtotal: <Text strong>R {totals.subtotal.toFixed(2)}</Text></Text>
            <Text>VAT (15%): <Text strong>R {totals.vat.toFixed(2)}</Text></Text>
            <Text style={{ fontSize: 16 }}>
              Total: <Text strong style={{ fontSize: 16 }}>R {totals.total.toFixed(2)}</Text>
            </Text>
          </Space>
        </div>

        <Divider style={{ margin: '12px 0' }} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            type="primary"
            loading={isPending}
            onClick={() => doApprove()}
            icon={<CheckCircleOutlined />}
          >
            Approve &amp; Send PDF to Client
          </Button>
        </div>
      </Modal>
    </>
  )
}

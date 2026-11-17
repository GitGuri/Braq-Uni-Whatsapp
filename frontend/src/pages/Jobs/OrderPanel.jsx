import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { App, Alert, Button, Form, Input, Modal, Select, Table, Upload } from 'antd'
import {
  DollarOutlined, EditOutlined, FilePdfOutlined, StopOutlined, UploadOutlined, TruckOutlined, LinkOutlined,
} from '@ant-design/icons'
import {
  setHold, updateMaterials, uploadSizes, listSizes, downloadSizeRunSheet,
} from '../../api/orders.js'
import { qk, useJobMutation } from '../../lib/queryKeys.js'
import { useStatus } from '../../lib/status.js'
import { useMeta } from '../../lib/useMeta.js'
import { money, date, dateTime, sentence } from '../../lib/format.js'
import { errorMessage } from '../../utils/errorMessage.js'
import { newIdempotencyKey } from '../../lib/idempotency.js'
import StatusPill from '../../components/StatusPill.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import ActionForm from '../../components/ActionForm.jsx'

const MATERIAL_LABEL = {
  fabric: 'Fabric or material', supplier: 'Supplier', lead_time: 'Lead time', stock_status: 'Stock status', notes: 'Other notes',
}
const STOCK_STATUS_OPTIONS = [
  { value: 'in_stock', label: 'In stock' },
  { value: 'ordered', label: 'Ordered from supplier' },
  { value: 'awaiting', label: 'Awaiting allocation' },
  { value: 'out_of_stock', label: 'Out of stock' },
]
const HOLD_REASONS = [
  { value: 'supplier_delay', label: 'Supplier delay (the client is notified automatically)' },
  { value: 'payment_outstanding', label: 'Payment outstanding' },
  { value: 'design_revision', label: 'Design revision' },
  { value: 'client_request', label: 'Client request' },
  { value: 'other', label: 'Other' },
]
const PAYMENT_TYPE_LABEL = { deposit: 'Deposit', balance: 'Balance', full: 'Full payment' }
const ROSTER_MAX_BYTES = 5 * 1024 * 1024
const stockLabel = (v) => STOCK_STATUS_OPTIONS.find((o) => o.value === v)?.label ?? sentence(v)

const toNum = (v) => (v === null || v === undefined || v === '' ? null : Number(v))

/** Label over value. */
export function Fact({ label, children }) {
  return (
    <div className="braq-fact">
      <div className="braq-fact-label">{label}</div>
      <div className="braq-fact-value">{children}</div>
    </div>
  )
}

function Section({ id, title, extra, children }) {
  return (
    <section className="braq-panel" aria-labelledby={id}>
      <div className="braq-panel-head">
        <h3 id={id} className="braq-panel-title">{title}</h3>
        {extra}
      </div>
      <div className="braq-panel-body">{children}</div>
    </section>
  )
}

/** Money facts for display: the order's total, paid so far, outstanding and deposit still due. */
export function orderMoney(order, payments, quotation) {
  const paid = payments.reduce((s, p) => s + Number(p.amount || 0), 0)
  const total = toNum(order?.total_amount) ?? toNum(quotation?.total) ?? null
  const deposit = toNum(order?.deposit_amount)
  return {
    total,
    paid,
    deposit,
    outstanding: total != null ? Math.max(0, Math.round((total - paid) * 100) / 100) : toNum(order?.balance_amount),
    depositDue: deposit != null ? Math.max(0, Math.round((deposit - paid) * 100) / 100) : null,
  }
}

/**
 * "Record other payment" — the same payment form as the Next step's deposit /
 * balance step (ActionForm), with the payment type to choose.
 */
function paymentAction(type, amount) {
  return {
    key: 'record_payment',
    label: 'Record payment',
    inputs: [
      { name: 'type', type: 'select', required: true, label: 'Payment for', default: type, options: ['deposit', 'balance', 'full'] },
      { name: 'amount', type: 'money', required: true, label: 'Amount (R)', default: amount || undefined },
      { name: 'notes', type: 'text', required: false, label: 'Notes' },
    ],
  }
}

/**
 * Order tab of the job page: payments, proof, size roster, materials, run sheet, hold.
 *   <OrderPanel job={job} run={run} pendingKey={pendingKey} />
 */
export default function OrderPanel({ job, run, pendingKey }) {
  const { message } = App.useApp()
  const status = useStatus()
  const meta = useMeta()
  const { order, payments, quotation, lifecycle } = job
  const [payOpen, setPayOpen] = useState(false)
  const [payError, setPayError] = useState(null)
  const [payKey, setPayKey] = useState(null)
  const [holdOpen, setHoldOpen] = useState(false)
  const [materialsOpen, setMaterialsOpen] = useState(false)
  const [sheetLoading, setSheetLoading] = useState(false)
  const [holdForm] = Form.useForm()
  const [materialsForm] = Form.useForm()

  const sizesQuery = useQuery({
    queryKey: qk.orderSizes(order?.id),
    queryFn: () => listSizes(order.id),
    enabled: !!order?.id,
    initialData: job.sizes,
    initialDataUpdatedAt: 0,
  })

  const hold = useJobMutation({ mutationFn: (v) => setHold(order.id, v) })
  const materials = useJobMutation({ mutationFn: (v) => updateMaterials(order.id, v) })
  const upload = useJobMutation({ mutationFn: (file) => uploadSizes(order.id, file) })

  if (!order) {
    return (
      <section className="braq-panel">
        <EmptyState title="No order yet">
          The order is created once the client accepts the quote. Payments, the design proof and the size roster live here after that.
        </EmptyState>
      </section>
    )
  }

  const m = orderMoney(order, payments, quotation)
  const unpaid = !['deposit_paid', 'paid_in_full', 'not_required'].includes(order.payment_status)
  const suggestedType = unpaid ? 'deposit' : 'balance'
  const suggestedAmount = unpaid ? (m.depositDue ?? m.outstanding) : m.outstanding
  const owes = m.outstanding == null || m.outstanding > 0
  const finished = ['completed'].includes(meta.legacyStages?.[order.stage] ?? order.stage)

  // Proof steps (send / approve / changes) live in the Next step card; this panel shows the proof's status and link.
  const proofNext = lifecycle.nextActions.find((a) => a.enabled && ['send_proof', 'mark_proof_approved', 'mark_proof_revision'].includes(a.key))

  let materialNotes = {}
  try { materialNotes = typeof order.material_notes === 'object' && order.material_notes ? order.material_notes : JSON.parse(order.material_notes || '{}') } catch { materialNotes = {} }
  const materialEntries = Object.entries(materialNotes).filter(([, v]) => v != null && String(v).trim() !== '')
  const hasLineItems = Array.isArray(quotation?.line_items) && quotation.line_items.length > 0

  const payAction = paymentAction(suggestedType, suggestedAmount)
  // One idempotency key per opening of the dialog: retrying after an error or a
  // timeout reuses it (the server returns the first payment, not a second one).
  const openPayment = () => { setPayError(null); setPayKey(newIdempotencyKey()); setPayOpen(true) }
  const submitPayment = async (values) => {
    setPayError(null)
    const res = await run(payAction, values, { idempotencyKey: payKey })
    if (res.ok) {
      const what = `${PAYMENT_TYPE_LABEL[values.type] ?? 'Payment'} of ${money(values.amount)}`
      message.success(res.result?.replayed ? `Already recorded — ${what}` : `${what} recorded`)
      setPayOpen(false)
    } else {
      // Same key, different details: the server asks for a fresh submission.
      if (res.error?.code === 'IDEMPOTENCY_MISMATCH') setPayKey(newIdempotencyKey())
      setPayError(res.error)
    }
  }

  const openSheet = async () => {
    const win = window.open('', '_blank') // inside the click, so popup blockers allow it
    setSheetLoading(true)
    try {
      const blob = await downloadSizeRunSheet(order.id)
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
      if (win && !win.closed) win.location.href = url
      else {
        const a = document.createElement('a')
        a.href = url
        a.download = `size-run-sheet-${order.reference}.pdf`
        document.body.appendChild(a); a.click(); a.remove()
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      win?.close()
      message.error(errorMessage(err, 'Could not make the size run sheet'))
    } finally { setSheetLoading(false) }
  }

  const sizes = sizesQuery.data ?? []

  return (
    <div className="braq-order-panel">
      {/* ── Order summary ── */}
      <Section
        id="order-summary"
        title={<>Order <span className="braq-ref" style={{ marginLeft: 4 }}>{order.reference}</span></>}
        extra={!finished && (
          <Button
            size="small"
            icon={<StopOutlined />}
            onClick={() => { holdForm.resetFields(); setHoldOpen(true) }}
          >
            {order.is_on_hold ? 'Release hold' : 'Put on hold'}
          </Button>
        )}
      >
        <div className="braq-facts">
          <Fact label="Stage"><StatusPill kind="stage" value={order.stage} /></Fact>
          <Fact label="Payment"><StatusPill kind="payment" value={order.payment_status} /></Fact>
          <Fact label="Proof"><StatusPill kind="proof" value={order.proof_status ?? 'none'} /></Fact>
          <Fact label="Due">{date(order.estimated_completion_date)}</Fact>
          <Fact label="PO number">{order.po_number ?? '—'}</Fact>
          <Fact label="Delivery">{order.delivery_type ? sentence(order.delivery_type) : '—'}</Fact>
          <Fact label="Created">{dateTime(order.created_at)}</Fact>
          {order.tracking_number && (
            <Fact label="Tracking"><span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><TruckOutlined aria-hidden="true" /><span className="braq-ref">{order.tracking_number}</span></span></Fact>
          )}
        </div>
        {order.is_on_hold && (
          <Alert type="warning" showIcon style={{ marginTop: 14 }} message={`On hold${order.hold_reason ? ` — ${sentence(order.hold_reason)}` : ''}`} description="Nothing moves on until the hold is released." />
        )}
      </Section>

      {/* ── Payments ── */}
      <Section
        id="order-payments"
        title="Payments"
        extra={<Button size="small" icon={<DollarOutlined />} onClick={openPayment}>Record other payment</Button>}
      >
        <div className="braq-money-grid">
          <Fact label="Order total"><strong>{money(m.total)}</strong></Fact>
          <Fact label={`Deposit (${meta.depositPercent}%)`}>{money(m.deposit)}</Fact>
          <Fact label="Paid so far">{money(m.paid)}</Fact>
          <Fact label="Outstanding">
            <strong style={{ color: owes ? 'var(--thread)' : 'var(--good)' }}>{m.outstanding == null ? '—' : money(m.outstanding)}</strong>
          </Fact>
        </div>
        {payments.length === 0 ? (
          <p className="braq-muted" style={{ margin: '14px 0 0' }}>No payments recorded yet. The Next step asks for the deposit when it is due.</p>
        ) : (
          <ul className="braq-list" aria-label="Payments received">
            {payments.map((p) => (
              <li key={p.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 600 }}>{PAYMENT_TYPE_LABEL[p.type] ?? sentence(p.type)}</span>
                  <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{money(p.amount, { currency: p.currency })}</span>
                </div>
                <div className="braq-small">{date(p.created_at)}{p.notes ? ` · ${p.notes}` : ''}</div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ── Design proof ── */}
      <Section id="order-proof" title="Design proof" extra={<StatusPill kind="proof" value={order.proof_status ?? 'none'} />}>
        {order.proof_url ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <a href={order.proof_url} target="_blank" rel="noreferrer" className="braq-link"><LinkOutlined aria-hidden="true" /> Open current proof</a>
            {order.proof_notes && <div style={{ color: 'var(--ink-2)' }}>{order.proof_notes}</div>}
            {order.proof_sent_at && <div className="braq-small">Sent {dateTime(order.proof_sent_at)}</div>}
          </div>
        ) : (
          <p className="braq-muted" style={{ margin: 0 }}>No design proof sent yet. The client can approve it or ask for changes on WhatsApp.</p>
        )}
        {proofNext && <p className="braq-small" style={{ margin: '10px 0 0' }}>Next: “{proofNext.label}” — in the Next step card above.</p>}
      </Section>

      {/* ── Size roster ── */}
      <Section
        id="order-sizes"
        title={`Size roster${sizes.length ? ` (${sizes.length})` : ''}`}
        extra={(
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {hasLineItems && <Button size="small" icon={<FilePdfOutlined />} loading={sheetLoading} onClick={openSheet}>Size run sheet</Button>}
            <Upload
              accept=".xlsx,.csv"
              showUploadList={false}
              beforeUpload={(file) => {
                // The server takes rosters up to 5 MB — say so before sending it.
                if (file.size > ROSTER_MAX_BYTES) {
                  message.error('That file is too big — rosters can be up to 5 MB.')
                  return Upload.LIST_IGNORE
                }
                return true
              }}
              customRequest={async ({ file, onSuccess, onError }) => {
                try {
                  const res = await upload.mutateAsync(file)
                  message.success(`Size roster uploaded — ${res?.count ?? 0} people`)
                  onSuccess?.(res)
                } catch (err) {
                  message.error(errorMessage(err, 'The roster was not uploaded'))
                  onError?.(err)
                }
              }}
            >
              <Button size="small" icon={<UploadOutlined />} loading={upload.isPending}>{sizes.length ? 'Replace roster' : 'Upload roster'}</Button>
            </Upload>
          </div>
        )}
      >
        {sizes.length === 0 ? (
          <p className="braq-muted" style={{ margin: 0 }}>
            No roster yet. Upload a spreadsheet (.xlsx or .csv) with Name and Size columns — and Notes if you need them.
          </p>
        ) : (
          <Table
            dataSource={sizes}
            rowKey="id"
            size="small"
            pagination={sizes.length > 15 ? { pageSize: 15, showSizeChanger: false } : false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: 'Name', dataIndex: 'person_name' },
              { title: 'Size', dataIndex: 'size', width: 90 },
              { title: 'Notes', dataIndex: 'notes', render: (v) => v || <span className="braq-muted">—</span> },
            ]}
          />
        )}
      </Section>

      {/* ── Materials ── */}
      <Section
        id="order-materials"
        title="Material and stock notes"
        extra={<Button size="small" icon={<EditOutlined />} onClick={() => { materialsForm.setFieldsValue(materialNotes); setMaterialsOpen(true) }}>Edit notes</Button>}
      >
        {materialEntries.length === 0 ? (
          <p className="braq-muted" style={{ margin: 0 }}>No material notes yet. Add the fabric, supplier and stock status so production knows what to expect.</p>
        ) : (
          <div className="braq-facts">
            {materialEntries.map(([k, v]) => (
              <Fact key={k} label={MATERIAL_LABEL[k] ?? sentence(k)}>{k === 'stock_status' ? stockLabel(v) : String(v)}</Fact>
            ))}
          </div>
        )}
      </Section>

      {/* Record other payment — the same payment form as the Next step */}
      <Modal title="Record other payment" open={payOpen} onCancel={() => setPayOpen(false)} footer={null} destroyOnHidden>
        <p className="braq-muted" style={{ margin: '8px 0 14px' }}>
          {m.outstanding != null ? `Outstanding: ${money(m.outstanding)}.` : ''} {unpaid && m.depositDue ? `Deposit still due: ${money(m.depositDue)}.` : ''}
        </p>
        <ActionForm action={payAction} primary pending={pendingKey === 'record_payment'} onSubmit={submitPayment} onCancel={() => setPayOpen(false)} />
        {payError && <Alert type="error" showIcon style={{ marginTop: 12 }} message={payError.message} />}
      </Modal>

      {/* Hold Modal */}
      <Modal
        title={order.is_on_hold ? 'Release hold' : 'Put order on hold'}
        open={holdOpen}
        onCancel={() => setHoldOpen(false)}
        onOk={async () => {
          try {
            await hold.mutateAsync({ isOnHold: !order.is_on_hold, ...(order.is_on_hold ? {} : { holdReason: holdForm.getFieldValue('holdReason') }) })
            message.success(order.is_on_hold ? 'Hold released' : 'Order put on hold')
            setHoldOpen(false)
          } catch (err) { message.error(errorMessage(err, 'The hold was not changed')) }
        }}
        okText={order.is_on_hold ? 'Release hold' : 'Put on hold'}
        okButtonProps={{ loading: hold.isPending }}
      >
        {order.is_on_hold ? (
          <p style={{ margin: '12px 0 0', color: 'var(--ink-2)' }}>The order picks up again at {status.label('stage', order.stage).toLowerCase()}.</p>
        ) : (
          <Form form={holdForm} layout="vertical" name="hold" style={{ marginTop: 12 }}>
            <Form.Item label="Reason" name="holdReason">
              <Select placeholder="Choose a reason" options={HOLD_REASONS} />
            </Form.Item>
          </Form>
        )}
      </Modal>

      {/* Materials Modal */}
      <Modal
        title="Material and stock notes"
        open={materialsOpen}
        onCancel={() => setMaterialsOpen(false)}
        onOk={async () => {
          try {
            await materials.mutateAsync(materialsForm.getFieldsValue())
            message.success('Material notes saved')
            setMaterialsOpen(false)
          } catch (err) { message.error(errorMessage(err, 'The notes were not saved')) }
        }}
        okText="Save notes"
        okButtonProps={{ loading: materials.isPending }}
        width={520}
      >
        <Form form={materialsForm} layout="vertical" name="materials" style={{ marginTop: 12 }}>
          <Form.Item label="Fabric or material" name="fabric"><Input placeholder="e.g. 65/35 polycotton, navy" /></Form.Item>
          <Form.Item label="Supplier" name="supplier"><Input placeholder="e.g. Bella Fabrics, Johannesburg" /></Form.Item>
          <Form.Item label="Lead time" name="lead_time"><Input placeholder="e.g. 7–10 business days from order" /></Form.Item>
          <Form.Item label="Stock status" name="stock_status"><Select allowClear placeholder="Choose a status" options={STOCK_STATUS_OPTIONS} /></Form.Item>
          <Form.Item label="Other notes" name="notes"><Input.TextArea rows={3} placeholder="Anything else production or stock should know" /></Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

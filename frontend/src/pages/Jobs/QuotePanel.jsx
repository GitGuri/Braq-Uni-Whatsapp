import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { App, Row, Col, Button, Input, InputNumber, Select, Space, Tag, Alert, Tooltip, AutoComplete, Table } from 'antd'
import { PlusOutlined, DeleteOutlined, RobotOutlined, CopyOutlined, CheckOutlined, LoadingOutlined, WarningOutlined, FilePdfOutlined } from '@ant-design/icons'
import { listProducts } from '../../api/products.js'
import { saveQuotationDraft, fetchQuotationPdf } from '../../api/quotations.js'
import api from '../../api/client.js'
import { qk } from '../../lib/queryKeys.js'
import { useMeta } from '../../lib/useMeta.js'
import { money, sentence, plural, lowerFirst, dateTime } from '../../lib/format.js'
import { errorMessage } from '../../utils/errorMessage.js'
import EmptyState from '../../components/EmptyState.jsx'

// Branding methods and their per-unit surcharge (the backend re-prices every line on approve).
const BRANDING_SURCHARGES = {
  none: 0, embroidery: 15, screen_print: 12, sublimation: 25, heat_transfer: 10,
}
const BRANDING_OPTIONS = [
  { value: 'none',          label: 'No branding' },
  { value: 'embroidery',    label: 'Embroidery (+R15 per unit)' },
  { value: 'screen_print',  label: 'Screen print (+R12 per unit)' },
  { value: 'sublimation',   label: 'Sublimation (+R25 per unit)' },
  { value: 'heat_transfer', label: 'Heat transfer (+R10 per unit)' },
]
// Values are stored on the quotation as-is; only the labels are sentence case.
const BRANDING_POSITIONS = ['Left Chest', 'Right Chest', 'Centre Front', 'Full Back', 'Left Sleeve', 'Right Sleeve', 'Other']
// Size runs use the catalogue's spelling (2XL, not XXL).
const SIZE_PRESETS = {
  Adults:  ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'],
  Kids:    ['4', '6', '8', '10', '12', '14'],
  Numeric: ['30', '32', '34', '36', '38', '40', '42'],
}
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL', '4XL', '5XL',
  '2', '4', '6', '8', '10', '12', '14', '16', '18', '24', '26', '28', '30', '32', '34', '36', '38', '40', '42', '44']
const AUTOSAVE_MS = 800

const LABEL = { display: 'block', fontSize: 13, color: 'var(--ink-2)', marginBottom: 4 }
const SUBHEAD = { margin: '0 0 8px', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }

let keySeq = 0
const makeKey = () => ++keySeq

function blankItem() {
  return {
    _key: makeKey(), productId: null, name: '', category: 'custom', colour: '', sizes: [], quantity: 0, unitPrice: 0,
    branding: { type: 'none', position: '', detail: '' }, aiNote: null,
  }
}

function normalizeItem(raw) {
  const sizes = Array.isArray(raw.sizes) ? raw.sizes : []
  return {
    _key: makeKey(),
    productId: raw.productId ?? null,
    name: raw.name ?? raw.description ?? '',
    category: raw.category ?? 'custom',
    colour: raw.colour ?? '',
    sizes,
    // One-size items (no size run) keep their own quantity.
    quantity: sizes.length ? 0 : Number(raw.quantity ?? 0) || 0,
    unitPrice: Number(raw.unitPrice ?? raw.price ?? 0),
    branding: raw.branding && typeof raw.branding === 'object' ? raw.branding : { type: 'none', position: '', detail: '' },
    aiNote: raw.aiNote
      ?? (typeof raw.sizes === 'string' && raw.sizes ? `Customer requested: ${raw.sizes}` : null)
      ?? (raw.aiNotes ?? null),
  }
}

function deriveItem(item) {
  const qty = item.sizes.length
    ? item.sizes.reduce((s, sz) => s + (Number(sz.qty) || 0), 0)
    : Math.max(0, Math.round(Number(item.quantity) || 0))
  const surcharge = BRANDING_SURCHARGES[item.branding?.type] || 0
  const effectiveUnitPrice = Number(item.unitPrice || 0) + surcharge
  return { ...item, quantity: qty, brandingSurcharge: surcharge, effectiveUnitPrice, lineTotal: effectiveUnitPrice * qty }
}

const sortedSizes = (sizes) => [...sizes].sort((a, b) => {
  const ai = SIZE_ORDER.indexOf(a.size), bi = SIZE_ORDER.indexOf(b.size)
  return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
})

/** Line items payload for POST /quotations/:id/approve and PUT /quotations/:id (LineItemSchema fields). */
const toPayload = (items) => items.map(deriveItem).map(({ _key, ...rest }) => rest)

/**
 * The quote being priced: local edits of the quotation's line items and notes,
 * reset whenever the quotation changes status (approved, revised …). While the
 * quote is a draft every change is saved automatically (debounced), so leaving
 * the page never loses work.
 *   draft.save: 'idle' | 'saving' | 'saved' | 'error';  draft.flush() saves now.
 */
export function useQuoteDraft(quotation) {
  const [items, setItemsState] = useState([])
  const [notes, setNotesState] = useState('')
  const [save, setSave] = useState('idle')
  const [saveError, setSaveError] = useState(null)
  const pending = useRef(null)        // payload waiting to be saved
  const timer = useRef(null)
  const inFlight = useRef(Promise.resolve())
  const editable = quotation?.status === 'draft'
  const qid = quotation?.id
  const resetKey = `${qid}:${quotation?.status}:${quotation?.approved_at ?? ''}`

  const itemsRef = useRef(items)

  useEffect(() => {
    const fresh = (quotation?.line_items ?? []).map(normalizeItem)
    itemsRef.current = fresh
    setItemsState(fresh)
    setNotesState(quotation?.notes ?? '')
    pending.current = null
    clearTimeout(timer.current)
    setSave('idle')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    const body = pending.current
    if (!body || !qid) return inFlight.current
    pending.current = null
    setSave('saving')
    inFlight.current = inFlight.current.then(() => saveQuotationDraft(qid, body)
      .then(() => { setSave((s) => (pending.current ? s : 'saved')); setSaveError(null) })
      .catch((err) => { setSave('error'); setSaveError(errorMessage(err, 'Not saved')) }))
    return inFlight.current
  }, [qid])

  const schedule = useCallback((patch) => {
    if (!editable) return
    pending.current = { ...(pending.current ?? {}), ...patch }
    setSave('pending')
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, AUTOSAVE_MS)
  }, [editable, flush])

  // Leaving the page (or the quote being sent) saves what is waiting.
  useEffect(() => () => { flush() }, [flush])
  // Closing or reloading the tab: send what is waiting with a keepalive request
  // (the page is going away, so it cannot wait for an answer).
  useEffect(() => {
    if (!qid) return undefined
    const onHide = () => {
      const body = pending.current
      if (!body) return
      pending.current = null
      try {
        const token = localStorage.getItem('braq_token')
        fetch(`${api.defaults.baseURL ?? '/api'}/quotations/${qid}`, {
          method: 'PUT',
          keepalive: true,
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        }).catch(() => {})
      } catch { /* best effort */ }
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [qid])

  const setItems = useCallback((update) => {
    const next = typeof update === 'function' ? update(itemsRef.current) : update
    itemsRef.current = next
    setItemsState(next)
    schedule({ lineItems: toPayload(next) })
  }, [schedule])
  const setNotes = useCallback((v) => { setNotesState(v); schedule({ notes: v }) }, [schedule])

  const derived = items.map(deriveItem)
  // Mirrors the backend LineItemSchema: name required, quantity integer ≥ 1, unit price ≥ 0.
  const blocker =
    derived.length === 0 ? 'Add at least one item'
      : derived.some((i) => !i.name.trim()) ? 'All items need a name'
        : derived.some((i) => !Number.isInteger(i.quantity) || i.quantity < 1) ? 'Every item needs a quantity of at least 1'
          : derived.some((i) => !Number.isFinite(Number(i.unitPrice)) || Number(i.unitPrice) < 0) ? 'Unit prices must be 0 or more'
            : null
  return { items, setItems, notes, setNotes, derived, blocker, payload: toPayload(items), save, saveError, flush, editable, quotationId: qid }
}

/** "Saving…" / "Saved" next to a draft being priced. */
export function SaveIndicator({ draft }) {
  if (!draft?.editable || draft.save === 'idle') return null
  const map = {
    pending: { icon: <LoadingOutlined />, text: 'Saving…' },
    saving:  { icon: <LoadingOutlined />, text: 'Saving…' },
    saved:   { icon: <CheckOutlined />, text: 'Saved' },
    error:   { icon: <WarningOutlined />, text: draft.saveError ? `Not saved — ${lowerFirst(draft.saveError)}` : 'Not saved' },
  }
  const m = map[draft.save]
  return (
    <span className={`braq-save-indicator${draft.save === 'error' ? ' error' : ''}`} role="status" aria-live="polite" data-save={draft.save}>
      <span aria-hidden="true">{m.icon}</span> {m.text}
    </span>
  )
}

/** Open the quote PDF (a draft as a preview) — fetched with the staff token. */
export function useQuotePdf() {
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const open = async (quotationId, { before } = {}) => {
    const win = window.open('', '_blank') // inside the click, so popup blockers allow it
    setLoading(true)
    try {
      await before?.()
      const blob = await fetchQuotationPdf(quotationId)
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
      if (win && !win.closed) win.location.href = url
      else window.location.assign(url)
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      win?.close()
      message.error(errorMessage(err, 'Could not open the quote PDF'))
    } finally { setLoading(false) }
  }
  return { open, loading }
}

function useTotals(derived) {
  const meta = useMeta()
  return useMemo(() => {
    const subtotal = derived.reduce((s, i) => s + i.lineTotal, 0)
    const vat = subtotal * Number(meta.vatRate ?? 0.15)
    const total = subtotal + vat
    const deposit = total * (Number(meta.depositPercent ?? 60) / 100)
    const units = derived.reduce((s, i) => s + i.quantity, 0)
    return { subtotal, vat, total, deposit, units, vatPercent: meta.vatPercent ?? Math.round(Number(meta.vatRate) * 100), depositPercent: meta.depositPercent }
  }, [derived, meta])
}

function TotalRow({ label, value, strong }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, padding: '3px 0' }}>
      <span style={{ color: strong ? 'var(--ink)' : 'var(--ink-2)', fontWeight: strong ? 600 : 400 }}>{label}</span>
      <span style={{ fontWeight: strong ? 600 : 500, whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
}

/** Totals block; the server's figures when the quote is saved, the live draft while pricing. */
function Totals({ totals, quotation, editing, blocker }) {
  const saved = !editing && quotation?.total != null
  const subtotal = saved ? quotation.subtotal : totals.subtotal
  const vat = saved ? quotation.vat : totals.vat
  const total = saved ? quotation.total : totals.total
  const deposit = Number(total ?? 0) * (Number(totals.depositPercent ?? 60) / 100)
  return (
    <section className="braq-panel" aria-labelledby="quote-totals">
      <div className="braq-panel-head">
        <h3 id="quote-totals" className="braq-panel-title">Quotation total</h3>
        <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>{plural(totals.units, 'unit')}</span>
      </div>
      <div style={{ padding: '16px 18px 18px', display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div style={{ flex: '1 1 220px', maxWidth: 360, fontSize: 13, color: 'var(--ink-2)' }}>
          {editing && blocker && <span style={{ color: 'var(--warn)', fontWeight: 500 }}>Before you can send: {lowerFirst(blocker)}.</span>}
          {editing && !blocker && 'Sending approves these prices and sends the quote to the client as a PDF on WhatsApp.'}
        </div>
        <div style={{ flex: '1 1 260px', maxWidth: 380 }}>
          <TotalRow label="Subtotal" value={money(subtotal ?? 0)} />
          <TotalRow label={`VAT (${totals.vatPercent}%)`} value={money(vat ?? 0)} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, borderTop: '1px solid var(--line)', marginTop: 8, paddingTop: 10 }}>
            <span style={{ fontWeight: 600 }}>Total</span>
            <span className="braq-total-figure">{money(total ?? 0)}</span>
          </div>
          <div className="braq-inset" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, marginTop: 10 }}>
            <span style={{ color: 'var(--ink-2)' }}>Deposit due before production ({totals.depositPercent}%)</span>
            <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{money(deposit)}</span>
          </div>
        </div>
      </div>
    </section>
  )
}

function brandingText(b) {
  if (!b) return null
  if (typeof b === 'string') return b || null
  if (!b.type || b.type === 'none') return null
  return [sentence(b.type), b.position && sentence(b.position), b.detail].filter(Boolean).join(' · ')
}

/** Saved quote: line items with sizes and branding, read-only. */
function QuoteLines({ derived }) {
  if (!derived.length) return <EmptyState compact title="No line items">This quotation has no line items.</EmptyState>
  return (
    <Table
      dataSource={derived}
      rowKey="_key"
      size="small"
      pagination={false}
      scroll={{ x: 'max-content' }}
      columns={[
        {
          title: 'Item',
          render: (_, r) => {
            const sizes = r.sizes.filter((s) => Number(s.qty) > 0)
            const brand = brandingText(r.branding)
            return (
              <div style={{ minWidth: 200 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600 }}>{r.name || '—'}</span>
                  {r.colour && <span className="braq-pill">{r.colour}</span>}
                </div>
                {brand && <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>{brand}</div>}
                {sizes.length > 0 && (
                  <div className="braq-size-chips" role="list" aria-label={`Sizes for ${r.name}`}>
                    {sizes.map(({ size, qty }) => (
                      <span key={size} role="listitem" className="braq-size-chip"><span>{size}</span><strong>{qty}</strong></span>
                    ))}
                  </div>
                )}
              </div>
            )
          },
        },
        { title: 'Qty', dataIndex: 'quantity', align: 'right', width: 70 },
        { title: 'Unit price', align: 'right', width: 120, render: (_, r) => <span style={{ whiteSpace: 'nowrap' }}>{money(r.effectiveUnitPrice)}</span> },
        { title: 'Total', align: 'right', width: 130, render: (_, r) => <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{money(r.lineTotal)}</span> },
      ]}
    />
  )
}

/**
 * Quote tab of the job page. Editable only while the job is being priced
 * (saved automatically as you go); once sent, "Revise quote" (a next action) reopens it.
 *   <QuotePanel quotation={q} draft={useQuoteDraft(q)} editable={state === 'PRICING'} />
 */
export default function QuotePanel({ quotation, draft, editable }) {
  const [custInputs, setCustInputs] = useState({})
  const { items, setItems, derived, blocker } = draft
  const totals = useTotals(derived)

  // Only products still on sale can be quoted.
  const { data: products = [] } = useQuery({
    queryKey: qk.products({ activeOnly: true }),
    queryFn: () => listProducts({ activeOnly: true }),
    enabled: editable,
    select: (d) => d?.products ?? [],
  })

  const updateItem = (idx, patch) => setItems((prev) => { const n = [...prev]; n[idx] = { ...n[idx], ...patch }; return n })
  const updateBranding = (idx, patch) => setItems((prev) => {
    const n = [...prev]; n[idx] = { ...n[idx], branding: { ...n[idx].branding, ...patch } }; return n
  })
  const toggleSize = (idx, size) => setItems((prev) => {
    const item = prev[idx]
    const exists = item.sizes.find((s) => s.size === size)
    const sizes = exists ? item.sizes.filter((s) => s.size !== size) : sortedSizes([...item.sizes, { size, qty: 0 }])
    const n = [...prev]; n[idx] = { ...item, sizes }; return n
  })
  const setSizeQty = (idx, size, qty) => setItems((prev) => {
    const item = prev[idx]
    const n = [...prev]
    const q = Math.max(0, Math.round(Number(qty) || 0)) // whole, non-negative (backend: qty int ≥ 0)
    n[idx] = { ...item, sizes: item.sizes.map((s) => (s.size === size ? { ...s, qty: q } : s)) }
    return n
  })
  const addSizes = (idx, list) => setItems((prev) => {
    const item = prev[idx]
    const existing = new Set(item.sizes.map((s) => s.size))
    const toAdd = list.filter((s) => !existing.has(s)).map((s) => ({ size: s, qty: 0 }))
    const n = [...prev]; n[idx] = { ...item, sizes: sortedSizes([...item.sizes, ...toAdd]) }; return n
  })
  const addCustomSize = (idx) => {
    const s = (custInputs[idx] || '').trim().toUpperCase()
    if (!s) return
    toggleSize(idx, s)
    setCustInputs((p) => ({ ...p, [idx]: '' }))
  }
  const duplicate = (idx) => setItems((prev) => {
    const copy = { ...prev[idx], _key: makeKey(), sizes: prev[idx].sizes.map((s) => ({ ...s })), branding: { ...prev[idx].branding } }
    return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)]
  })
  // Picking a catalogue product fills its name, price and size run (from the catalogue).
  const pickProduct = (idx, p) => setItems((prev) => {
    const item = prev[idx]
    const catalogue = Array.isArray(p.sizes) ? p.sizes.map(String).filter(Boolean) : []
    const keep = new Map(item.sizes.map((s) => [s.size, s.qty]))
    const sizes = catalogue.length ? sortedSizes(catalogue.map((size) => ({ size, qty: keep.get(size) ?? 0 }))) : item.sizes
    const n = [...prev]
    n[idx] = { ...item, name: p.name, productId: p.id, category: p.category, unitPrice: Number(p.price || 0), sizes }
    return n
  })

  const productOptions = products.map((p) => ({ value: p.name, label: `${p.name} — ${money(p.price)}`, _product: p }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="braq-quote-meta">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {quotation.auto_quoted && (
            <span className="braq-pill" title="Priced automatically by the WhatsApp assistant"><RobotOutlined /> Auto-priced</span>
          )}
          {quotation.approved_at && <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>Sent {dateTime(quotation.approved_at)}</span>}
          {quotation.valid_until && <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>· valid until {dateTime(quotation.valid_until).split(',')[0]}</span>}
          <SaveIndicator draft={draft} />
        </div>
      </div>

      {editable ? (
        <section className="braq-panel" aria-labelledby="quote-request">
          <div className="braq-panel-head"><h3 id="quote-request" className="braq-panel-title">What the client asked for</h3></div>
          <div className="braq-panel-body">
            <Input.TextArea
              id="quote-notes"
              aria-labelledby="quote-request"
              value={draft.notes}
              onChange={(e) => draft.setNotes(e.target.value)}
              autoSize={{ minRows: 2, maxRows: 10 }}
              placeholder="Notes for this quote — what the client asked for, deadlines, delivery…"
            />
          </div>
        </section>
      ) : quotation.notes && (
        <section className="braq-panel" aria-labelledby="quote-request">
          <div className="braq-panel-head"><h3 id="quote-request" className="braq-panel-title">What the client asked for</h3></div>
          <div style={{ padding: '14px 18px', maxHeight: 280, overflowY: 'auto', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{quotation.notes}</div>
        </section>
      )}

      {!editable ? (
        <section className="braq-panel" aria-label="Line items" style={{ overflow: 'hidden' }}>
          <QuoteLines derived={derived} />
        </section>
      ) : (
        <>
          {items.length === 0 && (
            <section className="braq-panel">
              <EmptyState compact title="No items yet">Add a line item for each garment the client wants.</EmptyState>
            </section>
          )}
          {items.map((item, idx) => {
            const d = deriveItem(item)
            const fid = `qb-${item._key}`
            const branded = item.branding.type !== 'none'
            const oneSize = item.sizes.length === 0
            return (
              <section key={item._key} className="braq-panel" aria-labelledby={`${fid}-title`}>
                <div className="braq-panel-head">
                  <h3 id={`${fid}-title`} className="braq-panel-title" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    Item {idx + 1}
                    {item.name && <span style={{ fontWeight: 400, color: 'var(--ink-2)' }}> · {item.name}</span>}
                  </h3>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    <span style={{ fontSize: 13, color: 'var(--ink-2)', whiteSpace: 'nowrap', marginRight: 6 }}>
                      {plural(d.quantity, 'unit')} · <strong style={{ color: 'var(--ink)' }}>{money(d.lineTotal)}</strong>
                    </span>
                    <Tooltip title="Duplicate item">
                      <Button size="small" type="text" icon={<CopyOutlined />} aria-label={`Duplicate item ${idx + 1}`} onClick={() => duplicate(idx)} />
                    </Tooltip>
                    <Tooltip title="Remove item">
                      <Button size="small" danger type="text" icon={<DeleteOutlined />} aria-label={`Remove item ${idx + 1}`}
                        onClick={() => setItems((p) => p.filter((_, i) => i !== idx))} />
                    </Tooltip>
                  </span>
                </div>

                <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 18 }}>
                  <Row gutter={[12, 12]}>
                    <Col xs={24} md={15}>
                      <label htmlFor={`${fid}-name`} style={LABEL}>Product or description</label>
                      <AutoComplete
                        value={item.name}
                        options={productOptions}
                        onSelect={(_, opt) => pickProduct(idx, opt._product)}
                        onChange={(v) => updateItem(idx, { name: v, productId: null })}
                        filterOption={(input, opt) => opt.value.toLowerCase().includes(input.toLowerCase())}
                        style={{ width: '100%' }}
                      >
                        <Input id={`${fid}-name`} placeholder="Search the catalogue or type an item name" />
                      </AutoComplete>
                    </Col>
                    <Col xs={24} md={9}>
                      <label htmlFor={`${fid}-colour`} style={LABEL}>Colour</label>
                      <Input id={`${fid}-colour`} value={item.colour} onChange={(e) => updateItem(idx, { colour: e.target.value })} placeholder="e.g. Navy blue" />
                    </Col>
                  </Row>

                  {item.aiNote && <Alert type="info" showIcon message={item.aiNote} />}

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                      <h4 style={SUBHEAD}>Sizes and quantities</h4>
                      <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>{plural(d.quantity, 'unit')} in total</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
                      <span style={{ fontSize: 13, color: 'var(--ink-2)', marginRight: 2 }}>Add a size run:</span>
                      {Object.keys(SIZE_PRESETS).map((preset) => (
                        <Button key={preset} size="small" icon={<PlusOutlined />} onClick={() => addSizes(idx, SIZE_PRESETS[preset])}>{preset}</Button>
                      ))}
                    </div>
                    {oneSize ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                        <label htmlFor={`${fid}-qty`} style={{ ...LABEL, margin: 0 }}>Quantity (one size)</label>
                        <InputNumber id={`${fid}-qty`} min={0} precision={0} style={{ width: 96 }} value={item.quantity}
                          onChange={(v) => updateItem(idx, { quantity: Math.max(0, Math.round(Number(v) || 0)) })} />
                        <span className="braq-small">Or add sizes for a size run.</span>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12, alignItems: 'flex-start' }}>
                        {item.sizes.map(({ size, qty }) => (
                          <div key={size} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                            <Tag closable onClose={() => toggleSize(idx, size)} closeIcon={undefined} style={{ marginRight: 0, userSelect: 'none' }}>{size}</Tag>
                            <InputNumber size="small" min={0} precision={0} aria-label={`Quantity for size ${size}`} style={{ width: 64 }}
                              value={qty} onChange={(v) => setSizeQty(idx, size, v)} />
                          </div>
                        ))}
                      </div>
                    )}
                    <Space.Compact size="small">
                      <Input placeholder="Other size" aria-label="Other size" style={{ width: 120 }} value={custInputs[idx] || ''}
                        onChange={(e) => setCustInputs((p) => ({ ...p, [idx]: e.target.value }))} onPressEnter={() => addCustomSize(idx)} />
                      <Button icon={<PlusOutlined />} onClick={() => addCustomSize(idx)}>Add size</Button>
                    </Space.Compact>
                  </div>

                  <div style={{ borderTop: '1px solid var(--line-2)', paddingTop: 16 }}>
                    <h4 style={SUBHEAD}>Branding</h4>
                    <Row gutter={[12, 12]}>
                      <Col xs={24} sm={8}>
                        <label htmlFor={`${fid}-btype`} style={LABEL}>Method</label>
                        <Select id={`${fid}-btype`} value={item.branding.type} onChange={(v) => updateBranding(idx, { type: v })} options={BRANDING_OPTIONS} style={{ width: '100%' }} />
                      </Col>
                      {branded && (
                        <>
                          <Col xs={24} sm={7}>
                            <label htmlFor={`${fid}-bpos`} style={LABEL}>Position</label>
                            <Select id={`${fid}-bpos`} value={item.branding.position || undefined} onChange={(v) => updateBranding(idx, { position: v })}
                              options={BRANDING_POSITIONS.map((p) => ({ value: p, label: sentence(p) }))} style={{ width: '100%' }} placeholder="Choose a position" />
                          </Col>
                          <Col xs={24} sm={9}>
                            <label htmlFor={`${fid}-bdetail`} style={LABEL}>Artwork details</label>
                            <Input id={`${fid}-bdetail`} value={item.branding.detail} onChange={(e) => updateBranding(idx, { detail: e.target.value })} placeholder="e.g. Logo 8 cm, 2 colours" />
                          </Col>
                        </>
                      )}
                    </Row>
                  </div>

                  <div style={{ borderTop: '1px solid var(--line-2)', paddingTop: 16, display: 'flex', flexWrap: 'wrap', gap: '12px 28px', alignItems: 'flex-end' }}>
                    <div style={{ flex: '0 1 200px', minWidth: 160 }}>
                      <label htmlFor={`${fid}-price`} style={LABEL}>Unit price</label>
                      <InputNumber id={`${fid}-price`} min={0} step={0.5} precision={2} prefix="R" style={{ width: '100%' }} value={item.unitPrice}
                        onChange={(v) => { const n = Number(v); updateItem(idx, { unitPrice: Number.isFinite(n) && n > 0 ? n : 0 }) }} />
                    </div>
                    {branded && (
                      <div><span style={LABEL}>Branding per unit</span><span style={{ lineHeight: '32px' }}>+ {money(d.brandingSurcharge)}</span></div>
                    )}
                    <div>
                      <span style={LABEL}>{branded ? 'Unit price with branding' : 'Price per unit'}</span>
                      <span style={{ lineHeight: '32px', fontWeight: 500 }}>{money(d.effectiveUnitPrice)}</span>
                    </div>
                    <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                      <span style={LABEL}>Line total</span>
                      <span style={{ lineHeight: '32px', fontSize: 16, fontWeight: 700 }}>{money(d.lineTotal)}</span>
                    </div>
                  </div>
                </div>
              </section>
            )
          })}
          <Button block type="dashed" icon={<PlusOutlined />} style={{ height: 44 }} onClick={() => setItems((p) => [...p, blankItem()])}>
            Add line item
          </Button>
        </>
      )}

      <Totals totals={totals} quotation={quotation} editing={editable} blocker={blocker} />
    </div>
  )
}

/** Compact summary of the draft for the Next step card (price & send): totals, save state, preview. */
export function QuoteDraftSummary({ draft, onEdit }) {
  const totals = useTotals(draft.derived)
  const pdf = useQuotePdf()
  return (
    <div className="braq-inset braq-draft-summary">
      <div>
        <div style={{ fontWeight: 600 }}>{plural(draft.items.length, 'item')} · {plural(totals.units, 'unit')}</div>
        <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
          Total {money(totals.total)} incl. VAT · deposit {money(totals.deposit)}
        </div>
        <SaveIndicator draft={draft} />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button size="small" icon={<FilePdfOutlined />} loading={pdf.loading} disabled={!draft.items.length}
          onClick={() => pdf.open(draft.quotationId, { before: draft.flush })}>
          Preview PDF
        </Button>
        {onEdit && <Button size="small" onClick={onEdit}>Edit the quote</Button>}
      </div>
    </div>
  )
}

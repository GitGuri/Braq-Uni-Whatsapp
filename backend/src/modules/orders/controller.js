import { z } from 'zod';
import * as ordersService from './service.js';
import * as paymentsService from '../payments/service.js';
import { renderSizeRunSheet } from './sizeRunSheet.pdf.js';
import { parseSizeFile, bulkInsertSizeEntries, listSizeEntries } from './sizes.js';
import { lifecycleForOrder } from '../jobs/service.js';
import { LineItemSchema } from '../quotations/controller.js';
import { sendError, validationBody, isUuid } from '../../core/errors.js';
import { paged } from '../../core/http.js';
import { logger } from '../../core/logger.js';

const CLIENT_TYPES = ['retail','school','corporate','hospitality','church','security','government','reseller'];

/** 'YYYY-MM-DD' (optionally followed by an ISO time) that is a real calendar date. */
function isValidDateString(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return y >= 2000 && y <= 2100
    && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
    && !Number.isNaN(Date.parse(v));
}

/** Positive amount with at most 2 decimal places (payments.amount is NUMERIC(12,2)). */
const hasAtMostTwoDecimals = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

// Every order comes from a quotation: an accepted quotationId, or lineItems
// (an accepted quotation is created from them first).
const CreateOrderSchema = z.object({
  clientId:        z.string().uuid(),
  // Omitted → the client's own client_type is used.
  clientType:      z.enum(CLIENT_TYPES).optional(),
  quotationId:     z.string().uuid().optional(),
  lineItems:       z.array(LineItemSchema).min(1).max(200).optional(),
  poNumber:        z.string().max(100).optional(),
  assignedStaffId: z.string().uuid().optional(),
  conversationId:  z.string().uuid().optional(),
}).refine((d) => d.quotationId || d.lineItems, { message: 'Provide quotationId (an accepted quotation) or lineItems', path: ['quotationId'] });

const AmountSchema = z.number().finite().positive().max(1e9)
  .refine(hasAtMostTwoDecimals, 'must have at most 2 decimal places');

/** "Start production now" riding on another action (deposit recorded, design approved). */
const StartProductionSchema = z.object({
  estimatedCompletion: z.string().refine(isValidDateString, 'must be a valid date (YYYY-MM-DD)').optional(),
  notes:               z.string().max(2000).optional(),
}).nullable().optional();

const AdvanceStageSchema = z.object({
  notes:               z.string().max(2000).optional(),
  estimatedCompletion: z.string().refine(isValidDateString, 'must be a valid date (YYYY-MM-DD)').optional(),
  trackingNumber:      z.string().max(100).optional(),
  deliveryType:        z.enum(['collection','delivery']).optional().default('collection'),
  // Push past an overridable guard (admin / manager, reason ≥ 5 chars — checked by the lifecycle guards).
  override:            z.object({ reason: z.string().max(1000) }).nullable().optional(),
  // Money taken in the same step (e.g. the balance when the client collects) — recorded first, same transaction.
  payment:             z.object({
    amount: AmountSchema,
    type:   z.enum(['deposit', 'balance', 'full']).default('balance'),
    notes:  z.string().max(2000).optional(),
  }).nullable().optional(),
});

const RecordPaymentSchema = z.object({
  type:     z.enum(['deposit', 'balance', 'full']),
  amount:   z.number().finite().positive().max(1e9)
              .refine(hasAtMostTwoDecimals, 'must have at most 2 decimal places'),
  currency: z.string().length(3).default('ZAR'),
  notes:    z.string().max(2000).optional(),
  startProduction: StartProductionSchema,
});

const HoldSchema = z.object({
  isOnHold:   z.boolean(),
  holdReason: z.string().max(200).optional(),
});

const DelaySchema = z.object({
  reason: z.string().max(200).optional(),
}).optional();

const AssignSchema = z.object({
  staffId: z.string().uuid(),
});

const ConvertSchema = z.object({
  // "Client accepted — create order": accept a sent quote and create the order in one step.
  accept:          z.boolean().optional(),
  poNumber:        z.string().max(100).optional(),
  assignedStaffId: z.string().uuid().optional(),
  conversationId:  z.string().uuid().optional(),
});

const ProofSchema = z.object({
  proofUrl: z.string().max(2000).url()
              .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL'),
  notes:    z.string().max(2000).nullable().optional(),
});

const ProofStatusSchema = z.object({
  status: z.enum(['approved', 'revision_requested', 'sent']),
  notes:  z.string().max(2000).nullable().optional(),
  startProduction: StartProductionSchema,
});

const MATERIALS_MAX_BYTES = 10 * 1024;
const MaterialsSchema = z.record(z.unknown())
  .refine((v) => JSON.stringify(v).length <= MATERIALS_MAX_BYTES, `must be at most ${MATERIALS_MAX_BYTES} bytes`);

const ListQuerySchema = z.object({
  clientType: z.enum(CLIENT_TYPES).optional(),
  staffId:    z.string().uuid().optional(),
});

function handleError(res, err, fallback) {
  return sendError(res, err, fallback);
}

/** 400 for a non-UUID :id; returns true when the response was already sent. */
function rejectBadId(req, res, label = 'order') {
  if (isUuid(req.params.id)) return false;
  res.status(400).json({ error: `Invalid ${label} id` });
  return true;
}

// ── GET /orders ──────────────────────────────────────────────────────────────
// Response: { items, total, page, limit, orders (legacy key) }; rows carry lifecycle_state
export async function list(req, res) {
  const filters = ListQuerySchema.safeParse({
    clientType: req.query.clientType || undefined,
    staffId:    req.query.staffId || undefined,
  });
  if (!filters.success) return res.status(400).json(validationBody(filters.error));

  try {
    const result = await ordersService.listOrders({ ...req.query, ...filters.data });
    paged(res, 'orders', result);
  } catch (err) { handleError(res, err, 'Failed to fetch orders'); }
}

// ── GET /orders/kpis ─────────────────────────────────────────────────────────
export async function kpis(req, res) {
  try {
    const data = await ordersService.getDashboardKpis();
    res.json(data);
  } catch (err) { handleError(res, err, 'Failed to fetch KPIs'); }
}

// ── GET /orders/:id ──────────────────────────────────────────────────────────
export async function getById(req, res) {
  if (rejectBadId(req, res)) return;
  try {
    const result = await ordersService.getOrderById(req.params.id);
    const info = ordersService.getStageInfo(result.order.stage);
    const lifecycle = await lifecycleForOrder(result, req.staff);
    res.json({ ...result, stageInfo: info, lifecycle });
  } catch (err) { handleError(res, err, 'Failed to fetch order'); }
}

// ── POST /orders ─────────────────────────────────────────────────────────────
export async function create(req, res) {
  const parsed = CreateOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    const data = { ...parsed.data, assignedStaffId: parsed.data.assignedStaffId || req.staff.id };
    await ordersService.validateOrderRefs(data);
    const order = await ordersService.createOrder(data, req.staff);
    res.status(201).json({ order, quotationId: order.quotation_id });
  } catch (err) { handleError(res, err, 'Failed to create order'); }
}

// ── POST /orders/convert-from-quotation/:id ──────────────────────────────────
export async function convertFromQuotation(req, res) {
  if (rejectBadId(req, res, 'quotation')) return;
  const parsed = ConvertSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    if (parsed.data.assignedStaffId) await ordersService.assertAssignableStaff(parsed.data.assignedStaffId);
    const order = await ordersService.convertFromQuotation(req.params.id, req.staff, parsed.data);
    logger.info('Quotation converted to order', { quotationId: req.params.id, orderId: order.id, by: req.staff.email });
    res.status(201).json({ order });
  } catch (err) { handleError(res, err, 'Failed to convert quotation to order'); }
}

// ── POST /orders/:id/advance ─────────────────────────────────────────────────
export async function advance(req, res) {
  if (rejectBadId(req, res)) return;
  const parsed = AdvanceStageSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    const { order, from, to, overridden, payment } = await ordersService.advanceOrderStage(req.params.id, req.staff, parsed.data);
    logger.info('Order stage advanced', { orderId: req.params.id, from, to, overridden, paid: Boolean(payment), by: req.staff.email });
    res.json({ order, from, to, overridden, ...(payment ? { payment } : {}) });
  } catch (err) { handleError(res, err, 'Failed to advance order stage'); }
}

// ── PATCH /orders/:id/hold ───────────────────────────────────────────────────
export async function hold(req, res) {
  if (rejectBadId(req, res)) return;
  const parsed = HoldSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    const order = await ordersService.setOrderHold(req.params.id, parsed.data);
    res.json({ order });
  } catch (err) { handleError(res, err, 'Failed to update hold status'); }
}

// ── POST /orders/:id/delay ───────────────────────────────────────────────────
// Documented shortcut: put the order on hold with reason 'supplier_delay'
// (notifies the client the first time).
export async function delay(req, res) {
  if (rejectBadId(req, res)) return;
  const parsed = DelaySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    const order = await ordersService.setOrderHold(req.params.id, { isOnHold: true, holdReason: 'supplier_delay' });
    res.json({ order });
  } catch (err) { handleError(res, err, 'Failed to flag order as delayed'); }
}

// ── PATCH /orders/:id/assign ─────────────────────────────────────────────────
export async function assign(req, res) {
  if (rejectBadId(req, res)) return;
  const parsed = AssignSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const missing = req.body?.staffId === undefined || req.body?.staffId === null || req.body?.staffId === '';
    return res.status(400).json(missing ? { error: 'staffId required' } : validationBody(parsed.error));
  }

  try {
    await ordersService.assertAssignableStaff(parsed.data.staffId);
    const order = await ordersService.assignOrder(req.params.id, parsed.data.staffId);
    res.json({ order });
  } catch (err) { handleError(res, err, 'Failed to assign consultant'); }
}

// ── POST /orders/:id/payments ────────────────────────────────────────────────
export async function recordPayment(req, res) {
  if (rejectBadId(req, res)) return;
  const parsed = RecordPaymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    const { payment, advanced } = await ordersService.recordPaymentAndAdvance(req.params.id, req.staff, parsed.data);
    res.status(201).json({ payment, ...(advanced ? { advanced } : {}) });
  } catch (err) { handleError(res, err, 'Failed to record payment'); }
}

// ── GET /orders/:id/payments ─────────────────────────────────────────────────
export async function listPayments(req, res) {
  if (rejectBadId(req, res)) return;
  try {
    await ordersService.assertOrderExists(req.params.id);
    const payments = await paymentsService.listPayments(req.params.id);
    res.json({ payments });
  } catch (err) { handleError(res, err, 'Failed to fetch payments'); }
}

// ── PATCH /orders/:id/materials ──────────────────────────────────────────────
export async function updateMaterials(req, res) {
  if (rejectBadId(req, res)) return;
  const parsed = MaterialsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    const order = await ordersService.updateMaterialNotes(req.params.id, parsed.data);
    res.json({ order });
  } catch (err) { handleError(res, err, 'Failed to update material notes'); }
}

// ── POST /orders/:id/proof ───────────────────────────────────────────────────
export async function sendProof(req, res) {
  if (rejectBadId(req, res)) return;
  if (!req.body?.proofUrl) return res.status(400).json({ error: 'proofUrl is required' });
  const parsed = ProofSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    const order = await ordersService.sendProofToClient(req.params.id, parsed.data.proofUrl, parsed.data.notes, req.staff);
    res.json({ order });
  } catch (err) { handleError(res, err, 'Failed to send proof'); }
}

// ── PATCH /orders/:id/proof/status ───────────────────────────────────────────
export async function updateProofStatus(req, res) {
  if (rejectBadId(req, res)) return;
  if (!req.body?.status) return res.status(400).json({ error: 'status is required' });
  const parsed = ProofStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    const order = await ordersService.updateProofStatus(req.params.id, parsed.data.status, parsed.data.notes, req.staff, {
      startProduction: parsed.data.startProduction ?? null,
    });
    res.json({ order });
  } catch (err) { handleError(res, err, 'Failed to update proof status'); }
}

// ── POST /orders/:id/sizes/upload ────────────────────────────────────────────
// multipart/form-data, field "file" (.xlsx or .csv with Name, Size[, Notes]).
// Replaces the order's existing roster. Response: 201 { sizes, count }
export async function uploadSizes(req, res) {
  if (rejectBadId(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded — send a .xlsx or .csv file in the "file" field' });
  if (!req.file.size) return res.status(400).json({ error: 'Uploaded file is empty' });

  try {
    await ordersService.assertOrderExists(req.params.id);
    const rows = await parseSizeFile(req.file.buffer, req.file.mimetype, req.file.originalname);
    const sizes = await bulkInsertSizeEntries(req.params.id, rows, { replace: true });
    logger.info('Size roster uploaded', { orderId: req.params.id, count: sizes.length, by: req.staff?.email });
    res.status(201).json({ sizes, count: sizes.length });
  } catch (err) { handleError(res, err, 'Failed to upload size roster'); }
}

// ── GET /orders/:id/sizes ────────────────────────────────────────────────────
// Response: { sizes }
export async function listSizes(req, res) {
  if (rejectBadId(req, res)) return;
  try {
    await ordersService.assertOrderExists(req.params.id);
    const sizes = await listSizeEntries(req.params.id);
    res.json({ sizes });
  } catch (err) { handleError(res, err, 'Failed to fetch size roster'); }
}

// ── GET /orders/:id/size-run-sheet ───────────────────────────────────────────
export async function sizeRunSheet(req, res) {
  if (rejectBadId(req, res)) return;
  try {
    const { order, items } = await ordersService.getSizeRunSheetData(req.params.id);

    const pdf = await renderSizeRunSheet({ order, items });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="size-run-${order.reference}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    res.end(pdf);
  } catch (err) { handleError(res, err, 'Failed to generate size run sheet'); }
}

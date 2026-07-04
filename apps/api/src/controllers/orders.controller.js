import { z } from 'zod';
import * as ordersService from '../services/orders.service.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

const CLIENT_TYPES = ['retail','school','corporate','hospitality','church','security','government','reseller'];

const CreateOrderSchema = z.object({
  clientId:        z.string().uuid(),
  clientType:      z.enum(CLIENT_TYPES).default('retail'),
  quotationId:     z.string().uuid().optional(),
  poNumber:        z.string().optional(),
  assignedStaffId: z.string().uuid().optional(),
});

const AdvanceStageSchema = z.object({
  notes:               z.string().optional(),
  estimatedCompletion: z.string().optional(),
  trackingNumber:      z.string().optional(),
  deliveryType:        z.enum(['collection','delivery']).optional().default('collection'),
});

const RecordPaymentSchema = z.object({
  type:     z.enum(['deposit', 'balance', 'full']),
  amount:   z.number().positive(),
  currency: z.string().length(3).default('ZAR'),
  notes:    z.string().optional(),
});

const HoldSchema = z.object({
  isOnHold:   z.boolean(),
  holdReason: z.string().optional(),
});

const ConvertSchema = z.object({
  poNumber:        z.string().optional(),
  assignedStaffId: z.string().uuid().optional(),
});

function handleError(res, err, fallback) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  logger.error(fallback, { error: err.message });
  return res.status(500).json({ error: fallback });
}

// ── GET /orders ──────────────────────────────────────────────────────────────
export async function list(req, res) {
  try {
    const orders = await ordersService.listOrders(req.query);
    res.json({ orders });
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
  try {
    const result = await ordersService.getOrderById(req.params.id);
    const info = ordersService.getStageInfo(result.order.stage);
    res.json({ ...result, stageInfo: info });
  } catch (err) { handleError(res, err, 'Failed to fetch order'); }
}

// ── POST /orders ─────────────────────────────────────────────────────────────
export async function create(req, res) {
  const parsed = CreateOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const order = await ordersService.createOrder({ ...parsed.data, assignedStaffId: parsed.data.assignedStaffId || req.staff.id });
    res.status(201).json({ order });
  } catch (err) { handleError(res, err, 'Failed to create order'); }
}

// ── POST /orders/:id/convert-from-quotation ──────────────────────────────────
export async function convertFromQuotation(req, res) {
  const parsed = ConvertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const order = await ordersService.convertFromQuotation(req.params.id, req.staff.id, parsed.data);
    logger.info('Quotation converted to order', { quotationId: req.params.id, orderId: order.id, by: req.staff.email });
    res.status(201).json({ order });
  } catch (err) { handleError(res, err, 'Failed to convert quotation to order'); }
}

// ── POST /orders/:id/advance ─────────────────────────────────────────────────
export async function advance(req, res) {
  const parsed = AdvanceStageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const { order, from, to } = await ordersService.advanceOrderStage(req.params.id, req.staff.id, parsed.data);
    logger.info('Order stage advanced', { orderId: req.params.id, from, to, by: req.staff.email });
    res.json({ order, from, to });
  } catch (err) { handleError(res, err, 'Failed to advance order stage'); }
}

// ── PATCH /orders/:id/hold ───────────────────────────────────────────────────
export async function hold(req, res) {
  const parsed = HoldSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const order = await ordersService.setOrderHold(req.params.id, parsed.data);
    res.json({ order });
  } catch (err) { handleError(res, err, 'Failed to update hold status'); }
}

// ── PATCH /orders/:id/assign ─────────────────────────────────────────────────
export async function assign(req, res) {
  const { staffId } = req.body;
  if (!staffId) return res.status(400).json({ error: 'staffId required' });

  try {
    const order = await ordersService.assignOrder(req.params.id, staffId);
    res.json({ order });
  } catch (err) { handleError(res, err, 'Failed to assign consultant'); }
}

// ── POST /orders/:id/payments ────────────────────────────────────────────────
export async function recordPayment(req, res) {
  const parsed = RecordPaymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const payment = await ordersService.recordPayment(req.params.id, parsed.data);
    res.status(201).json({ payment });
  } catch (err) { handleError(res, err, 'Failed to record payment'); }
}

// ── GET /orders/:id/payments ─────────────────────────────────────────────────
export async function listPayments(req, res) {
  try {
    const payments = await ordersService.listPayments(req.params.id);
    res.json({ payments });
  } catch (err) { handleError(res, err, 'Failed to fetch payments'); }
}

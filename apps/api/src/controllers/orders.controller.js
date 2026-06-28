import { z } from 'zod';
import * as ordersService from '../services/orders.service.js';
import * as paymentsService from '../services/payments.service.js';
import * as sizesService from '../services/sizes.service.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

const CreateOrderSchema = z.object({
  clientId:            z.string().uuid(),
  clientType:          z.enum(['retail','school','corporate','hospitality','church','security','government','reseller']),
  description:         z.string().min(1).max(1000),
  quantity:            z.number().int().positive().optional(),
  estimatedCompletion: z.string().optional(), // ISO date string
  specialNotes:        z.string().optional(),
  isUrgent:            z.boolean().default(false),
});

const AdvanceStageSchema = z.object({
  notes:               z.string().optional(),
  estimatedCompletion: z.string().optional(),
  trackingNumber:      z.string().optional(),
  deliveryType:        z.enum(['collection','delivery']).optional().default('collection'),
});

const RecordPaymentSchema = z.object({
  amount: z.number().positive(),
  type:   z.enum(['deposit', 'balance', 'full']),
  notes:  z.string().optional(),
});

function handleError(res, err, fallbackMessage) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  logger.error(fallbackMessage, { error: err.message });
  return res.status(500).json({ error: fallbackMessage });
}

// ── GET /orders ────────────────────────────────────────────────────────────────
export async function list(req, res) {
  try {
    const { page = 1, limit = 20 } = req.query;
    const orders = await ordersService.listOrders(req.query);
    res.json({ orders, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    handleError(res, err, 'Failed to fetch orders');
  }
}

// ── GET /orders/:id ────────────────────────────────────────────────────────────
export async function getById(req, res) {
  try {
    const result = await ordersService.getOrderById(req.params.id);
    const { percent } = ordersService.getStageProgress(result.order.stage);
    res.json({ ...result, progressPercent: percent });
  } catch (err) {
    handleError(res, err, 'Failed to fetch order');
  }
}

// ── POST /orders ───────────────────────────────────────────────────────────────
export async function create(req, res) {
  const parsed = CreateOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const order = await ordersService.createOrder(parsed.data, req.staff.id);
    res.status(201).json({ order });
  } catch (err) {
    handleError(res, err, 'Failed to create order');
  }
}

// ── POST /orders/:id/advance ───────────────────────────────────────────────────
export async function advance(req, res) {
  const parsed = AdvanceStageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const { order, from, to } = await ordersService.advanceOrderStage(req.params.id, req.staff.id, parsed.data);
    logger.info('Order stage advanced', {
      orderId: req.params.id, reference: order.reference, from, to, by: req.staff.email,
    });
    res.json({ order, from, to });
  } catch (err) {
    handleError(res, err, 'Failed to advance order stage');
  }
}

// ── POST /orders/:id/delay ─────────────────────────────────────────────────────
export async function delay(req, res) {
  try {
    const order = await ordersService.delayOrder(req.params.id, req.body);
    res.json({ order });
  } catch (err) {
    handleError(res, err, 'Failed to flag delay');
  }
}

// ── PATCH /orders/:id/assign ───────────────────────────────────────────────────
export async function assign(req, res) {
  const { staffId } = req.body;
  if (!staffId) return res.status(400).json({ error: 'staffId required' });

  try {
    const order = await ordersService.assignOrder(req.params.id, staffId);
    res.json({ order });
  } catch (err) {
    handleError(res, err, 'Failed to assign consultant');
  }
}

// ── POST /orders/:id/payments ──────────────────────────────────────────────────
export async function recordPayment(req, res) {
  const parsed = RecordPaymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const order = await paymentsService.recordPayment(req.params.id, { ...parsed.data, staffId: req.staff.id });
    res.status(201).json({ order });
  } catch (err) {
    handleError(res, err, 'Failed to record payment');
  }
}

// ── GET /orders/:id/payments ───────────────────────────────────────────────────
export async function listPayments(req, res) {
  try {
    const payments = await paymentsService.listPaymentsForOrder(req.params.id);
    res.json({ payments });
  } catch (err) {
    handleError(res, err, 'Failed to fetch payments');
  }
}

// ── POST /orders/:id/sizes/upload ──────────────────────────────────────────────
export async function uploadSizes(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const rows = await sizesService.parseSizeFile(req.file.buffer, req.file.mimetype, req.file.originalname);
    const entries = await sizesService.bulkInsertSizeEntries(req.params.id, rows);
    res.status(201).json({ entries });
  } catch (err) {
    handleError(res, err, 'Failed to process size file');
  }
}

// ── GET /orders/:id/sizes ──────────────────────────────────────────────────────
export async function listSizes(req, res) {
  try {
    const entries = await sizesService.listSizeEntries(req.params.id);
    res.json({ entries });
  } catch (err) {
    handleError(res, err, 'Failed to fetch size entries');
  }
}

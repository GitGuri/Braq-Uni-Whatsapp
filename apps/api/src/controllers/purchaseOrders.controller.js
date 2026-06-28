import { z } from 'zod';
import * as purchaseOrdersService from '../services/purchaseOrders.service.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

const CreatePurchaseOrderSchema = z.object({
  quotationId: z.string().uuid(),
  poNumber:    z.string().min(1),
  status:      z.enum(['pending_review', 'valid', 'invalid']).default('pending_review'),
  notes:       z.string().optional(),
});

function handleError(res, err, fallbackMessage) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  logger.error(fallbackMessage, { error: err.message });
  return res.status(500).json({ error: fallbackMessage });
}

export async function list(req, res) {
  try {
    const purchaseOrders = await purchaseOrdersService.listPurchaseOrders();
    res.json({ purchaseOrders });
  } catch (err) {
    handleError(res, err, 'Failed to fetch purchase orders');
  }
}

export async function create(req, res) {
  const parsed = CreatePurchaseOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const purchaseOrder = await purchaseOrdersService.createPurchaseOrderManually({
      ...parsed.data,
      validatedBy: req.staff.id,
    });
    res.status(201).json({ purchaseOrder });
  } catch (err) {
    handleError(res, err, 'Failed to create purchase order');
  }
}

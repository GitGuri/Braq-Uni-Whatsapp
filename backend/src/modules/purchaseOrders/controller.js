import { z } from 'zod';
import * as purchaseOrdersService from './service.js';
import { sendError, validationBody } from '../../core/errors.js';
import { paged } from '../../core/http.js';
import { logger } from '../../core/logger.js';

const blankToUndefined = (v) => (v === '' || v === null ? undefined : v);

// The PO's status is decided by validation against the quotation, never by the caller.
const CreatePurchaseOrderSchema = z.object({
  quotationId: z.string().uuid({ message: 'quotationId must be a quotation UUID' }),
  poNumber:    z.string().trim().min(1).max(100),
  amount:      z.preprocess(blankToUndefined, z.coerce.number().finite().nonnegative().optional()),
  notes:       z.string().optional(),
});

function handleError(res, err, fallbackMessage) {
  return sendError(res, err, fallbackMessage);
}

export async function list(req, res) {
  try {
    const result = await purchaseOrdersService.listPurchaseOrders(req.query);
    paged(res, 'purchaseOrders', result);
  } catch (err) {
    handleError(res, err, 'Failed to fetch purchase orders');
  }
}

export async function create(req, res) {
  const parsed = CreatePurchaseOrderSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    const result = await purchaseOrdersService.createPurchaseOrder({
      ...parsed.data,
      staffId: req.staff.id,
    });

    if (!result.valid) {
      // Recorded as 'invalid' for the audit trail; tell the caller why.
      return res.status(422).json({
        error:         `Purchase order rejected: ${result.reasons.join('; ')}`,
        reasons:       result.reasons,
        purchaseOrder: result.purchaseOrder,
      });
    }

    logger.info('Purchase order validated — order created', {
      purchaseOrderId: result.purchaseOrder.id,
      orderId:         result.order.id,
      by:              req.staff.email,
    });
    res.status(201).json({
      purchaseOrder: result.purchaseOrder,
      order:         result.order,
      warnings:      result.warnings,
    });
  } catch (err) {
    handleError(res, err, 'Failed to create purchase order');
  }
}

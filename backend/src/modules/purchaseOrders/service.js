import { query, withTransaction } from '../../core/db.js';
import { getQuotationById } from '../quotations/service.js';
import { convertQuotationToOrder } from '../orders/convert.js';
import { recordJobEvent } from '../jobs/events.js';
import { validatePurchaseOrder } from '../../validators/purchaseOrder.validator.js';
import { pageParams } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

// purchase_orders.status values
export const PO_STATUSES = ['pending_review', 'valid', 'invalid'];

async function insertPurchaseOrder({ quotationId, poNumber, status, notes, validatedBy }) {
  const { rows } = await query(
    `INSERT INTO purchase_orders (quotation_id, po_number, status, notes, validated_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [quotationId, poNumber, status, notes || null, validatedBy || null]
  );
  return rows[0];
}

async function setPurchaseOrderResult(id, { status, orderId = null, notes }, db = { query }) {
  const { rows } = await db.query(
    `UPDATE purchase_orders
     SET status = $1, order_id = COALESCE($2, order_id), notes = COALESCE($3, notes), updated_at = NOW()
     WHERE id = $4 RETURNING *`,
    [status, orderId, notes ?? null, id]
  );
  return rows[0];
}

const joinNotes = (...parts) => parts.filter(Boolean).join('\n') || null;

/**
 * Validate a PO against its quotation and, when valid, create the order.
 *
 * A PO is valid when the quotation is 'sent' or 'accepted', still within its
 * validity window, and not already converted to an order. A valid PO accepts
 * the quotation (if still 'sent') and converts it through the one order-creation
 * path (orders/convert.js, source 'po') — the order starts at 'deposit_pending'
 * with the 60/40 deposit split and the client's deposit message is queued.
 * Every submission is recorded in purchase_orders, valid or not (audit trail).
 *
 * @returns {{ valid: boolean, purchaseOrder, order?, quotation, reasons: string[], warnings: string[] }}
 */
async function processPurchaseOrder(quotation, { poNumber, amount, notes, staffId }) {
  const check = validatePurchaseOrder(
    { quotation_id: quotation.id, po_number: poNumber, amount },
    quotation,
  );
  const reasons  = [...check.missing];
  const warnings = check.warnings;
  if (quotation.order_id) reasons.push('quotation has already been converted to an order');

  if (reasons.length) {
    const purchaseOrder = await insertPurchaseOrder({
      quotationId: quotation.id,
      poNumber,
      status:      'invalid',
      notes:       joinNotes(notes, `Rejected: ${reasons.join('; ')}`),
      validatedBy: staffId,
    });
    return { valid: false, purchaseOrder, quotation, reasons, warnings };
  }

  // Record first so a failed conversion still leaves a trace.
  const pending = await insertPurchaseOrder({
    quotationId: quotation.id,
    poNumber,
    status:      'pending_review',
    notes:       joinNotes(notes, warnings.length ? `Warning: ${warnings.join('; ')}` : null),
    validatedBy: staffId,
  });

  try {
    // A PO is the client's acceptance of a sent quotation: convert accepts it inline.
    const { order, purchaseOrder } = await withTransaction(async (tx) => {
      const created = await convertQuotationToOrder(tx, { quotationId: quotation.id, actor: staffId ? { id: staffId } : null, source: 'po', poNumber });
      const po = await setPurchaseOrderResult(pending.id, { status: 'valid', orderId: created.id }, tx);
      await recordJobEvent(tx, { quotationId: quotation.id, orderId: created.id, type: 'po.recorded', actorId: staffId, data: { poNumber } });
      return { order: created, purchaseOrder: po };
    });
    return { valid: true, purchaseOrder, order, quotation, reasons: [], warnings };
  } catch (err) {
    // Concurrent conversion / expiry race etc. — mark the PO invalid and surface the error.
    await setPurchaseOrderResult(pending.id, {
      status: 'invalid',
      notes:  joinNotes(pending.notes, `Rejected: ${err.message}`),
    }).catch((e) => logger.error('Failed to mark purchase order invalid', { error: e.message }));
    throw err;
  }
}

// ── Dashboard: record a PO for a quotation id ─────────────────────────────────
export async function createPurchaseOrder({ quotationId, poNumber, amount, notes, staffId }) {
  const quotation = await getQuotationById(quotationId);   // 404 if unknown
  return processPurchaseOrder(quotation, { poNumber, amount, notes, staffId });
}

// Returns { items, total, page, limit }.
export async function listPurchaseOrders(queryParams = {}) {
  const { page, limit, offset } = pageParams(queryParams, { defaultLimit: 50 });
  const { rows } = await query(
    `SELECT po.*,
            q.reference AS quotation_reference,
            q.total     AS quotation_total,
            q.total     AS amount,          -- PO list UI shows the amount; a valid PO is for the quotation total
            c.name      AS client_name,
            o.reference AS order_reference,
            s.name      AS validated_by_name
     FROM purchase_orders po
     JOIN quotations q   ON po.quotation_id = q.id
     LEFT JOIN clients c ON q.client_id     = c.id
     LEFT JOIN orders o  ON po.order_id     = o.id
     LEFT JOIN staff s   ON po.validated_by = s.id
     ORDER BY po.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const { rows: countRows } = await query('SELECT COUNT(*)::int AS total FROM purchase_orders');
  return { items: rows, total: countRows[0].total, page, limit };
}

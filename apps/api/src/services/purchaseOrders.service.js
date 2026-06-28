import { query } from '../db/pool.js';
import { getQuotationByReference } from './quotations.service.js';
import { createOrder } from './orders.service.js';
import { requireDeposit } from './payments.service.js';
import { HttpError } from '../utils/httpError.js';

function summarizeLineItems(lineItems) {
  const quantity = lineItems.reduce((sum, i) => sum + i.quantity, 0);
  const description = lineItems.map((i) => `${i.quantity} x ${i.name}`).join('\n');
  return { quantity, description };
}

// ── Validate a PO against the quotation it references, then create the order ─
export async function submitPurchaseOrder(quotationReference, poNumber, clientId) {
  const quotation = await getQuotationByReference(quotationReference, clientId);
  if (!quotation) throw new HttpError(404, 'Quotation not found');

  const isValid = ['sent', 'accepted'].includes(quotation.status)
    && quotation.valid_until
    && new Date(quotation.valid_until) >= new Date(new Date().toDateString());

  if (!isValid) {
    await query(
      `INSERT INTO purchase_orders (quotation_id, po_number, status, notes)
       VALUES ($1, $2, 'invalid', $3)`,
      [quotation.id, poNumber, `Quotation status was '${quotation.status}', valid_until ${quotation.valid_until}`]
    );
    return { valid: false, quotation };
  }

  const { quantity, description } = summarizeLineItems(quotation.line_items);
  const clientRow = await query('SELECT client_type FROM clients WHERE id = $1', [clientId]);

  const order = await createOrder({
    clientId,
    clientType: clientRow.rows[0]?.client_type || 'corporate',
    description: `Order from quotation ${quotation.reference} (PO ${poNumber}):\n${description}`,
    quantity,
    quotationId: quotation.id,
    initialStage: 'purchase_order_received',
  }, null);

  await query(
    `INSERT INTO purchase_orders (quotation_id, order_id, po_number, status)
     VALUES ($1, $2, $3, 'valid')`,
    [quotation.id, order.id, poNumber]
  );
  await query('UPDATE quotations SET order_id = $1 WHERE id = $2', [order.id, quotation.id]);

  const updatedOrder = await requireDeposit(order, quotation);

  return { valid: true, order: updatedOrder, quotation };
}

export async function listPurchaseOrders() {
  const { rows } = await query(
    `SELECT po.*, q.reference AS quotation_reference, o.reference AS order_reference
     FROM purchase_orders po
     JOIN quotations q ON po.quotation_id = q.id
     LEFT JOIN orders o ON po.order_id = o.id
     ORDER BY po.created_at DESC`
  );
  return rows;
}

export async function createPurchaseOrderManually({ quotationId, poNumber, status = 'pending_review', notes, validatedBy }) {
  const { rows } = await query(
    `INSERT INTO purchase_orders (quotation_id, po_number, status, notes, validated_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [quotationId, poNumber, status, notes || null, validatedBy || null]
  );
  return rows[0];
}

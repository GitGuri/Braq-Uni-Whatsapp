import { query, withTransaction } from '../db/pool.js';
import { sendTextMessage } from './whatsapp.service.js';
import { TEMPLATES, templateForStage } from './bot.templates.js';
import { HttpError } from '../utils/httpError.js';

const STAGE_ORDER = [
  'quotation_requested',
  'quotation_submitted',
  'purchase_order_received',
  'design_approval_pending',
  'materials_procurement',
  'production_scheduled',
  'manufacturing',
  'branding_embroidery',
  'quality_control',
  'packing_dispatch',
  'completed',
];

function nextStage(current) {
  const idx = STAGE_ORDER.indexOf(current);
  return idx >= 0 && idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1] : null;
}

// ── Stage progress, e.g. for "Track Order" replies ────────────────────────────
export function getStageProgress(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0) return { index: null, total: STAGE_ORDER.length, percent: null };
  const percent = Math.round(((idx + 1) / STAGE_ORDER.length) * 100);
  return { index: idx, total: STAGE_ORDER.length, percent };
}

function generateRef() {
  const date = new Date();
  const ymd  = date.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `BRQ-${ymd}-${rand}`;
}

// ── List orders with pagination and filters ──────────────────────────────────
export async function listOrders({ stage, clientType, staffId, urgent, isDelayed, active, page = 1, limit = 20 }) {
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = ['1=1'];
  const params = [];

  if (stage)                           { params.push(stage);      where.push(`o.stage = $${params.length}`); }
  if (clientType)                      { params.push(clientType); where.push(`o.client_type = $${params.length}`); }
  if (staffId)                         { params.push(staffId);    where.push(`o.assigned_staff_id = $${params.length}`); }
  if (urgent === 'true')               where.push('o.is_urgent = true');
  if (isDelayed === 'true' || isDelayed === true) where.push('o.is_delayed = true');
  if (active === 'true'   || active === true)     where.push(`o.stage NOT IN ('completed','cancelled')`);

  params.push(parseInt(limit)); params.push(offset);

  const sql = `
    SELECT
      o.*,
      c.name        AS client_name,
      c.whatsapp_number,
      c.organisation,
      s.name        AS staff_name
    FROM orders o
    JOIN clients c ON o.client_id = c.id
    LEFT JOIN staff s ON o.assigned_staff_id = s.id
    WHERE ${where.join(' AND ')}
    ORDER BY o.is_urgent DESC, o.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;

  const { rows } = await query(sql, params);
  return rows;
}

// ── Get a single order with its stage history ───────────────────────────────
export async function getOrderById(id) {
  const { rows } = await query(
    `SELECT o.*, c.name AS client_name, c.whatsapp_number, c.organisation,
            s.name AS staff_name
     FROM orders o
     JOIN clients c ON o.client_id = c.id
     LEFT JOIN staff s ON o.assigned_staff_id = s.id
     WHERE o.id = $1`,
    [id]
  );
  if (!rows.length) throw new HttpError(404, 'Order not found');

  const history = await query(
    `SELECT h.*, s.name AS changed_by_name
     FROM order_stage_history h
     LEFT JOIN staff s ON h.changed_by = s.id
     WHERE h.order_id = $1
     ORDER BY h.changed_at ASC`,
    [id]
  );

  return { order: rows[0], history: history.rows };
}

// ── Create a new order ────────────────────────────────────────────────────────
// `initialStage` lets a caller skip the order straight to a later stage (e.g. a
// validated purchase order arrives after the quotation step already happened
// outside the order pipeline) — defaults to the normal starting stage.
export async function createOrder(data, staffId) {
  const {
    clientId, clientType, description, quantity, estimatedCompletion, specialNotes,
    isUrgent, quotationId, initialStage = 'quotation_requested',
  } = data;

  return withTransaction(async (client) => {
    const reference = generateRef();

    const { rows } = await client.query(
      `INSERT INTO orders (reference, client_id, assigned_staff_id, client_type, description, quantity,
        estimated_completion, special_notes, is_urgent, quotation_id, stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [reference, clientId, staffId, clientType, description, quantity || null,
       estimatedCompletion || null, specialNotes || null, isUrgent, quotationId || null, initialStage]
    );
    const order = rows[0];

    await client.query(
      `INSERT INTO order_stage_history (order_id, from_stage, to_stage, changed_by, notes)
       VALUES ($1, NULL, $2, $3, 'Order created')`,
      [order.id, initialStage, staffId]
    );

    const clientRow = await client.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    const cl = clientRow.rows[0];
    if (cl?.whatsapp_number) {
      const templateKey = initialStage === 'quotation_requested' ? 'STAGE_1_QUOTATION_REQUESTED' : templateForStage(initialStage);
      if (templateKey && TEMPLATES[templateKey]) {
        await sendTextMessage(cl.whatsapp_number, TEMPLATES[templateKey]({ reference }));
      }
    }

    return order;
  });
}

// ── Clone a previous order into a new one, restarting the pipeline ───────────
export async function repeatOrder(previousReference, clientId, staffId = null) {
  const { rows } = await query(
    'SELECT * FROM orders WHERE reference = $1 AND client_id = $2',
    [previousReference, clientId]
  );
  if (!rows.length) throw new HttpError(404, 'Previous order not found');

  const previous = rows[0];
  const order = await createOrder({
    clientId,
    clientType: previous.client_type,
    description: previous.description,
    quantity: previous.quantity,
    isUrgent: false,
  }, staffId);

  return { order, previousReference: previous.reference };
}

// ── Advance an order to its next stage ────────────────────────────────────────
export async function advanceOrderStage(orderId, staffId, data) {
  const { notes, estimatedCompletion, trackingNumber, deliveryType } = data;

  const { rows } = await query(
    `SELECT o.*, c.whatsapp_number, c.name AS client_name
     FROM orders o JOIN clients c ON o.client_id = c.id
     WHERE o.id = $1`,
    [orderId]
  );
  if (!rows.length) throw new HttpError(404, 'Order not found');

  const order = rows[0];
  const from  = order.stage;
  const to    = nextStage(from);

  if (!to) throw new HttpError(400, 'Order is already at final stage');
  if (['cancelled', 'on_hold'].includes(from))
    throw new HttpError(400, `Cannot advance an order that is ${from}`);
  if (from === 'design_approval_pending' && !order.design_approved_at)
    throw new HttpError(400, 'Design must be approved by the client before production can begin');

  const updatedOrder = await withTransaction(async (client) => {
    const setFields = ['stage = $1', 'updated_at = NOW()'];
    const params = [to];

    if (estimatedCompletion) { params.push(estimatedCompletion); setFields.push(`estimated_completion = $${params.length}`); }
    if (trackingNumber)      { params.push(trackingNumber);      setFields.push(`tracking_number = $${params.length}`); }

    params.push(order.id);
    await client.query(
      `UPDATE orders SET ${setFields.join(', ')} WHERE id = $${params.length}`,
      params
    );

    const histRow = await client.query(
      `INSERT INTO order_stage_history (order_id, from_stage, to_stage, changed_by, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [order.id, from, to, staffId, notes || null]
    );

    if (order.whatsapp_number) {
      const templateKey = to === 'completed' && deliveryType === 'delivery'
        ? 'STAGE_10_COMPLETED_DELIVERY'
        : templateForStage(to);

      if (templateKey && TEMPLATES[templateKey]) {
        const msg = TEMPLATES[templateKey]({
          reference: order.reference,
          estimatedCompletion: estimatedCompletion
            ? new Date(estimatedCompletion).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
            : order.estimated_completion,
          trackingNumber,
        });
        const waId = await sendTextMessage(order.whatsapp_number, msg);

        await client.query(
          'UPDATE order_stage_history SET wa_message_id = $1 WHERE id = $2',
          [waId, histRow.rows[0].id]
        );
      }

      // Flip the client's open conversation so their next reply is read as an
      // approve/reject response rather than free text.
      if (to === 'design_approval_pending') {
        await client.query(
          `UPDATE conversations SET state = 'corporate_design_approval', context = context || $1
           WHERE client_id = $2 AND is_open = true`,
          [JSON.stringify({ designApprovalOrderId: order.id }), order.client_id]
        );
      }
    }

    return { ...order, stage: to };
  });

  return { order: updatedOrder, from, to };
}

// ── Record the client's design/artwork approval response ─────────────────────
export async function recordDesignApproval(orderId, { approved, reason }, staffId = null) {
  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!rows.length) throw new HttpError(404, 'Order not found');
  const order = rows[0];

  if (order.stage !== 'design_approval_pending')
    throw new HttpError(400, 'Order is not awaiting design approval');

  if (approved) {
    await query('UPDATE orders SET design_approved_at = NOW(), updated_at = NOW() WHERE id = $1', [orderId]);
    return advanceOrderStage(orderId, staffId, {});
  }

  const { rows: updated } = await query(
    `UPDATE orders SET stage = 'on_hold', delay_reason = $1, design_rejection_reason = $1, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [reason || 'Design rejected by client', orderId]
  );
  return { order: updated[0], from: 'design_approval_pending', to: 'on_hold' };
}

// ── Flag an order as delayed ──────────────────────────────────────────────────
export async function delayOrder(orderId, { reason, notify = true }) {
  const { rows } = await query(
    `UPDATE orders SET is_delayed = true, delay_reason = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *, (SELECT whatsapp_number FROM clients WHERE id = client_id) AS whatsapp_number`,
    [reason || null, orderId]
  );
  if (!rows.length) throw new HttpError(404, 'Order not found');

  if (notify && rows[0].whatsapp_number) {
    const msg = TEMPLATES.SUPPLIER_DELAY({ reference: rows[0].reference });
    await sendTextMessage(rows[0].whatsapp_number, msg);
  }

  return rows[0];
}

// ── Assign a consultant to an order ───────────────────────────────────────────
export async function assignOrder(orderId, staffId) {
  const { rows } = await query(
    'UPDATE orders SET assigned_staff_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [staffId, orderId]
  );
  if (!rows.length) throw new HttpError(404, 'Order not found');
  return rows[0];
}

import { query, withTransaction } from '../db/pool.js';
import { sendTextMessage } from './whatsapp.service.js';
import { TEMPLATES, STAGE_ORDER, templateForStage, nextStage } from './bot.templates.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

// ── Daily-resetting order reference — BRQ-O-YYYYMMDD-XXXX ───────────────────
async function nextOrderRef() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO sequence_counters (key, date_key, value)
       VALUES ('order', $1, 1)
       ON CONFLICT (key, date_key) DO UPDATE SET value = sequence_counters.value + 1
       RETURNING value`,
      [today]
    );
    return `BRQ-O-${today}-${String(rows[0].value).padStart(4, '0')}`;
  });
}

function buildStageFilter(value) {
  return STAGE_ORDER.includes(value) ? value : null;
}

// ── List orders ───────────────────────────────────────────────────────────────
export async function listOrders({ stage, clientType, staffId, onHold, active, page = 1, limit = 20 } = {}) {
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const where = ['1=1'];
  const params = [];

  if (stage)     { params.push(stage);     where.push(`o.stage = $${params.length}`); }
  if (clientType){ params.push(clientType); where.push(`o.client_type = $${params.length}`); }
  if (staffId)   { params.push(staffId);   where.push(`o.assigned_staff_id = $${params.length}`); }
  if (onHold  === 'true') where.push('o.is_on_hold = true');
  if (active  === 'true') where.push(`o.stage != 'completed'`);

  params.push(parseInt(limit)); params.push(offset);

  const { rows } = await query(
    `SELECT o.*,
            c.name            AS client_name,
            c.whatsapp_number,
            c.organisation,
            s.name            AS staff_name
     FROM orders o
     JOIN   clients c ON o.client_id         = c.id
     LEFT JOIN staff s ON o.assigned_staff_id = s.id
     WHERE ${where.join(' AND ')}
     ORDER BY o.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

// ── Get a single order ────────────────────────────────────────────────────────
export async function getOrderById(id) {
  const { rows } = await query(
    `SELECT o.*,
            c.name            AS client_name,
            c.whatsapp_number,
            c.organisation,
            s.name            AS staff_name
     FROM orders o
     JOIN   clients c ON o.client_id         = c.id
     LEFT JOIN staff s ON o.assigned_staff_id = s.id
     WHERE o.id = $1`,
    [id]
  );
  if (!rows.length) throw new HttpError(404, 'Order not found');

  const { rows: payments } = await query(
    'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC',
    [id]
  );

  return { order: rows[0], payments };
}

// ── Create an order from scratch (dashboard use) ──────────────────────────────
export async function createOrder({ clientId, clientType, quotationId, poNumber, assignedStaffId } = {}) {
  const reference = await nextOrderRef();

  const { rows } = await query(
    `INSERT INTO orders
       (reference, client_id, client_type, quotation_id, po_number, assigned_staff_id, stage)
     VALUES ($1,$2,$3,$4,$5,$6,'quotation_requested')
     RETURNING *`,
    [reference, clientId, clientType || 'retail', quotationId || null, poNumber || null, assignedStaffId || null]
  );
  return rows[0];
}

// ── Convert an accepted quotation into an order ───────────────────────────────
export async function convertFromQuotation(quotationId, staffId, { poNumber, assignedStaffId } = {}) {
  const { rows: qRows } = await query('SELECT * FROM quotations WHERE id = $1', [quotationId]);
  if (!qRows.length) throw new HttpError(404, 'Quotation not found');
  const quotation = qRows[0];

  if (quotation.status !== 'accepted') {
    throw new HttpError(400, 'Only accepted quotations can be converted to orders');
  }

  const { rows: existing } = await query(
    'SELECT id FROM orders WHERE quotation_id = $1 LIMIT 1',
    [quotationId]
  );
  if (existing.length) throw new HttpError(409, 'An order already exists for this quotation');

  const reference = await nextOrderRef();

  // Derive 50% deposit by default (consultant can adjust on the order detail page)
  const total        = Number(quotation.total);
  const depositAmt   = parseFloat((total * 0.5).toFixed(2));
  const balanceAmt   = parseFloat((total - depositAmt).toFixed(2));

  const { rows } = await query(
    `INSERT INTO orders
       (reference, client_id, client_type, quotation_id, po_number,
        assigned_staff_id, stage, payment_status, deposit_amount, balance_amount)
     VALUES ($1,$2,$3,$4,$5,$6,'quotation_requested','unpaid',$7,$8)
     RETURNING *`,
    [
      reference,
      quotation.client_id,
      'corporate',
      quotationId,
      poNumber || null,
      assignedStaffId || staffId || null,
      depositAmt,
      balanceAmt,
    ]
  );
  const order = rows[0];

  // Notify client
  const { rows: clientRows } = await query('SELECT * FROM clients WHERE id = $1', [order.client_id]);
  const client = clientRows[0];
  if (client?.whatsapp_number) {
    await sendTextMessage(
      client.whatsapp_number,
      TEMPLATES.STAGE_1_QUOTATION_REQUESTED({ reference: order.reference })
    ).catch((err) => logger.warn('Failed to notify client on order creation', { error: err.message }));
  }

  return order;
}

// ── Advance an order stage ─────────────────────────────────────────────────────
export async function advanceOrderStage(orderId, staffId, { notes, estimatedCompletion, trackingNumber, deliveryType } = {}) {
  const { rows } = await query(
    `SELECT o.*, c.whatsapp_number, c.name AS client_name
     FROM orders o JOIN clients c ON o.client_id = c.id
     WHERE o.id = $1`,
    [orderId]
  );
  if (!rows.length) throw new HttpError(404, 'Order not found');

  const order = rows[0];
  if (order.is_on_hold) throw new HttpError(400, 'Cannot advance a held order. Remove hold first.');

  const to = nextStage(order.stage);
  if (!to) throw new HttpError(400, 'Order is already at the final stage');

  const setFields = ['stage = $1', 'updated_at = NOW()'];
  const params = [to];

  if (estimatedCompletion) { params.push(estimatedCompletion); setFields.push(`estimated_completion_date = $${params.length}`); }
  if (trackingNumber)      { params.push(trackingNumber);      setFields.push(`tracking_number = $${params.length}`); }

  params.push(orderId);
  const { rows: updated } = await query(
    `UPDATE orders SET ${setFields.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  const updatedOrder = updated[0];

  if (order.whatsapp_number) {
    const templateKey = to === 'completed' && deliveryType === 'delivery'
      ? 'STAGE_10_COMPLETED_DELIVERY'
      : templateForStage(to);

    if (templateKey && TEMPLATES[templateKey]) {
      const msg = TEMPLATES[templateKey]({
        reference: order.reference,
        estimatedCompletion: estimatedCompletion
          ? new Date(estimatedCompletion).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })
          : order.estimated_completion_date,
        trackingNumber,
      });
      await sendTextMessage(order.whatsapp_number, msg)
        .catch((err) => logger.warn('Stage advance WhatsApp notify failed', { error: err.message }));
    }
  }

  return { order: updatedOrder, from: order.stage, to };
}

// ── Toggle hold / release hold ────────────────────────────────────────────────
export async function setOrderHold(orderId, { isOnHold, holdReason }) {
  const { rows } = await query(
    `UPDATE orders
     SET is_on_hold = $1, hold_reason = $2, updated_at = NOW()
     WHERE id = $3
     RETURNING *,
       (SELECT whatsapp_number FROM clients WHERE id = client_id) AS whatsapp_number`,
    [isOnHold, isOnHold ? (holdReason || null) : null, orderId]
  );
  if (!rows.length) throw new HttpError(404, 'Order not found');

  const order = rows[0];

  // Auto-send supplier delay notification when that reason is selected
  if (isOnHold && holdReason === 'supplier_delay' && order.whatsapp_number) {
    await sendTextMessage(
      order.whatsapp_number,
      TEMPLATES.SUPPLIER_DELAY({ reference: order.reference })
    ).catch((err) => logger.warn('Supplier delay WhatsApp notify failed', { error: err.message }));
  }

  return order;
}

// ── Assign a consultant to an order ──────────────────────────────────────────
export async function assignOrder(orderId, staffId) {
  const { rows } = await query(
    'UPDATE orders SET assigned_staff_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [staffId, orderId]
  );
  if (!rows.length) throw new HttpError(404, 'Order not found');
  return rows[0];
}

// ── Record a payment against an order ────────────────────────────────────────
export async function recordPayment(orderId, { type, amount, currency, notes }) {
  const { rows: orderRows } = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!orderRows.length) throw new HttpError(404, 'Order not found');

  const { rows } = await query(
    `INSERT INTO payments (order_id, type, amount, currency, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [orderId, type, amount, currency || 'ZAR', notes || null]
  );

  // Update payment status based on type
  const newStatus = type === 'full' ? 'paid_in_full'
    : type === 'deposit' ? 'deposit_paid'
    : 'deposit_paid';

  await query(
    'UPDATE orders SET payment_status = $1, updated_at = NOW() WHERE id = $2',
    [newStatus, orderId]
  );

  return rows[0];
}

// ── List payments for an order ────────────────────────────────────────────────
export async function listPayments(orderId) {
  const { rows } = await query(
    'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC',
    [orderId]
  );
  return rows;
}

// ── Stage label helper (for dashboard/tracking) ───────────────────────────────
export function getStageInfo(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  return {
    index:   idx,
    total:   STAGE_ORDER.length,
    percent: idx >= 0 ? Math.round(((idx + 1) / STAGE_ORDER.length) * 100) : null,
    label:   STAGE_ORDER.indexOf(stage) >= 0 ? stage : 'unknown',
    isFirst: idx === 0,
    isLast:  idx === STAGE_ORDER.length - 1,
  };
}

// ── Dashboard KPI helper ──────────────────────────────────────────────────────
export async function getDashboardKpis() {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*) FROM conversations WHERE is_open = true AND assigned_staff_id IS NULL)
        AS new_enquiries,
      (SELECT COUNT(*) FROM quotations    WHERE status = 'draft')
        AS quotations_awaiting_pricing,
      (SELECT COUNT(*) FROM orders        WHERE stage != 'completed' AND is_on_hold = false)
        AS active_orders,
      (SELECT COUNT(*) FROM tickets       WHERE status IN ('open','in_progress'))
        AS open_tickets,
      (SELECT COUNT(*) FROM orders        WHERE is_on_hold = true)
        AS on_hold_orders
  `);

  const kpis = rows[0];

  // Needs-attention feed: draft quotations + open tickets, with claim ownership
  const { rows: attention } = await query(`
    SELECT 'quotation' AS type, q.id, q.reference, q.created_at,
           q.sla_remind_at AS deadline,
           (q.sla_remind_at <= NOW()) AS is_overdue,
           q.assigned_staff_id,
           s.name  AS assigned_name,
           c.name  AS client_name
    FROM quotations q
    LEFT JOIN staff   s ON s.id = q.assigned_staff_id
    LEFT JOIN clients c ON c.id = q.client_id
    WHERE q.status = 'draft' AND q.reminder_sent_at IS NULL
    UNION ALL
    SELECT 'ticket' AS type, t.id, t.id::text AS reference, t.created_at,
           t.sla_due_at AS deadline,
           (t.sla_due_at < NOW() AND t.status IN ('open','in_progress')) AS is_overdue,
           t.assigned_staff_id,
           s.name  AS assigned_name,
           c.name  AS client_name
    FROM tickets t
    LEFT JOIN staff   s ON s.id = t.assigned_staff_id
    LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.status IN ('open','in_progress')
    ORDER BY is_overdue DESC, deadline ASC
    LIMIT 20
  `);

  return { kpis, attention };
}

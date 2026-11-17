import { query, withTransaction } from '../../core/db.js';
import { TEMPLATES, templateForStage } from '../bot/templates.js';
import { HttpError, pageParams } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import {
  ORDER_STAGES, toCanonicalStage, nextStage, proofTransition, HUMAN_STATES, OPEN_TICKET_STATUSES, CLIENT_STAGE_LABELS,
} from '../lifecycle/machines.js';
import { evaluateAdvance, advanceGuards, blockersOf } from '../lifecycle/guards.js';
import { jobStateSql, depositSatisfiedSql, paidInFullSql, proofBlockingSql } from '../lifecycle/sql.js';
import { createAcceptedQuotation } from '../quotations/service.js';
import { convertQuotationToOrder, parseLineItems } from './convert.js';
import { queueWhatsAppText, TEMPLATE_FALLBACKS } from '../notifications/whatsapp.js';
import { recordJobEvent } from '../jobs/events.js';
import { recordPaymentTx, findPaymentByKey, lockOrderForPayment } from '../payments/service.js';
import { toCentsOrNull, formatRand } from '../../core/money.js';

export { toCanonicalStage };

// ── Date formatting for client-facing messages ───────────────────────────────
const DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * Format a calendar date as e.g. "1 Nov 2026".
 * Accepts 'YYYY-MM-DD' strings (taken literally), JS Dates produced by pg for
 * DATE columns (local midnight → local calendar day), or anything Date-parseable
 * (formatted in Africa/Johannesburg). Returns null for empty/invalid input.
 */
export function formatDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?$)/.exec(value);
    if (m) return DATE_FMT.format(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return DATE_FMT.format(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Johannesburg',
  }).format(d);
}

/** Accept a staff row/object or a bare staff id. */
const asActor = (actor) => (actor && typeof actor === 'object' ? actor : actor ? { id: actor } : null);

const OPEN_TICKETS_SQL = `(SELECT COUNT(*)::int FROM tickets t WHERE t.order_id = o.id AND t.status IN (${OPEN_TICKET_STATUSES.map((s) => `'${s}'`).join(', ')}))`;

// ── Pre-checks used by the controller for friendly 400/404s ──────────────────
export async function assertOrderExists(id) {
  const { rows } = await query('SELECT id FROM orders WHERE id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'Order not found');
  return rows[0];
}

export async function assertAssignableStaff(staffId) {
  const { rows } = await query('SELECT id, is_active FROM staff WHERE id = $1', [staffId]);
  if (!rows.length) throw new HttpError(400, 'Staff member not found');
  if (rows[0].is_active === false) throw new HttpError(400, 'Staff member is inactive');
  return rows[0];
}

/** Validate the foreign keys of a new order; returns the client row. */
export async function validateOrderRefs({ clientId, assignedStaffId, quotationId } = {}) {
  const { rows: clients } = await query('SELECT id, client_type FROM clients WHERE id = $1', [clientId]);
  if (!clients.length) throw new HttpError(400, 'Client not found');
  if (assignedStaffId) await assertAssignableStaff(assignedStaffId);
  if (quotationId) {
    const { rows: quotes } = await query('SELECT id, client_id FROM quotations WHERE id = $1', [quotationId]);
    if (!quotes.length) throw new HttpError(400, 'Quotation not found');
    if (quotes[0].client_id !== clientId) throw new HttpError(400, 'Quotation belongs to a different client');
  }
  return clients[0];
}

/** Keep OFFSET a safe integer for absurd page numbers (they just return no rows). */
function safePage({ page, limit }) {
  const p = Math.min(page, Math.floor(Number.MAX_SAFE_INTEGER / limit));
  return { page: p, limit, offset: (p - 1) * limit };
}

// ── List orders ───────────────────────────────────────────────────────────────
// Filters are expected to be pre-validated by the controller (enum / uuid).
// Returns { items, total, page, limit }; each row carries lifecycle_state.
export async function listOrders({ stage, clientType, staffId, onHold, active, ...rest } = {}) {
  const { page, limit, offset } = safePage(pageParams(rest, { defaultLimit: 20, maxLimit: 200 }));
  const where = ['1=1'];
  const params = [];

  if (Array.isArray(stage)) {
    const stages = stage.filter((s) => typeof s === 'string');
    if (stages.length) { params.push(stages); where.push(`o.stage = ANY($${params.length}::text[])`); }
  } else if (stage) { params.push(String(stage)); where.push(`o.stage = $${params.length}`); }
  if (clientType){ params.push(clientType); where.push(`o.client_type = $${params.length}`); }
  if (staffId)   { params.push(staffId);   where.push(`o.assigned_staff_id = $${params.length}`); }
  if (onHold  === 'true') where.push('o.is_on_hold = true');
  if (active  === 'true') where.push(`o.stage != 'completed'`);

  const filterParams = [...params];
  params.push(limit); params.push(offset);

  const { rows } = await query(
    `SELECT o.*,
            c.name            AS client_name,
            c.whatsapp_number,
            c.organisation,
            s.name            AS staff_name,
            q.reference       AS quotation_reference,
            c.account_terms,
            ${jobStateSql({ openTickets: OPEN_TICKETS_SQL, accountTerms: 'c.account_terms' })} AS lifecycle_state
     FROM orders o
     JOIN   clients c ON o.client_id         = c.id
     LEFT JOIN staff s ON o.assigned_staff_id = s.id
     LEFT JOIN quotations q ON q.id = o.quotation_id
     WHERE ${where.join(' AND ')}
     ORDER BY o.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total
     FROM orders o
     JOIN clients c ON o.client_id = c.id
     WHERE ${where.join(' AND ')}`,
    filterParams
  );

  return { items: rows, total: Number(countRows[0]?.total ?? 0), page, limit };
}

// ── Get a single order ────────────────────────────────────────────────────────
export async function getOrderById(id) {
  const { rows } = await query(
    `SELECT o.*,
            c.name            AS client_name,
            c.whatsapp_number,
            c.organisation,
            c.account_terms,
            s.name            AS staff_name,
            q.line_items      AS quotation_line_items,
            q.reference       AS quotation_reference,
            q.total           AS quotation_total
     FROM orders o
     JOIN   clients c ON o.client_id         = c.id
     LEFT JOIN staff   s ON o.assigned_staff_id = s.id
     LEFT JOIN quotations q ON q.id = o.quotation_id
     WHERE o.id = $1`,
    [id]
  );
  if (!rows.length) throw new HttpError(404, 'Order not found');

  const { rows: payments } = await query(
    'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC',
    [id]
  );

  const { rows: history } = await query(
    `SELECT h.*, s.name AS changed_by_name
     FROM order_stage_history h
     LEFT JOIN staff s ON s.id = h.changed_by
     WHERE h.order_id = $1
     ORDER BY h.created_at ASC`,
    [id]
  );

  return { order: rows[0], payments, history };
}

// ── Create an order (dashboard) — always through a quotation ─────────────────
/**
 * quotationId → convert that (accepted) quotation; lineItems → create an
 * accepted quotation with those items, then convert it. clientType defaults to
 * the client's own type.
 * @param {{ clientId, clientType?, quotationId?, lineItems?, poNumber?, assignedStaffId?, conversationId? }} data
 * @param {object|string|null} actor staff row (or id)
 */
export async function createOrder({ clientId, clientType, quotationId, lineItems, poNumber, assignedStaffId, conversationId } = {}, actor = null) {
  const who = asActor(actor);
  if (!quotationId && !(Array.isArray(lineItems) && lineItems.length)) {
    throw new HttpError(400, 'Provide quotationId (an accepted quotation) or lineItems', { code: 'QUOTE_OR_ITEMS_REQUIRED' });
  }
  return withTransaction(async (tx) => {
    let qid = quotationId;
    if (!qid) {
      const q = await createAcceptedQuotation(tx, {
        clientId, lineItems, conversationId, actorId: who?.id ?? null, source: 'dashboard',
      });
      qid = q.id;
    }
    const order = await convertQuotationToOrder(tx, {
      quotationId: qid, actor: who, source: 'dashboard', poNumber, assignedStaffId, conversationId, clientType,
    });
    await logPurchaseOrder(tx, order, who);
    return order;
  });
}

/**
 * A PO number given when the order is created is the order's purchase order:
 * kept in the purchase-order log (valid, linked to the order) and the job history.
 */
async function logPurchaseOrder(tx, order, actor) {
  if (!order.po_number) return;
  await tx.query(
    `INSERT INTO purchase_orders (quotation_id, po_number, status, order_id, validated_by, notes)
     VALUES ($1, $2, 'valid', $3, $4, 'Recorded when the order was created')`,
    [order.quotation_id, order.po_number, order.id, actor?.id ?? null]
  );
  await recordJobEvent(tx, {
    quotationId: order.quotation_id, orderId: order.id, type: 'po.recorded', actorId: actor?.id ?? null, data: { poNumber: order.po_number },
  });
}

// ── Convert an accepted quotation into an order (staff) ───────────────────────
/**
 * accept: true — "Client accepted — create order": a sent quotation is marked
 * accepted (lifecycle rule: within validity) and converted in one transaction.
 * The owner defaults to the staff member creating the order.
 */
export async function convertFromQuotation(quotationId, actor, { poNumber, assignedStaffId, conversationId, accept = false } = {}) {
  const who = asActor(actor);
  return withTransaction(async (tx) => {
    const order = await convertQuotationToOrder(tx, {
      quotationId, actor: who, source: accept ? 'staff_accept' : 'staff', poNumber, assignedStaffId, conversationId,
    });
    await logPurchaseOrder(tx, order, who);
    return order;
  });
}

// ── Orders placed on WhatsApp (bot) ──────────────────────────────────────────
// The bot's own "Order placed" reply carries the deposit amount, so the deposit
// message is not queued again (notifyClient: false).

/** Client confirms an order from one of their quotations (accepts a sent quote inline). */
export async function placeOrderFromQuotation(clientId, quotationId, { conversationId = null } = {}) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query('SELECT client_id FROM quotations WHERE id = $1', [quotationId]);
    if (!rows.length || rows[0].client_id !== clientId) throw new HttpError(404, 'Quotation not found');
    return convertQuotationToOrder(tx, { quotationId, source: 'bot_accept', conversationId, notifyClient: false });
  });
}

/**
 * Direct catalog order — the client confirmed a WhatsApp order: an accepted (auto)
 * quotation with the line items, then the order, one transaction.
 *  - sourceEventId: a replay of the same bot turn returns the order it already
 *    created (keyed through the quotation's source_event_id, DAT-2).
 *  - The conversation's pendingOrderItems are consumed in the same transaction, so
 *    if the turn then fails, a second "yes" cannot place the order again.
 */
export async function placeDirectOrder(clientId, lineItems, { conversationId = null, sourceEventId = null } = {}) {
  return withTransaction(async (tx) => {
    const earlier = await orderForEvent(sourceEventId, tx);
    if (earlier) return earlier;
    if (conversationId) {
      await tx.query(`UPDATE conversations SET context = context - 'pendingOrderItems' WHERE id = $1`, [conversationId]);
    }
    const quotation = await createAcceptedQuotation(tx, {
      clientId, lineItems, conversationId, autoQuoted: true, source: 'bot_order', notes: 'Direct WhatsApp order', sourceEventId,
    });
    return convertQuotationToOrder(tx, { quotationId: quotation.id, source: 'bot_order', conversationId, notifyClient: false });
  });
}

/** The order a bot turn for this inbound event already placed (through its quotation), or null. */
export async function orderForEvent(sourceEventId, db = { query }) {
  if (sourceEventId == null) return null;
  const { rows } = await db.query(
    `SELECT o.* FROM orders o JOIN quotations q ON q.id = o.quotation_id WHERE q.source_event_id = $1`,
    [sourceEventId]
  );
  return rows[0] || null;
}

// ── Advance an order stage (guards + overrides) ───────────────────────────────
const STAGE_FIELDS_SQL = `o.*, c.whatsapp_number, c.name AS client_name, c.account_terms, q.line_items AS quotation_line_items, q.total AS quotation_total`;

/**
 * Move the order to its next stage (one transaction).
 *  - HOLD blocks (409, not overridable); PROOF_PENDING / DEPOSIT_REQUIRED block
 *    → in_production (DEPOSIT_REQUIRED never for account clients) and
 *    BALANCE_DUE blocks → completed (409, overridable). The 409 carries every
 *    blocking guard: guards (codes) and blockers ([{ code, message, overridable }]).
 *  - override: { reason } needs 'order.override' (403) and a reason ≥ 5 chars (400);
 *    the overridden guards and reason are written to order_stage_history.
 *  - payment: { amount, type?, notes? } is recorded first, in the same
 *    transaction (e.g. the balance taken when the client collects); if the
 *    advance is then refused, the payment is rolled back too.
 *  - The write is one conditional UPDATE (stage still as read, guards still
 *    hold) so concurrent requests cannot double-apply a transition.
 * @returns {{ order, from, to, overridden: string[], payment?: object }}
 */
export async function advanceOrderStage(orderId, actor, opts = {}) {
  const result = await withTransaction((tx) => advanceOrderStageTx(tx, orderId, actor, opts));
  if (result.overridden.length) {
    logger.warn('Order stage guard overridden', { orderId, to: result.to, guards: result.overridden, by: asActor(actor)?.id });
  }
  return result;
}

/**
 * advanceOrderStage on the caller's transaction.
 * @param {{ expect?: string }} opts  expect: the stage the caller means to reach (409 STALE otherwise)
 */
export async function advanceOrderStageTx(tx, orderId, actor, {
  notes, estimatedCompletion, trackingNumber, deliveryType, override, payment, expect,
} = {}) {
  const staff = asActor(actor);
  let recorded = null;
  if (payment) {
    ({ payment: recorded } = await recordPaymentTx(tx, orderId, {
      type: payment.type || 'balance', amount: payment.amount, currency: payment.currency, notes: payment.notes,
      idempotencyKey: payment.idempotencyKey ?? null, recordedBy: staff?.id ?? null,
    }));
  }

  const { rows } = await tx.query(
    `SELECT ${STAGE_FIELDS_SQL}
     FROM orders o
     JOIN clients c ON o.client_id = c.id
     LEFT JOIN quotations q ON q.id = o.quotation_id
     WHERE o.id = $1`,
    [orderId]
  );
  // Not locked on purpose: the conditional UPDATE below (stage still as read,
  // guards still hold) is what makes a double click or a concurrent change lose
  // with 409 instead of advancing twice.
  if (!rows.length) throw new HttpError(404, 'Order not found');
  const order = rows[0];

  const current = toCanonicalStage(order.stage);
  if (!current) throw new HttpError(400, `Order has an unrecognised stage "${order.stage}" and cannot be advanced`);
  const to = nextStage(current);
  if (!to) throw new HttpError(400, 'Order is already at the final stage');
  if (expect && to !== expect) {
    throw new HttpError(409, 'Order changed while you were working on it — refresh and try again', { code: 'STALE' });
  }

  const verdict = evaluateAdvance(order, to, { override, staff });
  if (!verdict.ok) {
    const { error, ...extra } = verdict.body;
    let message = error;
    if (recorded && verdict.status === 409) {
      const outstanding = await outstandingAfter(tx, order);
      if (extra.code === 'BALANCE_DUE' && outstanding > 0) {
        message = `${formatRand(outstanding)} would still be owed after this payment — record the full balance, or skip the check (manager). Nothing was saved.`;
      } else if (extra.code === 'DEPOSIT_REQUIRED') {
        message = `${error}. The amount entered does not cover the deposit, so nothing was saved.`;
      } else {
        message = `${error}. Nothing was saved.`;
      }
    }
    throw new HttpError(verdict.status, message, extra);
  }
  const overridden = verdict.overridden;

  const setFields = ['stage = $1', 'updated_at = NOW()'];
  const params = [to];
  if (estimatedCompletion) { params.push(estimatedCompletion); setFields.push(`estimated_completion_date = $${params.length}`); }
  if (trackingNumber)      { params.push(trackingNumber);      setFields.push(`tracking_number = $${params.length}`); }
  if (to === 'ready' && deliveryType) { params.push(deliveryType); setFields.push(`delivery_type = $${params.length}`); }
  params.push(orderId);
  const idParam = params.length;
  params.push(order.stage);
  const stageParam = params.length;

  // Guards re-checked in the UPDATE unless overridden (HOLD never is).
  const guardSql = ['o.is_on_hold = false'];
  if (to === 'in_production') {
    if (!overridden.includes('PROOF_PENDING')) guardSql.push(`NOT ${proofBlockingSql('o')}`);
    if (!overridden.includes('DEPOSIT_REQUIRED')) guardSql.push(depositSatisfiedSql('o'));
  }
  if (to === 'completed' && !overridden.includes('BALANCE_DUE')) guardSql.push(paidInFullSql('o'));

  const { rows: updated } = await tx.query(
    `UPDATE orders o SET ${setFields.join(', ')}
     WHERE o.id = $${idParam} AND o.stage = $${stageParam} AND ${guardSql.join(' AND ')}
     RETURNING o.*`,
    params
  );
  if (!updated.length) {
    // Lost a race: the stage moved on, or a guard started failing meanwhile.
    const { rows: now } = await tx.query(
      'SELECT o.*, c.account_terms FROM orders o JOIN clients c ON c.id = o.client_id WHERE o.id = $1', [orderId]);
    const failing = now.length && now[0].stage === order.stage
      ? advanceGuards(now[0], to).filter((g) => !overridden.includes(g.code))
      : [];
    throw new HttpError(409, 'Order changed while you were working on it — refresh and try again', {
      code: failing[0]?.code ?? 'STALE',
      ...(failing.length ? { guards: failing.map((g) => g.code), blockers: blockersOf(failing) } : {}),
    });
  }

  const { rows: [h] } = await tx.query(
    `INSERT INTO order_stage_history (order_id, stage, from_stage, changed_by, notes, override_reason, overridden_guards)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [orderId, to, order.stage, staff?.id ?? null, notes || null,
      overridden.length ? verdict.reason : null, overridden.length ? overridden : null]
  );

  if (order.whatsapp_number) {
    // Delivery type changes the template for the 'ready' stage
    const templateKey = to === 'ready' && deliveryType === 'delivery' ? 'STAGE_READY_DELIVERY' : templateForStage(to);
    if (templateKey && TEMPLATES[templateKey]) {
      const balance = to === 'ready' ? (await outstandingAfter(tx, order)) / 100 : undefined;
      const due = formatDate(estimatedCompletion || order.estimated_completion_date);
      const body = TEMPLATES[templateKey]({
        reference:           order.reference,
        items:               parseLineItems(order.quotation_line_items),
        estimatedCompletion: due,
        trackingNumber,
        deposit:             Number(order.deposit_amount ?? 0),
        balance,
        account:             order.account_terms === true,
      });
      // Outside WhatsApp's 24-hour window: the approved order-update template.
      const extra = to === 'in_production' && due ? `Estimated completion: ${due}.`
        : to === 'ready' && trackingNumber ? `Tracking number: ${trackingNumber}.`
          : to === 'ready' && balance > 0 ? `Balance due: R ${balance.toFixed(2)}.`
            : to === 'completed' ? 'Thank you for choosing Braq Uni!' : '';
      await queueWhatsAppText(tx, {
        to: order.whatsapp_number, body, clientId: order.client_id, conversationId: order.conversation_id,
        templateFallback: TEMPLATE_FALLBACKS.orderStage({
          client: { name: order.client_name }, reference: order.reference, status: CLIENT_STAGE_LABELS[to] ?? to, extra,
        }),
      }, { dedupeKey: `order:${orderId}:stage:${h.id}` });
    }
  }
  return { order: updated[0], from: order.stage, to, overridden, ...(recorded ? { payment: recorded } : {}) };
}

/** What is still owed on the order (cents), after every payment recorded so far on `tx`. */
async function outstandingAfter(tx, order) {
  const { rows } = await tx.query('SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE order_id = $1', [order.id]);
  const paid = toCentsOrNull(rows[0].paid) ?? 0;
  const total = toCentsOrNull(order.total_amount) ?? toCentsOrNull(order.quotation_total);
  return total == null ? 0 : Math.max(0, total - paid);
}

/**
 * Record a payment and, when asked, start production in the same transaction
 * ("Record deposit" with "Start production now"). A refused start rolls the
 * payment back. → { payment, advanced?: { order, from, to } }
 */
export async function recordPaymentAndAdvance(orderId, actor, { type, amount, currency, notes, startProduction = null, idempotencyKey = null }) {
  const recordedBy = asActor(actor)?.id ?? null;
  return withTransaction(async (tx) => {
    // A replayed submission (same key) returns the first payment and does not
    // advance again — the first request already did both, atomically.
    if (idempotencyKey) {
      await lockOrderForPayment(tx, orderId);
      const existing = await findPaymentByKey(tx, orderId, idempotencyKey);
      if (existing) {
        if (existing.type !== type || Math.round(Number(existing.amount) * 100) !== Math.round(Number(amount) * 100)) {
          throw new HttpError(409, 'This payment form was already submitted with different details — refresh and record it again',
            { code: 'IDEMPOTENCY_MISMATCH' });
        }
        return { payment: existing, replayed: true };
      }
    }
    if (!startProduction) {
      const { payment } = await recordPaymentTx(tx, orderId, { type, amount, currency, notes, idempotencyKey, recordedBy });
      return { payment };
    }
    const advanced = await advanceOrderStageTx(tx, orderId, actor, {
      payment: { type, amount, currency, notes, idempotencyKey },
      estimatedCompletion: startProduction.estimatedCompletion,
      notes: startProduction.notes,
      expect: 'in_production',
    });
    const { payment, ...rest } = advanced;
    return { payment, advanced: rest };
  });
}

// ── Toggle hold / release hold ────────────────────────────────────────────────
// The supplier-delay notice is only sent when the order newly enters a
// supplier_delay hold (repeat calls with the same state do not re-notify).
export async function setOrderHold(orderId, { isOnHold, holdReason }) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE orders o
       SET is_on_hold = $1, hold_reason = $2, updated_at = NOW()
       FROM (SELECT id, is_on_hold AS prev_is_on_hold, hold_reason AS prev_hold_reason
             FROM orders WHERE id = $3 FOR UPDATE) prev
       WHERE o.id = prev.id
       RETURNING o.*, prev.prev_is_on_hold, prev.prev_hold_reason,
         (SELECT whatsapp_number FROM clients WHERE id = o.client_id) AS whatsapp_number,
         (SELECT name FROM clients WHERE id = o.client_id) AS client_name`,
      [isOnHold, isOnHold ? (holdReason || null) : null, orderId]
    );
    if (!rows.length) throw new HttpError(404, 'Order not found');

    const { prev_is_on_hold: prevOnHold, prev_hold_reason: prevReason, client_name: clientName, ...order } = rows[0];
    const alreadyDelayed = prevOnHold === true && prevReason === 'supplier_delay';

    // Supplier delay notification when that reason is newly selected
    if (isOnHold && holdReason === 'supplier_delay' && !alreadyDelayed && order.whatsapp_number) {
      await queueWhatsAppText(tx, {
        to: order.whatsapp_number,
        body: TEMPLATES.SUPPLIER_DELAY({ reference: order.reference }),
        clientId: order.client_id,
        conversationId: order.conversation_id,
        templateFallback: TEMPLATE_FALLBACKS.orderDelay({ client: { name: clientName }, reference: order.reference }),
      }, { dedupeKey: `order:${orderId}:delay:${new Date(order.updated_at).getTime()}` });
    }
    return order;
  });
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

// ── Update material / stock notes ────────────────────────────────────────────
export async function updateMaterialNotes(orderId, notes) {
  const { rows } = await query(
    `UPDATE orders SET material_notes = $1::jsonb, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [JSON.stringify(notes), orderId]
  );
  if (!rows.length) throw new HttpError(404, 'Order not found');
  return rows[0];
}

// ── Digital proofs (lifecycle proof machine) ──────────────────────────────────
async function lockOrderForProof(tx, orderId) {
  const { rows } = await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!rows.length) throw new HttpError(404, 'Order not found');
  return rows[0];
}

function assertProofTransition(order, to) {
  const verdict = proofTransition(order.proof_status, to, { stage: order.stage });
  if (!verdict.ok) throw new HttpError(verdict.code === 'INVALID_STATUS' ? 400 : 409, verdict.message, { code: verdict.code });
}

/**
 * Store the proof, queue it to the client on WhatsApp and move the client's
 * conversation into proof_review so their "approve"/"revise" reply is handled.
 * A conversation where a consultant is (or is about to be) talking to the client
 * is left alone — the consultant records the outcome via PATCH /proof/status.
 * If the client has no open conversation, one is opened in proof_review.
 */
export async function sendProofToClient(orderId, proofUrl, proofNotes, actor = null) {
  const staff = asActor(actor);
  return withTransaction(async (tx) => {
    const current = await lockOrderForProof(tx, orderId);
    assertProofTransition(current, 'sent');
    const { rows } = await tx.query(
      `UPDATE orders SET proof_url = $1, proof_status = 'sent', proof_notes = $2,
        proof_sent_at = NOW(), updated_at = NOW()
       WHERE id = $3
       RETURNING *,
         (SELECT whatsapp_number FROM clients WHERE id = client_id) AS whatsapp_number,
         (SELECT name FROM clients WHERE id = client_id) AS client_name,
         (SELECT id FROM conversations WHERE client_id = orders.client_id AND is_open = true ORDER BY created_at DESC LIMIT 1) AS open_conversation_id,
         (SELECT state FROM conversations WHERE client_id = orders.client_id AND is_open = true ORDER BY created_at DESC LIMIT 1) AS open_conversation_state`,
      [proofUrl, proofNotes || null, orderId]
    );
    const order = rows[0];
    // proofReturnState: where the bot takes the client back to once the proof is answered.
    const context = JSON.stringify({
      proofOrderId: orderId,
      ...(order.open_conversation_state && order.open_conversation_state !== 'proof_review' ? { proofReturnState: order.open_conversation_state } : {}),
    });

    // The conversation hand-over must never undo the proof itself.
    await tx.query('SAVEPOINT proof_convo');
    try {
      if (order.open_conversation_id) {
        await tx.query(
          `UPDATE conversations
           SET state = 'proof_review', context = context || $1::jsonb, last_message_at = NOW()
           WHERE id = $2 AND state NOT IN (${HUMAN_STATES.map((s) => `'${s}'`).join(', ')})`,
          [context, order.open_conversation_id]
        );
      } else if (order.client_id) {
        await tx.query(
          `INSERT INTO conversations (client_id, state, context) VALUES ($1, 'proof_review', $2::jsonb)`,
          [order.client_id, context]
        );
      }
      await tx.query('RELEASE SAVEPOINT proof_convo');
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT proof_convo');
      logger.warn('Failed to move conversation into proof review', { orderId, error: err.message });
    }

    await recordJobEvent(tx, { quotationId: order.quotation_id, orderId, type: 'proof.sent', actorId: staff?.id ?? null, data: { proofUrl } });
    if (order.whatsapp_number) {
      await queueWhatsAppText(tx, {
        to: order.whatsapp_number,
        body: TEMPLATES.PROOF_SENT({ reference: order.reference, proofUrl, notes: proofNotes || null }),
        clientId: order.client_id,
        conversationId: order.open_conversation_id || order.conversation_id,
        templateFallback: TEMPLATE_FALLBACKS.proofReady({ client: { name: order.client_name }, reference: order.reference, proofUrl }),
      }, { dedupeKey: `order:${orderId}:proof:${new Date(order.proof_sent_at).getTime()}` });
    }
    const { open_conversation_id: _ignored, open_conversation_state: _state, client_name: _name, ...out } = order;
    return out;
  });
}

/**
 * Record a proof outcome (approved / revision_requested / sent) through the proof machine.
 * startProduction: { estimatedCompletion?, notes? } with 'approved' also starts
 * production in the same transaction (refused → nothing is saved).
 */
export async function updateProofStatus(orderId, status, notes, actor = null, { startProduction = null } = {}) {
  const staff = asActor(actor);
  if (!['approved', 'revision_requested', 'sent'].includes(status)) throw new HttpError(400, `Invalid proof status: ${status}`);
  if (startProduction && status !== 'approved') throw new HttpError(400, 'Production can only be started when the design is approved');
  return withTransaction(async (tx) => {
    const current = await lockOrderForProof(tx, orderId);
    assertProofTransition(current, status);
    const { rows } = await tx.query(
      `UPDATE orders SET proof_status = $1, proof_notes = COALESCE($2, proof_notes), updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [status, notes || null, orderId]
    );
    await recordJobEvent(tx, {
      quotationId: current.quotation_id, orderId, type: `proof.${status}`, actorId: staff?.id ?? null,
      data: notes ? { notes } : {},
    });
    if (startProduction) {
      const advanced = await advanceOrderStageTx(tx, orderId, staff, {
        estimatedCompletion: startProduction.estimatedCompletion, notes: startProduction.notes, expect: 'in_production',
      });
      return advanced.order;
    }
    return rows[0];
  });
}

// ── Size run sheet data ───────────────────────────────────────────────────────
export async function getSizeRunSheetData(orderId) {
  const { order, payments } = await getOrderById(orderId);
  return { order, items: parseLineItems(order.quotation_line_items), payments };
}

// ── Stage label helper (for dashboard/tracking) ───────────────────────────────
// Legacy stage names are reported against the 4-stage pipeline they map to.
export function getStageInfo(stage) {
  const canonical = toCanonicalStage(stage);
  const idx = canonical ? ORDER_STAGES.indexOf(canonical) : -1;
  return {
    index:   idx,
    total:   ORDER_STAGES.length,
    percent: idx >= 0 ? Math.round(((idx + 1) / ORDER_STAGES.length) * 100) : null,
    label:   idx >= 0 ? canonical : 'unknown',
    isFirst: idx === 0,
    isLast:  idx === ORDER_STAGES.length - 1,
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

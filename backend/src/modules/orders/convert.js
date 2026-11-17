/**
 * The one order-creation path: every order is created from a quotation.
 *
 *   convertQuotationToOrder(tx, { quotationId, actor, source, poNumber,
 *                                 assignedStaffId, conversationId, clientType, notifyClient })
 *
 * Entry points: staff "Create order" (source 'staff'), "Client accepted — create order"
 * ('staff_accept': accepts the sent quote inline), dashboard POST /orders
 * ('dashboard'), purchase orders ('po'), the bot ordering from a quote
 * reference ('bot_accept') and the bot's direct catalog order ('bot_order',
 * after creating an accepted quotation with the line items).
 *
 * Runs on the caller's transaction: locks the quotation, accepts a 'sent' quote
 * inline for client-driven sources (same lifecycle rule as PATCH status),
 * refuses anything not accepted (400) or already converted (409), splits the
 * deposit in cents, inserts the order (+ its first stage-history row) and queues
 * the deposit WhatsApp (dedupe `order:<id>:deposit`).
 */
import { HttpError } from '../../core/errors.js';
import { queueWhatsAppText, TEMPLATE_FALLBACKS } from '../notifications/whatsapp.js';
import { CLIENT_STAGE_LABELS } from '../lifecycle/machines.js';
import { toCents, fromCents, splitDeposit } from '../../core/money.js';
import { quotationTransition } from '../lifecycle/machines.js';
import { PAST_VALIDITY_SQL } from '../lifecycle/sql.js';
import { TEMPLATES } from '../bot/templates.js';
import { updateQuotationStatus } from '../quotations/service.js';

/** Sources whose conversion is itself the client's acceptance of a sent quote. */
const ACCEPTING_SOURCES = new Set(['bot_accept', 'po', 'staff_accept']);

const SOURCE_NOTES = {
  staff:      'Order created from quotation',
  staff_accept: 'Client accepted the quote — order created',
  dashboard:  'Order created',
  po:         'Order created from purchase order',
  bot_accept: 'Order placed via WhatsApp (from quotation)',
  bot_order:  'Order placed via WhatsApp',
};

export function parseLineItems(raw) {
  try {
    if (!raw) return [];
    const items = Array.isArray(raw) ? raw : JSON.parse(raw);
    return Array.isArray(items) ? items : [];
  } catch { return []; }
}

// ── Global sequential order reference — BRQ-O-XXXXX (never resets) ───────────
// Must run on the transaction that also INSERTs the order, so a failed insert
// rolls the counter back instead of burning a reference number.
export async function nextOrderRef(tx) {
  const { rows } = await tx.query(
    `INSERT INTO sequence_counters (key, date_key, value)
     VALUES ('order', 'global', 1)
     ON CONFLICT (key, date_key) DO UPDATE SET value = sequence_counters.value + 1
     RETURNING value`
  );
  return `BRQ-O-${String(rows[0].value).padStart(5, '0')}`;
}

/**
 * @param {import('pg').PoolClient} tx
 * @param {{ quotationId: string, actor?: { id?: string }|null, source: string, poNumber?: string|null,
 *           assignedStaffId?: string|null, conversationId?: string|null, clientType?: string|null,
 *           notifyClient?: boolean }} opts
 * @returns {Promise<object>} the new orders row
 */
export async function convertQuotationToOrder(tx, {
  quotationId, actor = null, source = 'staff', poNumber = null, assignedStaffId = null,
  conversationId = null, clientType = null, notifyClient = true,
}) {
  const actorId = actor?.id ?? null;
  const { rows: qRows } = await tx.query(
    `SELECT q.*, ${PAST_VALIDITY_SQL} AS past_validity,
            c.client_type AS client_client_type, c.whatsapp_number AS client_wa, c.account_terms, c.name AS client_name
     FROM quotations q
     JOIN clients c ON c.id = q.client_id
     WHERE q.id = $1
     FOR UPDATE OF q`,
    [quotationId]
  );
  if (!qRows.length) throw new HttpError(404, 'Quotation not found');
  let quotation = qRows[0];

  const { rows: existing } = await tx.query('SELECT id FROM orders WHERE quotation_id = $1 LIMIT 1', [quotationId]);
  if (existing.length) throw new HttpError(409, 'An order already exists for this quotation', { code: 'ORDER_EXISTS' });

  if (quotation.status === 'sent' && ACCEPTING_SOURCES.has(source)) {
    const verdict = quotationTransition('sent', 'accepted', { pastValidity: quotation.past_validity });
    if (!verdict.ok) throw new HttpError(409, verdict.message, { code: verdict.code });
    const accepted = await updateQuotationStatus(quotationId, 'accepted', { actorId, tx, source });
    quotation = { ...quotation, ...accepted };
  }
  if (quotation.status !== 'accepted') {
    throw new HttpError(400, 'Only accepted quotations can be converted to orders', { code: 'QUOTE_NOT_ACCEPTED' });
  }

  // Deposit/balance split in integer cents so deposit + balance always equals the total.
  const totalCents = toCents(quotation.total || 0);
  const { depositCents, balanceCents } = splitDeposit(totalCents);
  const convoId = conversationId ?? quotation.conversation_id ?? null;
  const ownerId = assignedStaffId ?? actorId ?? quotation.assigned_staff_id ?? null;

  // A concurrent conversion loses on the unique index (orders.quotation_id) → 23505 → 409.
  const reference = await nextOrderRef(tx);
  const { rows } = await tx.query(
    `INSERT INTO orders
       (reference, client_id, client_type, quotation_id, po_number, assigned_staff_id, stage, payment_status,
        total_amount, deposit_amount, balance_amount, conversation_id)
     VALUES ($1, $2, COALESCE($3::client_type, $4::client_type, 'retail'), $5, $6, $7, 'deposit_pending', 'unpaid',
             $8, $9, $10, $11)
     RETURNING *`,
    [reference, quotation.client_id, clientType || null, quotation.client_client_type || null, quotationId,
      poNumber || null, ownerId, fromCents(totalCents), fromCents(depositCents), fromCents(balanceCents), convoId]
  );
  const order = rows[0];

  if (convoId && !quotation.conversation_id) {
    await tx.query('UPDATE quotations SET conversation_id = $1 WHERE id = $2 AND conversation_id IS NULL', [convoId, quotationId]);
  }
  await tx.query(
    `INSERT INTO order_stage_history (order_id, stage, from_stage, changed_by, notes)
     VALUES ($1, 'deposit_pending', NULL, $2, $3)`,
    [order.id, actorId ?? ownerId, SOURCE_NOTES[source] ?? 'Order created']
  );

  if (notifyClient && quotation.client_wa) {
    await queueWhatsAppText(tx, {
      to: quotation.client_wa,
      body: TEMPLATES.STAGE_DEPOSIT_PENDING({
        reference: order.reference,
        items: parseLineItems(quotation.line_items),
        deposit: fromCents(depositCents),
        account: quotation.account_terms === true,   // account clients: no deposit request
      }),
      clientId: quotation.client_id,
      conversationId: convoId,
      // Outside WhatsApp's 24-hour window the approved order-update template goes instead.
      templateFallback: TEMPLATE_FALLBACKS.orderStage({
        client: { name: quotation.client_name },
        reference: order.reference,
        status: quotation.account_terms === true ? 'Order received' : CLIENT_STAGE_LABELS.deposit_pending,
        extra: quotation.account_terms === true
          ? 'Your consultant will confirm the details and schedule production.'
          : `A consultant will contact you to arrange the deposit of R ${fromCents(depositCents).toFixed(2)}.`,
      }),
    }, { dedupeKey: `order:${order.id}:deposit` });
  }
  return order;
}

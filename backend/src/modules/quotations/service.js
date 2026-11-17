import { query, withTransaction } from '../../core/db.js';
import { listProducts } from '../catalog/service.js';
import { parseQuotationRequest, suggestLineItemPricing } from '../../integrations/ai.client.js';
import { HttpError, pageParams } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { enqueue } from '../../core/queue.js';
import { outboundQueueKey } from '../notifications/whatsapp.js';
import { renderQuotationPdf } from './pdf.js';
import {
  toCents, fromCents, calcTotals as calcTotalsCents, QUOTE_SLA_HOURS, QUOTE_VALIDITY_DAYS,
} from '../../core/money.js';
import { QUOTATION_STATUSES, QUOTATION_TRANSITIONS, quotationTransition, canClientAccept } from '../lifecycle/machines.js';
import {
  SA_TZ, SA_TODAY_SQL, PAST_VALIDITY_SQL, IS_EXPIRED_SQL, NEW_VALID_UNTIL_SQL, NO_ORDER_SQL, jobStateSql,
} from '../lifecycle/sql.js';
import { recordJobEvent } from '../jobs/events.js';

// Prices EXCLUDE VAT; VAT is added on top of the subtotal (rates live in core/money.js).
const SLA_HOURS     = QUOTE_SLA_HOURS;
export const VALIDITY_DAYS = QUOTE_VALIDITY_DAYS;

export { QUOTATION_STATUSES, PAST_VALIDITY_SQL, IS_EXPIRED_SQL };

/** Report a lapsed 'sent' quotation as 'expired' (row selected with IS_EXPIRED_SQL AS is_expired). */
function applyExpiry(row) {
  if (row && row.is_expired === true && row.status === 'sent') row.status = 'expired';
  return row;
}

/** YYYYMMDD on the South African calendar (not UTC). */
function saDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SA_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

// ── Daily-resetting quotation reference — BRQ-Q-YYYYMMDD-XXXX ────────────────
// With a transaction client the counter rolls back with a failed insert.
async function nextQuotationRef(tx = null) {
  const today = saDateKey();
  const run = async (c) => {
    const { rows } = await c.query(
      `INSERT INTO sequence_counters (key, date_key, value)
       VALUES ('quotation', $1, 1)
       ON CONFLICT (key, date_key) DO UPDATE SET value = sequence_counters.value + 1
       RETURNING value`,
      [today]
    );
    return `BRQ-Q-${today}-${String(rows[0].value).padStart(4, '0')}`;
  };
  return tx ? run(tx) : withTransaction(run);
}

// ── Money — all arithmetic in integer cents (core/money.js) ─────────────────
/**
 * Recompute effectiveUnitPrice (unitPrice + brandingSurcharge) and lineTotal
 * (quantity × effectiveUnitPrice) — a client-supplied lineTotal is never trusted
 * when the quantity and a price are known. Legacy lines that carry only a
 * lineTotal keep it, rounded to the cent.
 */
export function priceLineItem(item) {
  const qty  = Number(item.quantity);
  const base = item.unitPrice ?? item.price;
  let unitCents = null;
  if (base != null && base !== '') {
    unitCents = toCents(base) + toCents(item.brandingSurcharge ?? 0);
  } else if (item.effectiveUnitPrice != null && item.effectiveUnitPrice !== '') {
    unitCents = toCents(item.effectiveUnitPrice);
  }

  if (item.quantity != null && Number.isFinite(qty) && unitCents != null) {
    return { ...item, effectiveUnitPrice: fromCents(unitCents), lineTotal: fromCents(Math.round(qty * unitCents)) };
  }
  return { ...item, lineTotal: fromCents(toCents(item.lineTotal ?? 0)) };
}

/** subtotal = Σ lineTotal; vat = subtotal × 15% rounded half-up to the cent; total = subtotal + vat. */
export function calcTotals(lineItems) {
  const { subtotalCents, vatCents, totalCents } = calcTotalsCents(lineItems.map((i) => toCents(i.lineTotal ?? 0)));
  return {
    subtotal:  fromCents(subtotalCents),
    vatAmount: fromCents(vatCents),
    total:     fromCents(totalCents),
  };
}

// ── Build a quotation from a free-text request, grounded in the catalog ───────
export async function createFromFreeText(clientId, freeText, { conversationId = null } = {}) {
  const products    = await listProducts({ activeOnly: true });
  const parsed      = await parseQuotationRequest(freeText, { products });
  const productsById = new Map(products.map(p => [p.id, p]));

  const unmatchedDescriptions = [...(parsed.unmatchedText || [])];
  const lineItems = [];

  for (const item of parsed.items || []) {
    const product = productsById.get(item.productId);
    if (!product || !item.quantity || item.quantity <= 0) {
      unmatchedDescriptions.push(item.description || `${item.quantity ?? '?'} × unrecognised item`);
      continue;
    }
    const quantity  = item.quantity;
    const unitPrice = Number(product.price);
    const sizes     = Array.isArray(item.sizes) && item.sizes.length > 0
      ? item.sizes
      : [{ size: 'TBC', qty: quantity }];
    lineItems.push(priceLineItem({
      productId:          product.id,
      name:               product.name,
      category:           product.category,
      colour:             item.colour || '',
      sizes,
      quantity,
      unitPrice,
      brandingSurcharge:  0,
      effectiveUnitPrice: unitPrice,
      branding:           { type: 'none', position: '', detail: '' },
      lineTotal:          0,
      priceConfirmed:     true,
    }));
  }

  // If any items are unmatched, ask AI to suggest prices so the consultant
  // has a head-start rather than pricing from scratch.
  let suggestedItems = [];
  if (unmatchedDescriptions.length > 0) {
    try {
      const suggestion = await suggestLineItemPricing(unmatchedDescriptions, {
        products,
        originalRequest: freeText,
      });
      suggestedItems = (suggestion.items || []).map((s) => {
        const unitPrice = Number(s.unitPrice);
        return priceLineItem({
          productId:          null,
          name:               s.description,
          category:           'custom',
          colour:             '',
          sizes:              [],
          quantity:           s.quantity,
          unitPrice,
          brandingSurcharge:  0,
          effectiveUnitPrice: unitPrice,
          branding:           { type: 'none', position: '', detail: '' },
          lineTotal:          0,
          aiNote:             `AI: R${unitPrice}/unit (${s.confidence}) — ${s.notes}`,
          priceConfirmed:     false,
        });
      });
    } catch (err) {
      logger.error('AI pricing suggestion failed — draft saved without suggestions', { error: err.message });
    }
  }

  const allItems  = [...lineItems, ...suggestedItems];
  const currency  = 'ZAR';
  const { subtotal, vatAmount, total } = calcTotals(allItems);
  const slaRemindAt = new Date(Date.now() + SLA_HOURS * 60 * 60 * 1000);
  const reference   = await nextQuotationRef();

  const { rows } = await query(
    `INSERT INTO quotations
       (reference, client_id, status, line_items, subtotal, vat, total, currency, sla_remind_at, notes, conversation_id)
     VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [reference, clientId, JSON.stringify(allItems), subtotal, vatAmount, total, currency, slaRemindAt, freeText, conversationId]
  );

  return { quotation: rows[0], unmatchedText: unmatchedDescriptions };
}

// ── Staff start a quote (from a chat or the client page) ─────────────────────
/**
 * Draft quotation assigned to the creating staff member.
 * @param {{ clientId, conversationId?, lineItems?, notes? }} data
 * @param {{ id }} actor
 */
export async function createQuotation({ clientId, conversationId = null, lineItems = [], notes }, actor) {
  const { rows: clients } = await query('SELECT id FROM clients WHERE id = $1', [clientId]);
  if (!clients.length) throw new HttpError(400, 'Client not found');
  if (conversationId) {
    const { rows } = await query('SELECT client_id FROM conversations WHERE id = $1', [conversationId]);
    if (!rows.length) throw new HttpError(400, 'Conversation not found');
    if (rows[0].client_id !== clientId) throw new HttpError(400, 'Conversation belongs to a different client');
    // Started from a chat without notes: what the client asked for, in their own words.
    if (notes === undefined) notes = await recentClientRequest(conversationId, clientId);
  }
  notes = notes ?? null;
  const items = (lineItems || []).map((i) => priceLineItem({ ...i, priceConfirmed: false }));
  const { subtotal, vatAmount, total } = calcTotals(items);
  const slaRemindAt = new Date(Date.now() + SLA_HOURS * 60 * 60 * 1000);

  return withTransaction(async (tx) => {
    const reference = await nextQuotationRef(tx);
    const { rows } = await tx.query(
      `INSERT INTO quotations
         (reference, client_id, status, line_items, subtotal, vat, total, currency, sla_remind_at, notes,
          conversation_id, assigned_staff_id, claimed_at)
       VALUES ($1,$2,'draft',$3,$4,$5,$6,'ZAR',$7,$8,$9,$10, CASE WHEN $10::uuid IS NULL THEN NULL ELSE NOW() END)
       RETURNING *`,
      [reference, clientId, JSON.stringify(items), subtotal, vatAmount, total, slaRemindAt, notes, conversationId, actor?.id ?? null]
    );
    return rows[0];
  });
}

const REQUEST_MESSAGES = 10;

/**
 * The client's recent messages in a conversation — the last REQUEST_MESSAGES
 * inbound texts since their previous quotation (staff- or bot-made) — as notes
 * for a new quote ("What the client asked for"). Null when there are none.
 */
export async function recentClientRequest(conversationId, clientId) {
  const { rows } = await query(
    `SELECT body FROM (
       SELECT m.body, m.created_at FROM messages m
       WHERE m.conversation_id = $1 AND m.direction = 'inbound' AND COALESCE(TRIM(m.body), '') <> ''
         AND m.created_at > COALESCE((SELECT MAX(q.created_at) FROM quotations q WHERE q.client_id = $2), '-infinity'::timestamptz)
       ORDER BY m.created_at DESC LIMIT ${REQUEST_MESSAGES}) r
     ORDER BY r.created_at`,
    [conversationId, clientId]
  );
  return rows.length ? rows.map((r) => r.body.trim()).join('\n') : null;
}

/**
 * Save a draft while it is being priced (autosave): line items (re-priced,
 * incomplete lines allowed), notes and the validity date. Only drafts can be
 * saved — anything else is 409 QUOTE_NOT_DRAFT.
 * @param {{ lineItems?: object[], notes?: string|null, validUntil?: string|null }} data
 */
export async function saveDraftQuotation(id, { lineItems, notes, validUntil } = {}) {
  return withTransaction(async (tx) => {
    const { rows: cur } = await tx.query('SELECT id, status FROM quotations WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.length) throw new HttpError(404, 'Quotation not found');
    if (cur[0].status !== 'draft') {
      throw new HttpError(409, 'Only a quote that is still being priced can be edited — revise it first', { code: 'QUOTE_NOT_DRAFT' });
    }
    const sets = ['updated_at = NOW()'];
    const params = [];
    if (lineItems !== undefined) {
      const items = lineItems.map((i) => priceLineItem({ ...i, priceConfirmed: false }));
      const { subtotal, vatAmount, total } = calcTotals(items);
      params.push(JSON.stringify(items), subtotal, vatAmount, total);
      sets.push(`line_items = $${params.length - 3}`, `subtotal = $${params.length - 2}`, `vat = $${params.length - 1}`, `total = $${params.length}`);
    }
    if (notes !== undefined) { params.push(notes || null); sets.push(`notes = $${params.length}`); }
    if (validUntil !== undefined) { params.push(validUntil || null); sets.push(`valid_until = $${params.length}::date`); }
    params.push(id);
    const { rows } = await tx.query(
      `UPDATE quotations SET ${sets.join(', ')} WHERE id = $${params.length} AND status = 'draft' RETURNING *`,
      params
    );
    return rows[0];
  });
}

/**
 * An accepted quotation straight from priced line items (bot direct order /
 * dashboard "new order" without a quote). Runs on the caller's transaction.
 * @returns the quotations row
 */
export async function createAcceptedQuotation(tx, { clientId, lineItems, conversationId = null, actorId = null, autoQuoted = false, notes = null, source }) {
  const items = (lineItems || []).map((i) => ({ ...priceLineItem(i), priceConfirmed: true }));
  const { subtotal, vatAmount, total } = calcTotals(items);
  const reference = await nextQuotationRef(tx);
  const { rows } = await tx.query(
    `INSERT INTO quotations
       (reference, client_id, status, line_items, subtotal, vat, total, currency, notes, conversation_id,
        approved_by, approved_at, valid_until, auto_quoted, assigned_staff_id, claimed_at)
     VALUES ($1,$2,'accepted',$3,$4,$5,$6,'ZAR',$7,$8,$9,NOW(),${NEW_VALID_UNTIL_SQL},$10,$9,
             CASE WHEN $9::uuid IS NULL THEN NULL ELSE NOW() END)
     RETURNING *`,
    [reference, clientId, JSON.stringify(items), subtotal, vatAmount, total, notes, conversationId, actorId, autoQuoted]
  );
  await recordJobEvent(tx, { quotationId: rows[0].id, type: 'quotation.accepted', actorId, data: { source } });
  return rows[0];
}

// ── Quotation PDF delivery (worker: quotation.pdf.send) ──────────────────────
const ACCEPT_PROMPT = `Reply *accept* to confirm your order, or *9* to speak to a consultant.`;

/** Caption tail for the quotation PDF. */
export const quotationCaptionTail = () => `${ACCEPT_PROMPT}\nValid for ${VALIDITY_DAYS} days.`;

/**
 * Enqueue the quotation PDF for the client (render + upload + send happen on the
 * worker). Returns true when there is a WhatsApp number to send it to.
 */
async function queueQuotationPdf(tx, quotation, { clientWa, conversationId = null, dedupeKey }) {
  if (!clientWa) return false;
  await enqueue(tx, 'quotation.pdf.send', { quotationId: quotation.id, conversationId }, {
    dedupeKey, queueKey: outboundQueueKey(clientWa),
  });
  return true;
}

/**
 * After a quote is sent, a conversation that was waiting for a consultant (the
 * pricing hand-off) goes back to the bot so the client's "accept" is handled.
 * A conversation where a consultant is actively chatting is left alone.
 */
async function handBackToBot(tx, clientId) {
  await tx.query(
    `UPDATE conversations SET state = 'main_menu', updated_at = NOW()
     WHERE client_id = $1 AND is_open = true AND state = 'awaiting_consultant'`,
    [clientId]
  );
}

const lockForApproval = (tx, id) => tx.query(
  `SELECT q.*, c.whatsapp_number AS client_wa
   FROM quotations q LEFT JOIN clients c ON c.id = q.client_id
   WHERE q.id = $1 FOR UPDATE OF q`,
  [id]
);

async function sendQuote(id, lineItems, { staffId = null, auto = false }) {
  // Never trust client-side lineTotal — recompute every line, then the totals.
  const confirmedItems = lineItems.map((item) => ({ ...priceLineItem(item), priceConfirmed: true }));
  const { subtotal, vatAmount, total } = calcTotals(confirmedItems);

  return withTransaction(async (tx) => {
    const { rows: cur } = await lockForApproval(tx, id);
    if (!cur.length) throw new HttpError(404, 'Quotation not found');
    const existing = cur[0];
    if (existing.status !== 'draft') {
      if (auto) return null;
      throw new HttpError(400, 'Only draft quotations can be approved');
    }
    // Conditional on status = 'draft' (row locked above) so two concurrent
    // approvals cannot both win (and send the client two PDFs).
    const { rows } = await tx.query(
      `UPDATE quotations
       SET status      = 'sent',
           line_items  = $1,
           subtotal    = $2,
           vat         = $3,
           total       = $4,
           approved_by = COALESCE($5, approved_by),
           approved_at = NOW(),
           auto_quoted = auto_quoted OR $6,
           -- a validity date set while drafting is kept (if still ahead), else the standard validity
           valid_until = CASE WHEN valid_until IS NOT NULL AND valid_until >= ${SA_TODAY_SQL}
                              THEN valid_until ELSE ${NEW_VALID_UNTIL_SQL} END,
           -- sending claims an unowned quote for the sender
           claimed_at  = CASE WHEN assigned_staff_id IS NULL AND $5::uuid IS NOT NULL THEN NOW() ELSE claimed_at END,
           assigned_staff_id = COALESCE(assigned_staff_id, $5::uuid),
           updated_at  = NOW()
       WHERE id = $7 AND status = 'draft'
       RETURNING *`,
      [JSON.stringify(confirmedItems), subtotal, vatAmount, total, staffId, auto, id]
    );
    if (!rows.length) {
      if (auto) return null;
      throw new HttpError(409, 'Quotation has already been approved');
    }
    const quotation = rows[0];
    await recordJobEvent(tx, { quotationId: id, type: 'quotation.sent', actorId: staffId, data: { auto, total } });
    const whatsappSent = await queueQuotationPdf(tx, quotation, {
      clientWa: existing.client_wa,
      conversationId: existing.conversation_id,
      dedupeKey: `quotation:${id}:sent:${new Date(quotation.approved_at).getTime()}`,
    });
    await handBackToBot(tx, existing.client_id);
    return { quotation, whatsappSent };
  });
}

// ── Consultant approves a draft — recalculates, flips to sent, queues the PDF ─
export async function approveQuotation(id, lineItems, staffId) {
  return sendQuote(id, lineItems, { staffId });
}

// ── AI auto-approve when all items are catalog-matched ────────────────────────
export async function autoApproveQuotation(id, lineItems) {
  const r = await sendQuote(id, lineItems, { auto: true });
  return r ? r.quotation : null;
}

// ── Resend the quotation PDF ─────────────────────────────────────────────────
export async function resendQuotation(id, actor) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT q.*, ${IS_EXPIRED_SQL} AS is_expired, c.whatsapp_number AS client_wa
       FROM quotations q LEFT JOIN clients c ON c.id = q.client_id WHERE q.id = $1`,
      [id]
    );
    if (!rows.length) throw new HttpError(404, 'Quotation not found');
    const q = applyExpiry(rows[0]);
    if (!['sent', 'accepted'].includes(q.status)) {
      throw new HttpError(409, `Only a sent or accepted quotation can be resent (this one is '${q.status}')`, { code: 'QUOTE_NOT_SENT' });
    }
    if (!q.client_wa) throw new HttpError(409, 'The client has no WhatsApp number', { code: 'NO_WHATSAPP' });
    // Ten-second bucket: a double click queues one resend.
    const bucket = Math.floor(Date.now() / 10000);
    await queueQuotationPdf(tx, q, { clientWa: q.client_wa, conversationId: q.conversation_id, dedupeKey: `quotation:${id}:resend:${bucket}` });
    await recordJobEvent(tx, { quotationId: id, type: 'quotation.resent', actorId: actor?.id ?? null });
    return q;
  });
}

// ── List quotations ───────────────────────────────────────────────────────────
const LIST_STATE_SQL = jobStateSql({
  openTickets: `(SELECT COUNT(*)::int FROM tickets t WHERE t.order_id = o.id AND t.status IN ('open', 'in_progress'))`,
});
// Returns { items, total, page, limit }; rows carry order_id / order_reference.
export async function listQuotations({ status, search, clientId, ...rest } = {}) {
  const { page, limit, offset } = pageParams(rest, { defaultLimit: 500, maxLimit: 500 });
  const params = [];
  const where  = [];
  if (status) {
    if (!QUOTATION_STATUSES.includes(status)) throw new HttpError(400, `Invalid status filter: ${status}`);
    params.push(status);
    if (status === 'sent')         where.push(`q.status = $${params.length} AND NOT ${PAST_VALIDITY_SQL}`);
    else if (status === 'expired') where.push(`(q.status = $${params.length} OR (q.status = 'sent' AND ${PAST_VALIDITY_SQL}))`);
    else                           where.push(`q.status = $${params.length}`);
  }
  if (typeof search === 'string' && search.trim()) {
    params.push(`%${search.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    where.push(`(q.reference ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.organisation ILIKE $${params.length})`);
  }
  if (clientId) { params.push(clientId); where.push(`q.client_id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT q.*,
            ${IS_EXPIRED_SQL} AS is_expired,
            c.name            AS client_name,
            c.whatsapp_number AS client_wa,
            c.organisation    AS client_org,
            assigned.name     AS assigned_name,
            approver.name     AS approved_by_name,
            o.id              AS order_id,
            o.reference       AS order_reference,
            ${LIST_STATE_SQL} AS lifecycle_state
     FROM quotations q
     LEFT JOIN clients c        ON q.client_id        = c.id
     LEFT JOIN staff   assigned ON q.assigned_staff_id = assigned.id
     LEFT JOIN staff   approver ON q.approved_by       = approver.id
     LEFT JOIN orders  o        ON o.quotation_id      = q.id
     ${whereSql}
     ORDER BY q.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total FROM quotations q LEFT JOIN clients c ON q.client_id = c.id ${whereSql}`,
    params
  );
  return { items: rows.map(applyExpiry), total: countRows[0].total, page, limit };
}

export async function getQuotationById(id) {
  const { rows } = await query(
    `SELECT q.*,
            ${IS_EXPIRED_SQL}    AS is_expired,
            ${PAST_VALIDITY_SQL} AS past_validity,
            c.name             AS client_name,
            c.organisation     AS client_org,
            c.whatsapp_number  AS client_wa,
            c.physical_address AS client_address,
            c.client_type,
            o.id               AS order_id,
            o.reference        AS order_reference,
            assigned.name      AS assigned_name
     FROM quotations q
     LEFT JOIN clients c ON c.id = q.client_id
     LEFT JOIN orders o  ON o.quotation_id = q.id
     LEFT JOIN staff assigned ON assigned.id = q.assigned_staff_id
     WHERE q.id = $1`,
    [id]
  );
  if (!rows.length) throw new HttpError(404, 'Quotation not found');
  return applyExpiry(rows[0]);
}

// ── Status transitions (lifecycle machine) ───────────────────────────────────
const EVENT_FOR_STATUS = {
  draft: 'quotation.revised', sent: 'quotation.sent', accepted: 'quotation.accepted',
  rejected: 'quotation.declined', expired: 'quotation.expired',
};

/**
 * Move a quotation to `status` through the lifecycle machine. The check and the
 * write are one conditional UPDATE (atomic); a refusal is explained with a 409.
 * Runs on `tx` when given (e.g. inside an order conversion).
 */
export async function updateQuotationStatus(id, status, { actorId = null, tx = null, source = 'staff' } = {}) {
  const rule = QUOTATION_TRANSITIONS[status];
  if (!rule) throw new HttpError(400, `Invalid status: ${status}`, { code: 'INVALID_STATUS' });

  const conditions = [`q.status IN (${rule.from.map((s) => `'${s}'`).join(', ')})`];
  if (rule.noOrder) conditions.push(NO_ORDER_SQL);
  if (rule.withinValidity) conditions.push(`NOT ${PAST_VALIDITY_SQL}`);
  const extraSet = status === 'sent' ? `, valid_until = COALESCE(q.valid_until, ${NEW_VALID_UNTIL_SQL})`
    : status === 'draft' ? ', valid_until = NULL'   // revised: a fresh validity when it is sent again
      : '';

  const run = async (c) => {
    const { rows } = await c.query(
      `UPDATE quotations q SET status = $1, updated_at = NOW()${extraSet}
       WHERE q.id = $2 AND ${conditions.join(' AND ')}
       RETURNING q.*`,
      [status, id]
    );
    if (rows.length) {
      await recordJobEvent(c, { quotationId: id, type: EVENT_FOR_STATUS[status], actorId, data: { source } });
      return rows[0];
    }

    // Explain why the transition was refused (same rule, evaluated in JS).
    const { rows: cur } = await c.query(
      `SELECT q.status, ${PAST_VALIDITY_SQL} AS past_validity,
              EXISTS (SELECT 1 FROM orders o WHERE o.quotation_id = q.id) AS has_order
       FROM quotations q WHERE q.id = $1`,
      [id]
    );
    if (!cur.length) throw new HttpError(404, 'Quotation not found');
    const verdict = quotationTransition(cur[0].status, status, { hasOrder: cur[0].has_order, pastValidity: cur[0].past_validity });
    throw new HttpError(409, verdict.ok ? 'Quotation changed — refresh and try again' : verdict.message, { code: verdict.ok ? 'STALE' : verdict.code });
  };
  return tx ? run(tx) : withTransaction(run);
}

// ── Client replies "accept" on WhatsApp ──────────────────────────────────────
/**
 * Accept the client's quotation: the one with `reference` when given, else the
 * latest sent quotation still within validity. Returns the accepted row, or null
 * when there is nothing the client may accept (lifecycle rule canClientAccept).
 */
export async function acceptQuotationByClient(clientId, { reference = null } = {}) {
  const { rows } = await query(
    `SELECT q.*, ${PAST_VALIDITY_SQL} AS past_validity, ${IS_EXPIRED_SQL} AS is_expired
     FROM quotations q
     WHERE q.client_id = $1 AND q.status = 'sent' ${reference ? 'AND q.reference = $2' : `AND NOT ${PAST_VALIDITY_SQL}`}
     ORDER BY q.updated_at DESC
     LIMIT 1`,
    reference ? [clientId, reference] : [clientId]
  );
  const candidate = rows[0];
  if (!canClientAccept(candidate)) return null;
  try {
    return await updateQuotationStatus(candidate.id, 'accepted', { source: 'client' });
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) return null;   // raced / lapsed meanwhile
    throw err;
  }
}

export async function getQuotationByReference(reference, clientId) {
  const { rows } = await query(
    `SELECT q.*, ${IS_EXPIRED_SQL} AS is_expired, ${PAST_VALIDITY_SQL} AS past_validity
     FROM quotations q
     WHERE reference = $1 AND client_id = $2`,
    [reference, clientId]
  );
  return applyExpiry(rows[0]) || null;
}

// ── Persist lapsed quotations as 'expired' (safe to run from a scheduled job) ─
export async function expireStaleQuotations() {
  const { rows } = await query(
    `UPDATE quotations q SET status = 'expired', updated_at = NOW()
     WHERE q.status = 'sent' AND ${PAST_VALIDITY_SQL}
     RETURNING q.id`
  );
  return rows.length;
}


export { renderQuotationPdf };

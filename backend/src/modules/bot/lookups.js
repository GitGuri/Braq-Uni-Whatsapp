/**
 * Read-only queries the bot needs (orders, quotes, proofs, message timing).
 * Never discloses another client's data: every lookup is scoped to the client
 * (or, for orders, to client rows registered under the sender's phone number).
 */
import { query } from '../../core/db.js';
import { EXPIRES_ON_SQL, PAST_VALIDITY_SQL, IS_EXPIRED_SQL, NO_ORDER_SQL } from '../lifecycle/sql.js';
import { isDepositPaid, isPaidInFull } from '../lifecycle/machines.js';
import { stageLabel, fmtDate } from './templates.js';
import { DEPOSIT_PERCENT } from '../../core/money.js';

/** Digits only, local 0… normalised to 27… (how phone numbers are compared). */
export const phoneDigits = (phone) => String(phone || '').replace(/\D/g, '').replace(/^0/, '27');

/** True when the client's previous message in this conversation is more than 24 hours old. */
export async function isStaleConversation(conversationId) {
  const { rows } = await query(
    `SELECT MAX(created_at) AS last, (NOW() - MAX(created_at)) > INTERVAL '24 hours' AS stale
     FROM messages WHERE conversation_id = $1 AND direction = 'inbound'`,
    [conversationId]
  );
  return Boolean(rows[0]?.last && rows[0].stale);
}

/** Minutes since the last message we sent on this conversation (null: never). */
export async function minutesSinceLastOutbound(conversationId) {
  const { rows } = await query(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 60 AS minutes
     FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`,
    [conversationId]
  );
  return rows[0]?.minutes == null ? null : Number(rows[0].minutes);
}

/** The client's order with a design proof waiting for their answer (latest first). */
export async function pendingProofOrder(clientId) {
  const { rows } = await query(
    `SELECT * FROM orders WHERE client_id = $1 AND proof_status = 'sent'
     ORDER BY proof_sent_at DESC NULLS LAST, updated_at DESC LIMIT 1`,
    [clientId]
  );
  return rows[0] || null;
}

const QUOTE_COLUMNS = `q.*, ${PAST_VALIDITY_SQL} AS past_validity, ${IS_EXPIRED_SQL} AS is_expired,
  ${EXPIRES_ON_SQL} AS expires_on,
  (SELECT o.reference FROM orders o WHERE o.quotation_id = q.id ORDER BY o.created_at LIMIT 1) AS order_reference`;

/** Display status of a quotation: a 'sent' quote past its validity reads as 'expired'. */
export const quoteStatus = (q) => (q?.is_expired ? 'expired' : q?.status);

/** The client's quotation with `reference`, else their most recent one (any status). */
export async function findQuote(clientId, { reference = null } = {}) {
  const { rows } = await query(
    `SELECT ${QUOTE_COLUMNS} FROM quotations q
     WHERE q.client_id = $1 ${reference ? 'AND q.reference = $2' : ''}
     ORDER BY q.updated_at DESC LIMIT 1`,
    reference ? [clientId, reference] : [clientId]
  );
  return rows[0] || null;
}

/** Latest sent quote the client has not accepted yet, expired ones included (for "accept"). */
export async function latestSentQuote(clientId, { reference = null } = {}) {
  const { rows } = await query(
    `SELECT ${QUOTE_COLUMNS} FROM quotations q
     WHERE q.client_id = $1 AND q.status IN ('sent', 'expired') ${reference ? 'AND q.reference = $2' : ''}
     ORDER BY q.updated_at DESC LIMIT 1`,
    reference ? [clientId, reference] : [clientId]
  );
  return rows[0] || null;
}

/** A quote the client can order from right now: sent and still valid, or accepted — without an order yet. */
export async function offerableQuote(clientId) {
  const { rows } = await query(
    `SELECT ${QUOTE_COLUMNS} FROM quotations q
     WHERE q.client_id = $1 AND ${NO_ORDER_SQL}
       AND ((q.status = 'sent' AND NOT ${PAST_VALIDITY_SQL}) OR q.status = 'accepted')
       AND jsonb_array_length(COALESCE(q.line_items, '[]'::jsonb)) > 0
     ORDER BY q.updated_at DESC LIMIT 1`,
    [clientId]
  );
  return rows[0] || null;
}

/** The client's open (not completed / cancelled) orders, own client row or same phone number. */
export async function openOrders(clientId, phone, { limit = 8 } = {}) {
  const { rows } = await query(
    `SELECT o.* FROM orders o JOIN clients c ON c.id = o.client_id
     WHERE (o.client_id = $1 OR regexp_replace(regexp_replace(c.whatsapp_number, '[^0-9]', '', 'g'), '^0', '27') = $2)
       AND o.stage <> 'completed' AND o.cancelled_at IS NULL
     ORDER BY o.created_at DESC LIMIT $3`,
    [clientId, phoneDigits(phone) || '-', limit]
  );
  return rows;
}

/** The client's most recent order with its line items (for "repeat previous order"). */
export async function lastOrderWithItems(clientId) {
  const { rows } = await query(
    `SELECT o.id, o.reference, q.line_items
     FROM orders o JOIN quotations q ON q.id = o.quotation_id
     WHERE o.client_id = $1 AND o.cancelled_at IS NULL
       AND jsonb_array_length(COALESCE(q.line_items, '[]'::jsonb)) > 0
     ORDER BY o.created_at DESC LIMIT 1`,
    [clientId]
  );
  return rows[0] || null;
}

/** Account clients (migration 0009 clients.account_terms) do not pay a deposit up front. */
export const isAccountClient = (client) => client?.account_terms === true;

/** What the client still owes on an order, as a sentence ('' when nothing is due). */
export function amountDueText(order, { account = false } = {}) {
  const total = Number(order.total_amount ?? 0);
  const deposit = Number(order.deposit_amount ?? 0);
  const balance = Number(order.balance_amount ?? 0);
  if (isPaidInFull(order.payment_status) || order.payment_status === 'not_required') return '✅ Paid in full.';
  if (isDepositPaid(order.payment_status)) return balance > 0 ? `💳 Balance still due: *R ${balance.toFixed(2)}*` : '';
  if (account) return total > 0 ? `💳 Amount due on account: *R ${total.toFixed(2)}*` : '';
  if (deposit > 0) return `💳 Deposit due to start production (${DEPOSIT_PERCENT}%): *R ${deposit.toFixed(2)}*` + (total > 0 ? ` (total R ${total.toFixed(2)})` : '');
  return total > 0 ? `💳 Amount due: *R ${total.toFixed(2)}*` : '';
}

/** Client-facing stage: "Ready for collection" vs "Dispatched" instead of "Ready / Dispatched". */
export function orderStageText(order) {
  if (order.stage === 'ready' || order.stage === 'packing_dispatch') {
    return order.delivery_type === 'delivery' ? 'Dispatched' : 'Ready for collection';
  }
  return stageLabel(order.stage);
}

/** One line per open order for the tracking list. */
export function orderSummary(order) {
  const due = order.estimated_completion_date ? `due ${fmtDate(order.estimated_completion_date)}` : '';
  return {
    reference: order.reference,
    label: orderStageText(order) + (order.is_on_hold ? ' (on hold)' : ''),
    due,
  };
}

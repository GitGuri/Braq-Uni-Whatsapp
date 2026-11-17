import { query, withTransaction } from '../../core/db.js';
import { HttpError } from '../../core/errors.js';
import { toCentsOrNull, centsToFixed } from '../../core/money.js';
import { PAYMENT_STATUSES, PAYMENT_TYPES, PAYMENT_RANK } from '../lifecycle/machines.js';
import { queueWhatsAppText, TEMPLATE_FALLBACKS } from '../notifications/whatsapp.js';

// orders.payment_status is plain text: unpaid | deposit_paid | paid_in_full.
// Statuses only ever move forward (a later payment never downgrades them).
export { PAYMENT_STATUSES };
const STATUS_RANK = PAYMENT_RANK;

// All money maths is done in integer cents to avoid float drift (core/money.js).
const toCents = toCentsOrNull;
const money = centsToFixed;

/**
 * The order's total in cents, or null when it cannot be determined.
 *
 * deposit_amount / balance_amount are set when an order is priced (60/40 split).
 * balance_amount is kept as "what is still owed after the deposit" — i.e.
 * total − max(paid, deposit) — so the total is recoverable as
 * balance + max(paidSoFar, deposit). Orders without those amounts fall back to
 * the linked quotation's total.
 */
export function orderTotalCents(order, paidBeforeCents = 0, quotationTotal = null) {
  const depositC = toCents(order.deposit_amount);
  const balanceC = toCents(order.balance_amount);
  if (depositC != null && balanceC != null) return balanceC + Math.max(paidBeforeCents, depositC);
  const quoteC = toCents(quotationTotal);
  return quoteC != null && quoteC > 0 ? quoteC : null;
}

/**
 * Work out the effect of a new payment. Pure — throws HttpError(400) when the
 * payment would overpay the order.
 * @returns {{ status, balanceCents, totalCents, paidAfterCents, outstandingCents, depositDueCents }}
 */
export function computePaymentState({ order, paidBeforeCents = 0, amountCents, type, quotationTotal = null }) {
  const depositC   = toCents(order.deposit_amount);
  const totalC     = orderTotalCents(order, paidBeforeCents, quotationTotal);
  const paidAfterC = paidBeforeCents + amountCents;
  const current    = order.payment_status;
  const currentRank = STATUS_RANK[current] ?? 0;

  if (totalC != null && paidAfterC > totalC) {
    const outstanding = Math.max(0, totalC - paidBeforeCents);
    throw new HttpError(400, outstanding > 0
      ? `Payment exceeds the outstanding amount of R ${money(outstanding)}`
      : 'Order is already paid in full');
  }
  if (totalC == null && current === 'paid_in_full') {
    throw new HttpError(400, 'Order is already paid in full');
  }

  let computed = null;
  if (totalC != null) {
    if (paidAfterC >= totalC) computed = 'paid_in_full';
    else if (depositC != null && depositC > 0 ? paidAfterC >= depositC : paidAfterC > 0) computed = 'deposit_paid';
  } else if (type === 'full' || type === 'balance') {
    // No total on record: staff are telling us this settles the order.
    computed = 'paid_in_full';
  } else if (depositC == null || depositC <= 0 || paidAfterC >= depositC) {
    computed = 'deposit_paid';
  }

  const status = computed && STATUS_RANK[computed] > currentRank ? computed : (current || 'unpaid');

  let balanceCents = null; // null → leave balance_amount unchanged
  if (totalC != null) balanceCents = totalC - Math.max(paidAfterC, depositC ?? 0);
  else if (status === 'paid_in_full') balanceCents = 0;
  if (balanceCents != null && balanceCents < 0) balanceCents = 0;

  return {
    status,
    balanceCents,
    totalCents: totalC,
    paidAfterCents: paidAfterC,
    outstandingCents: totalC != null ? Math.max(0, totalC - paidAfterC) : null,
    depositDueCents: depositC != null && depositC > paidAfterC ? depositC - paidAfterC : 0,
  };
}

function paymentReceivedMessage({ reference, type, amount, currency, state }) {
  const cur = currency && currency !== 'ZAR' ? `${currency} ` : 'R ';
  const what = type === 'full' ? 'full payment' : `${type} payment`;
  let msg =
    `✅ *Payment received${reference ? ` — Ref: ${reference}` : ''}*\n\n` +
    `Thank you! We've received your ${what} of *${cur}${Number(amount).toFixed(2)}*.\n\n`;

  if (state.status === 'paid_in_full') {
    msg += `Your order is now *fully paid*. 🎉`;
  } else if (state.depositDueCents > 0) {
    msg += `Deposit still due: *R ${money(state.depositDueCents)}* (required before production can begin).`;
  } else if (state.outstandingCents != null && state.outstandingCents > 0) {
    msg += `Outstanding balance: *R ${money(state.outstandingCents)}* (due before collection/delivery).`;
  } else {
    msg += `Our team will be in touch with the next steps.`;
  }
  return msg + `\n\nReply *9* to speak to a consultant.`;
}

// ── Record a payment, recompute payment_status / balance, notify the client ──
// Runs in a transaction with the order row locked so concurrent payments are
// applied one at a time against an accurate running total.
export async function recordPayment(orderId, data = {}) {
  const { payment } = await withTransaction((tx) => recordPaymentTx(tx, orderId, data));
  return payment;
}

/**
 * recordPayment on the caller's transaction (so a payment and a stage advance
 * can commit — or roll back — together).
 * @returns {Promise<{ payment: object, state: object }>} the payments row and computePaymentState()
 */
export async function recordPaymentTx(tx, orderId, { type, amount, currency, notes } = {}) {
  if (!PAYMENT_TYPES.includes(type)) throw new HttpError(400, `Invalid payment type: ${type}`);
  const amountCents = toCents(amount);
  if (amountCents == null || amountCents <= 0 || Math.abs(Number(amount) * 100 - amountCents) > 1e-6) {
    throw new HttpError(400, 'Amount must be a positive value with at most 2 decimal places');
  }

  {
    const { rows } = await tx.query(
      `SELECT o.*, c.whatsapp_number, c.name AS client_name, q.total AS quotation_total
       FROM orders o
       JOIN clients c ON c.id = o.client_id
       LEFT JOIN quotations q ON q.id = o.quotation_id
       WHERE o.id = $1
       FOR UPDATE OF o`,
      [orderId]
    );
    if (!rows.length) throw new HttpError(404, 'Order not found');
    const order = rows[0];

    const { rows: sumRows } = await tx.query(
      'SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE order_id = $1',
      [orderId]
    );
    const paidBeforeCents = toCents(sumRows[0]?.total_paid) ?? 0;

    const state = computePaymentState({
      order, paidBeforeCents, amountCents, type, quotationTotal: order.quotation_total,
    });

    const { rows: payRows } = await tx.query(
      `INSERT INTO payments (order_id, type, amount, currency, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [orderId, type, amount, currency || 'ZAR', notes || null]
    );

    await tx.query(
      'UPDATE orders SET payment_status = $1, balance_amount = $2, updated_at = NOW() WHERE id = $3',
      [state.status, state.balanceCents != null ? state.balanceCents / 100 : (order.balance_amount ?? null), orderId]
    );

    // Receipt to the client — queued in the same transaction as the payment.
    if (order.whatsapp_number) {
      await queueWhatsAppText(tx, {
        to: order.whatsapp_number,
        body: paymentReceivedMessage({ reference: order.reference, type, amount, currency: currency || 'ZAR', state }),
        clientId: order.client_id,
        conversationId: order.conversation_id,
        templateFallback: TEMPLATE_FALLBACKS.paymentReceived({
          client: { name: order.client_name }, amount, reference: order.reference,
          balanceText: state.status === 'paid_in_full' ? 'Your order is now fully paid.'
            : state.depositDueCents > 0 ? `Deposit still due: R ${money(state.depositDueCents)}.`
              : state.outstandingCents > 0 ? `Outstanding balance: R ${money(state.outstandingCents)}.` : '',
        }),
      }, { dedupeKey: `payment:${payRows[0].id}` });
    }
    return { payment: payRows[0], state };
  }
}

// ── List payments for an order (newest first) ────────────────────────────────
export async function listPayments(orderId) {
  const { rows } = await query(
    'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC',
    [orderId]
  );
  return rows;
}

// ── List payments for an order (oldest first) ────────────────────────────────
export async function listPaymentsForOrder(orderId) {
  const { rows } = await query(
    'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at ASC',
    [orderId]
  );
  return rows;
}

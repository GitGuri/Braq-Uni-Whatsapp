/**
 * Lifecycle facade: build the `lifecycle` object that detail responses carry.
 *   lifecycle = { state, label, flags, nextActions }
 * Pure — callers load the rows.
 */
import { deriveJob } from './derive.js';
import { nextActions } from './nextActions.js';
import { JOB_STATES, OPEN_TICKET_STATUSES } from './machines.js';
import { toCentsOrNull } from '../../core/money.js';

export * from './machines.js';
export { deriveJob } from './derive.js';
export { advanceGuards, checkAdvance, evaluateAdvance, blockersOf, GUARDS, OVERRIDE_REASON_MIN } from './guards.js';
export { nextActions, oneClickAction, ACTION_LABELS } from './nextActions.js';

/** Money facts for an order in cents: deposit, total (null when unknown) and paid so far. */
export function orderMoney(order, payments = [], quotation = null) {
  if (!order) return {};
  const paidCents = payments.reduce((s, p) => s + (toCentsOrNull(p.amount) ?? 0), 0);
  const depositCents = toCentsOrNull(order.deposit_amount);
  const balanceCents = toCentsOrNull(order.balance_amount);
  let totalCents = toCentsOrNull(order.total_amount);
  if (totalCents == null && depositCents != null && balanceCents != null) totalCents = balanceCents + Math.max(paidCents, depositCents);
  if (totalCents == null) {
    const q = toCentsOrNull(quotation?.total ?? order.quotation_total);
    totalCents = q != null && q > 0 ? q : null;
  }
  return { depositCents, totalCents, paidCents };
}

/**
 * @param {{ quotation?, order?, payments?, tickets?, conversation?, now? }} job rows
 * @param {object|null} staff the caller (role decides overrides / PO actions)
 */
export function buildLifecycle({ quotation = null, order = null, payments = [], tickets = [], conversation = null, now } = {}, staff = null) {
  const openTickets = tickets.filter((t) => OPEN_TICKET_STATUSES.includes(t.status));
  const { state, flags } = deriveJob({ quotation, order, openTickets: openTickets.length, conversation, now });
  return {
    state,
    label: JOB_STATES[state]?.label ?? state,
    flags,
    nextActions: nextActions({ state, flags, quotation, order, money: orderMoney(order, payments, quotation), openTickets }, staff),
  };
}

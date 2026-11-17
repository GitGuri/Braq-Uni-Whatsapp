/**
 * deriveJob — the job's state and flags from existing fields. Pure.
 * A job is a quotation plus its order and tickets; legacy orders without a
 * quotation derive from the order alone. sql.js jobStateSql/overdueSql are the
 * SQL twin used by the jobs board (keep both in step; jobs tests compare them).
 */
import {
  toCanonicalStage, depositSatisfied, isPaidInFull, PROOF_BLOCKING, TERMINAL_JOB_STATES, CLIENT_WAITING_STATE,
} from './machines.js';
import { SA_TZ } from './sql.js';

/** 'YYYY-MM-DD' of a DATE value: strings taken literally, pg DATE (local-midnight Date) by local fields. */
function dateKey(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return null;
}

/** Today on the South African calendar, 'YYYY-MM-DD'. */
export function saToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SA_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const isExpiredQuote = (q) => q.status === 'expired' || (q.status === 'sent' && (q.past_validity === true || q.is_expired === true));

/**
 * @param {{
 *   quotation?: object|null,   // quotations row (+ is_expired / past_validity)
 *   order?: object|null,       // orders row
 *   openTickets?: number,      // open/in-progress tickets on the order
 *   conversation?: object|null,// the client's open conversation (WITH_CONSULTANT: the client waits for a person)
 *   now?: Date,
 * }} input
 * @returns {{ state: string, flags: string[] }}
 */
export function deriveJob({ quotation = null, order = null, openTickets = 0, conversation = null, now = new Date() } = {}) {
  let state;
  if (!order) {
    const q = quotation || {};
    if (q.status === 'draft') state = 'PRICING';
    else if (q.status === 'rejected') state = 'DECLINED';
    else if (q.status === 'accepted') state = 'ACCEPTED';
    else if (isExpiredQuote(q)) state = 'EXPIRED';
    else state = 'QUOTED';
  } else if (order.cancelled_at || order.stage === 'cancelled') {
    state = 'CANCELLED';
  } else {
    const stage = toCanonicalStage(order.stage);
    if (stage === 'completed') state = Number(openTickets) > 0 ? 'AFTER_SALES' : 'COMPLETED';
    else if (stage === 'ready') state = 'READY';
    else if (stage === 'in_production') state = 'IN_PRODUCTION';
    else if (!depositSatisfied(order)) state = 'AWAITING_DEPOSIT';   // account clients skip the deposit
    else if (PROOF_BLOCKING.includes(order.proof_status || 'none')) state = 'AWAITING_PROOF';
    else state = 'READY_TO_PRODUCE';
  }

  const flags = [];
  if (order?.is_on_hold) flags.push('ON_HOLD');
  if (conversation?.state === CLIENT_WAITING_STATE && conversation.is_open !== false) flags.push('WITH_CONSULTANT');

  const terminal = TERMINAL_JOB_STATES.includes(state);
  const slaAt = quotation?.sla_remind_at ? new Date(quotation.sla_remind_at) : null;
  const due = dateKey(order?.estimated_completion_date);
  // Overdue = a deadline passed: the quote SLA while pricing, the order's due
  // date, or an accepted quote's validity before the order was created.
  const overdue =
    (state === 'PRICING' && slaAt && slaAt.getTime() <= now.getTime())
    || (order && !terminal && state !== 'AFTER_SALES' && due && due < saToday(now))
    || (state === 'ACCEPTED' && quotation?.past_validity === true);
  if (overdue) flags.push('OVERDUE');
  // Money still owed at collection is its own flag, not "overdue".
  if (state === 'READY' && !isPaidInFull(order.payment_status)) flags.push('BALANCE_DUE');

  const owner = order?.assigned_staff_id ?? quotation?.assigned_staff_id ?? null;
  if (!owner && !terminal) flags.push('UNASSIGNED');

  return { state, flags };
}

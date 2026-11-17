/**
 * SQL fragments that mirror the lifecycle rules, for queries that must filter,
 * count or page by them (the jobs board, quotation lists). Pure strings built
 * from machines.js so the rules stay defined once; derive.js holds the JS twin.
 *
 * Aliases: quotations `q`, orders `o` (unless given), open-ticket count expression.
 */
import { QUOTE_VALIDITY_DAYS } from '../../core/money.js';
import {
  LEGACY_STAGE_MAP, PROOF_BLOCKING, PAYMENT_RANK, HUMAN_STATES, TERMINAL_JOB_STATES, CLIENT_WAITING_STATE,
  FOLLOW_UP_DAYS, EXPIRING_DAYS, DUE_SOON_DAYS,
} from './machines.js';

export const SA_TZ = 'Africa/Johannesburg';
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const list = (arr) => arr.map(lit).join(', ');

// ── Quotation validity (computed on read) ────────────────────────────────────
// A quotation is valid through `valid_until` (a South African calendar date).
// Rows without valid_until fall back to approval/creation date + validity days.
// Only 'sent' quotations lapse to 'expired'; 'expired' may also be stored.
export const SA_TODAY_SQL        = `(NOW() AT TIME ZONE '${SA_TZ}')::date`;
export const EXPIRES_ON_SQL      = `COALESCE(q.valid_until, (COALESCE(q.approved_at, q.created_at) AT TIME ZONE '${SA_TZ}')::date + ${QUOTE_VALIDITY_DAYS})`;
export const PAST_VALIDITY_SQL   = `(${EXPIRES_ON_SQL} < ${SA_TODAY_SQL})`;
export const IS_EXPIRED_SQL      = `(q.status = 'expired' OR (q.status = 'sent' AND ${PAST_VALIDITY_SQL}))`;
export const NEW_VALID_UNTIL_SQL = `((NOW() AT TIME ZONE '${SA_TZ}')::date + ${QUOTE_VALIDITY_DAYS})`;
export const NO_ORDER_SQL        = `NOT EXISTS (SELECT 1 FROM orders o2 WHERE o2.quotation_id = q.id)`;

// ── Orders ───────────────────────────────────────────────────────────────────
/** Canonical stage of `${o}.stage` (legacy values mapped). */
export function canonicalStageSql(o = 'o') {
  const whens = Object.entries(LEGACY_STAGE_MAP).map(([legacy, c]) => `WHEN ${lit(legacy)} THEN ${lit(c)}`).join(' ');
  return `(CASE ${o}.stage ${whens} ELSE ${o}.stage END)`;
}

const DEPOSIT_PAID_STATUSES = Object.keys(PAYMENT_RANK).filter((s) => PAYMENT_RANK[s] >= 1);
const PAID_IN_FULL_STATUSES = Object.keys(PAYMENT_RANK).filter((s) => PAYMENT_RANK[s] >= 2);
export const depositPaidSql = (o = 'o') => `(${o}.payment_status IN (${list(DEPOSIT_PAID_STATUSES)}))`;
export const paidInFullSql  = (o = 'o') => `(${o}.payment_status IN (${list(PAID_IN_FULL_STATUSES)}))`;
export const proofBlockingSql = (o = 'o') => `(COALESCE(${o}.proof_status, 'none') IN (${list(PROOF_BLOCKING)}))`;
/**
 * Deposit paid, or the client trades on account terms (no deposit needed).
 * @param {string} o orders alias
 * @param {string} accountTerms SQL for the client's account_terms
 */
export const depositSatisfiedSql = (o = 'o', accountTerms = `(SELECT c9.account_terms FROM clients c9 WHERE c9.id = ${o}.client_id)`) =>
  `(${depositPaidSql(o)} OR COALESCE(${accountTerms}, false))`;

/**
 * Job state (see derive.js deriveJob) as a CASE expression.
 * @param {{ o?: string, openTickets?: string, accountTerms?: string }} opts
 *   orders alias; SQL for the open-ticket count; SQL for the client's account_terms
 *   (default: the clients row joined as `c`)
 */
export function jobStateSql({ o = 'o', openTickets = '0', accountTerms = 'c.account_terms' } = {}) {
  const canon = canonicalStageSql(o);
  return `(CASE
    WHEN ${o}.id IS NULL THEN (CASE
      WHEN q.status = 'draft'    THEN 'PRICING'
      WHEN q.status = 'rejected' THEN 'DECLINED'
      WHEN q.status = 'accepted' THEN 'ACCEPTED'
      WHEN ${IS_EXPIRED_SQL}     THEN 'EXPIRED'
      ELSE 'QUOTED' END)
    WHEN ${o}.cancelled_at IS NOT NULL OR ${o}.stage = 'cancelled' THEN 'CANCELLED'
    WHEN ${canon} = 'completed' THEN (CASE WHEN COALESCE(${openTickets}, 0) > 0 THEN 'AFTER_SALES' ELSE 'COMPLETED' END)
    WHEN ${canon} = 'ready'         THEN 'READY'
    WHEN ${canon} = 'in_production' THEN 'IN_PRODUCTION'
    WHEN NOT ${depositSatisfiedSql(o, accountTerms)} THEN 'AWAITING_DEPOSIT'
    WHEN ${proofBlockingSql(o)}     THEN 'AWAITING_PROOF'
    ELSE 'READY_TO_PRODUCE' END)`;
}

/**
 * OVERDUE flag (a deadline passed): quote SLA breached while pricing, due date
 * passed on an active order, or an accepted quote's validity passed before the
 * order was created. Money owed at collection is BALANCE_DUE, not overdue.
 * @param {string} stateSql the job-state expression (jobStateSql)
 */
export function overdueSql(stateSql, { o = 'o' } = {}) {
  return `(
    (${stateSql} = 'PRICING' AND q.sla_remind_at IS NOT NULL AND q.sla_remind_at <= NOW())
    OR (${o}.id IS NOT NULL AND ${stateSql} NOT IN (${list(TERMINAL_JOB_STATES)}, 'AFTER_SALES')
        AND ${o}.estimated_completion_date IS NOT NULL AND ${o}.estimated_completion_date < ${SA_TODAY_SQL})
    OR (${stateSql} = 'ACCEPTED' AND ${PAST_VALIDITY_SQL})
  )`;
}

/** BALANCE_DUE flag: ready for collection / delivery but not paid in full. */
export function balanceDueSql(stateSql, { o = 'o' } = {}) {
  return `(${stateSql} = 'READY' AND NOT ${paidInFullSql(o)})`;
}

/** WITH_CONSULTANT flag: the client's open conversation is waiting for a person. */
export const clientWaitingSql = (stateCol) => `(${stateCol} = ${lit(CLIENT_WAITING_STATE)})`;

/**
 * The dashboard queue of a job row (machines.js JOB_QUEUES), or NULL. Reads
 * columns of an already-derived row `b`: state, approved_at, created_at,
 * expires_on, due_date, balance_due.
 */
export function queueSql(b = 'b') {
  return `(CASE
    WHEN ${b}.state = 'ACCEPTED'         THEN 'accepted'
    WHEN ${b}.state = 'PRICING'          THEN 'pricing'
    WHEN ${b}.state = 'QUOTED' AND (COALESCE(${b}.approved_at, ${b}.created_at) <= NOW() - interval '${FOLLOW_UP_DAYS} days'
                                  OR ${b}.expires_on <= ${SA_TODAY_SQL} + ${EXPIRING_DAYS}) THEN 'follow_up'
    WHEN ${b}.state = 'AWAITING_DEPOSIT' THEN 'deposit'
    WHEN ${b}.state = 'AWAITING_PROOF'   THEN 'proof'
    WHEN ${b}.state = 'READY_TO_PRODUCE' THEN 'produce'
    WHEN ${b}.state = 'IN_PRODUCTION' AND ${b}.due_date IS NOT NULL AND ${b}.due_date <= ${SA_TODAY_SQL} + ${DUE_SOON_DAYS} THEN 'due_soon'
    WHEN ${b}.state = 'READY' AND ${b}.balance_due THEN 'ready'
    WHEN ${b}.state = 'AFTER_SALES'      THEN 'after_sales'
    ELSE NULL END)`;
}

/** UNASSIGNED flag: no owner on an active job. */
export function unassignedSql(stateSql, { o = 'o' } = {}) {
  return `(COALESCE(${o}.assigned_staff_id, q.assigned_staff_id) IS NULL AND ${stateSql} NOT IN (${list(TERMINAL_JOB_STATES)}))`;
}

export const humanStateSql = (stateCol) => `(${stateCol} IN (${list(HUMAN_STATES)}))`;

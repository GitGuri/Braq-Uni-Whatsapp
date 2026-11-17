/**
 * Order stage guards — the business rules that block an advance. Pure.
 *
 *   HOLD             any advance while on hold            (not overridable)
 *   PROOF_PENDING    → in_production while a proof is out (overridable)
 *   DEPOSIT_REQUIRED → in_production before the deposit   (overridable;
 *                      never applies to clients on account terms)
 *   BALANCE_DUE      → completed before paid in full      (overridable)
 *
 * Overrides need the 'order.override' permission (admin / manager) and a
 * reason of at least OVERRIDE_REASON_MIN characters; they are recorded in
 * order_stage_history (override_reason, overridden_guards).
 */
import { can } from '../../core/rbac.js';
import { isPaidInFull, depositSatisfied, PROOF_BLOCKING } from './machines.js';

export const OVERRIDE_REASON_MIN = 5;

export const GUARDS = Object.freeze({
  HOLD:             { overridable: false, message: 'The order is on hold — release the hold before moving it on' },
  PROOF_PENDING:    { overridable: true,  message: 'Design proof is awaiting client approval — cannot start production yet' },
  DEPOSIT_REQUIRED: { overridable: true,  message: 'The deposit has not been recorded — record it before starting production' },
  BALANCE_DUE:      { overridable: true,  message: 'The order is not paid in full — record the balance before marking it collected' },
});

const fail = (code, message = GUARDS[code].message) => ({ ok: false, code, message, overridable: GUARDS[code].overridable });

/**
 * Every guard that blocks moving `order` to stage `to` (empty array → allowed).
 * @param {{ is_on_hold?: boolean, proof_status?: string, payment_status?: string, account_terms?: boolean }} order
 * @param {string} to target canonical stage
 * @returns {{ ok: false, code: string, message: string, overridable: boolean }[]}
 */
export function advanceGuards(order, to) {
  const out = [];
  if (order.is_on_hold) out.push(fail('HOLD'));
  if (to === 'in_production') {
    if (PROOF_BLOCKING.includes(order.proof_status || 'none')) {
      out.push(fail('PROOF_PENDING', order.proof_status === 'revision_requested'
        ? 'Client requested proof revisions — send an updated proof and get approval before production'
        : GUARDS.PROOF_PENDING.message));
    }
    if (!depositSatisfied(order)) out.push(fail('DEPOSIT_REQUIRED'));
  }
  if (to === 'completed' && !isPaidInFull(order.payment_status)) out.push(fail('BALANCE_DUE'));
  return out;
}

/** One guard check as { ok, code, message, overridable } (first failure, or ok). */
export function checkAdvance(order, to) {
  const [first] = advanceGuards(order, to);
  return first || { ok: true };
}

/** Guard failures as the API reports them: [{ code, message, overridable }]. */
export const blockersOf = (failures) => failures.map(({ code, message, overridable }) => ({ code, message, overridable }));

/**
 * Decide an advance request.
 * @param {object} order
 * @param {string} to
 * @param {{ override?: { reason?: string } | null, staff?: { role?: string } | null }} req
 * @returns {{ ok: true, overridden: string[] }
 *         | { ok: false, status: number, body: { error: string, code: string, overridable?: boolean, guards?: string[], blockers?: object[] } }}
 *   `guards` lists every blocking guard's code, `blockers` the same guards with their messages.
 */
export function evaluateAdvance(order, to, { override = null, staff = null } = {}) {
  const failures = advanceGuards(order, to);
  if (!failures.length) return { ok: true, overridden: [] };
  const guards = failures.map((f) => f.code);
  const blockers = blockersOf(failures);

  const hard = failures.find((f) => !f.overridable);
  if (hard) return { ok: false, status: 409, body: { error: hard.message, code: hard.code, overridable: false, guards, blockers } };

  if (!override) {
    return { ok: false, status: 409, body: { error: failures[0].message, code: failures[0].code, overridable: true, guards, blockers } };
  }
  const reason = typeof override.reason === 'string' ? override.reason.trim() : '';
  if (reason.length < OVERRIDE_REASON_MIN) {
    return { ok: false, status: 400, body: { error: `An override needs a reason of at least ${OVERRIDE_REASON_MIN} characters`, code: 'OVERRIDE_REASON_REQUIRED' } };
  }
  if (!can(staff, 'order.override')) {
    return { ok: false, status: 403, body: { error: 'Only an admin or manager can override this step', code: 'OVERRIDE_FORBIDDEN', guards, blockers } };
  }
  return { ok: true, overridden: guards, reason };
}

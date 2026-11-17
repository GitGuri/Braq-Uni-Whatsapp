// Design proofs: the client approves the proof or asks for changes. Understood
// in proof_review AND anywhere else while the client has a proof waiting
// (orders.proof_status = 'sent'): "approve", "changes: make the logo bigger"
// (recorded straight away), "changes" (then asks what to change); "yes",
// "looks good", 👍 ask "Approve this design? Reply approve or changes". The
// order's owner (or the consultants) get an email either way.
import { query } from '../../../core/db.js';
import { HttpError } from '../../../core/errors.js';
import { logger } from '../../../core/logger.js';
import { TEMPLATES } from '../templates.js';
import { updateProofStatus } from '../../orders/service.js';
import { notifyProofFeedback } from '../../notifications/service.js';
import { isDepositPaid } from '../../lifecycle/machines.js';
import { pendingProofOrder, isAccountClient } from '../lookups.js';

// Tolerant of "approve", "approved", "I approve the embroidery", "yes, approve";
// a negation like "I don't approve" does not match.
export const PROOF_APPROVE_RE = /^(yes|yep|yeah|ok|okay)?[\s,!.]*(i\s+)?(approve|approved)\b/i;
export const PROOF_REVISE_RE  = /^(revis(e|ed|ion|ions)?|changes?|change it|edits?|amend(ments?)?)\b|^i.*need.*change|^please.*change/i;
export const PROOF_AFFIRM_RE  = /^(yes|yep|yeah|yebo|ok|okay|looks (good|great|fine|perfect|nice)|perfect|great|love it|i love it|happy with (it|this|that)|all good|good|nice)[\s!.👍😊🙏]*$|^(👍|👌|✅|❤️|🔥)+$/iu;

/** "changes: make the logo bigger" / "revise - bigger logo" → "make the logo bigger"; bare "changes" → null. */
export function inlineRevision(text) {
  const m = /^(?:revis(?:e|ed|ion|ions)?|changes?|edits?|amend(?:ments?)?)\b(?:\s*please)?\s*[:\-–—,]?\s*(.*)$/is.exec(String(text ?? '').trim());
  const rest = m ? m[1].trim() : '';
  return rest.length >= 5 ? rest : null;
}

/** Menu-type states a client returns to after answering a proof (anything else → main menu). */
const RETURNABLE = new Set(['main_menu', 'retail_menu', 'corporate_menu']);
const returnState = (ctx) => (RETURNABLE.has(ctx?.proofReturnState) ? ctx.proofReturnState : 'main_menu');

async function approve(c, order, { leaveState = false } = {}) {
  try {
    await updateProofStatus(order.id, 'approved');
  } catch (err) {
    if (!(err instanceof HttpError) || err.status >= 500) throw err;
    logger.info('Proof approval refused (already answered?)', { orderId: order.id, error: err.message });
    c.setState('main_menu', { proofOrderId: null, pending: null });
    return c.R(TEMPLATES.MAIN_MENU, { name: c.client.name });
  }
  if (!leaveState) c.setState(returnState(c.convo.context), { proofOrderId: null, proofReturnState: null, pending: null });
  else c.setState(c.state, { pending: null });
  c.notify(notifyProofFeedback, order, c.client, { status: 'approved' });
  return c.R(TEMPLATES.PROOF_APPROVED, {
    reference: order.reference,
    depositPaid: isDepositPaid(order.payment_status),
    account: isAccountClient(c.client),
  });
}

async function recordRevision(c, order, notes, { leaveState = false } = {}) {
  let updated = null;
  try {
    updated = await updateProofStatus(order.id, 'revision_requested', notes);
  } catch (err) {
    if (!(err instanceof HttpError) || err.status >= 500) throw err;
    logger.info('Proof revision refused (already answered?)', { orderId: order.id, error: err.message });
  }
  if (!leaveState) c.setState(returnState(c.convo.context), { proofOrderId: null, proofReturnState: null, pending: null });
  else c.setState(c.state, { pending: null });
  if (updated) c.notify(notifyProofFeedback, updated, c.client, { status: 'revision_requested', notes });
  return c.R(TEMPLATES.PROOF_REVISION_REQUESTED, { reference: order.reference });
}

function askWhatToChange(c, order, from) {
  c.setState('proof_revision_describe', {
    proofOrderId: order.id, pending: null,
    proofReturnState: RETURNABLE.has(from) ? from : (c.convo.context.proofReturnState ?? null),
  });
  return c.R(TEMPLATES.PROOF_REVISION_ASK, { reference: order.reference });
}

/**
 * Answer to a proof. Returns false when the text is not about the proof (the
 * caller carries on), true once handled. inProofState: in proof_review.
 */
export async function handleProofReply(c, order, { inProofState = false } = {}) {
  const t = c.body.trim();
  if (PROOF_APPROVE_RE.test(t)) {
    await approve(c, order, { leaveState: !inProofState });
    return true;
  }
  if (PROOF_REVISE_RE.test(t)) {
    const notes = inlineRevision(t);
    if (notes) await recordRevision(c, order, notes, { leaveState: !inProofState });
    else askWhatToChange(c, order, inProofState ? null : c.state);
    return true;
  }
  if (PROOF_AFFIRM_RE.test(t)) {
    c.setState(c.state, { pending: { kind: 'proof_confirm', orderId: order.id } });
    c.R(TEMPLATES.PROOF_CONFIRM, { reference: order.reference });
    return true;
  }
  return false;
}

/** Outside proof_review: is this message about a proof the client still has to answer? (true = handled) */
export async function globalProofReply(c) {
  const t = c.body.trim();
  if (!PROOF_APPROVE_RE.test(t) && !PROOF_REVISE_RE.test(t) && !PROOF_AFFIRM_RE.test(t)) return false;
  const order = await pendingProofOrder(c.client.id);
  if (!order) return false;
  return handleProofReply(c, order, { inProofState: false });
}

/** The answer to "Approve this design? Reply approve or changes". (true = handled) */
export async function proofConfirmReply(c, { orderId }) {
  const { rows } = await query(`SELECT * FROM orders WHERE id = $1 AND client_id = $2 AND proof_status = 'sent'`, [orderId, c.client.id]);
  if (!rows.length) return false;
  const t = c.body.trim();
  if (PROOF_AFFIRM_RE.test(t)) {
    await approve(c, rows[0], { leaveState: c.state !== 'proof_review' });
    return true;
  }
  return handleProofReply(c, rows[0], { inProofState: c.state === 'proof_review' });
}

const backToMenu = (c) => {
  c.setState('main_menu', { proofOrderId: null });
  return c.R(TEMPLATES.MAIN_MENU, { name: c.client.name });
};

export async function proofReview(c) {
  const orderId = c.convo.context.proofOrderId;
  let order = null;
  if (orderId) {
    const { rows } = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
    order = rows[0] ?? null;
  }
  if (!order || order.proof_status !== 'sent') order = await pendingProofOrder(c.client.id);
  if (!order) return backToMenu(c);

  if (await handleProofReply(c, order, { inProofState: true })) return;
  // Re-prompt
  return c.R(TEMPLATES.PROOF_SENT, {
    reference: order.reference,
    proofUrl:  order.proof_url,
    notes:     order.proof_notes,
  });
}

export async function proofRevisionDescribe(c) {
  const orderId = c.convo.context.proofOrderId;
  const notes   = c.body.trim();
  const { rows } = orderId ? await query('SELECT * FROM orders WHERE id = $1', [orderId]) : { rows: [] };
  if (!rows.length) return backToMenu(c);
  if (notes.length < 5) return c.R(TEMPLATES.PROOF_REVISION_ASK, { reference: rows[0].reference });
  return recordRevision(c, rows[0], notes);
}

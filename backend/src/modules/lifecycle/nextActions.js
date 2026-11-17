/**
 * nextActions(job, staff) — what staff can do next on a job, for the dashboard
 * to render (no business rules in the UI). Pure.
 *
 * Each action: { key, label, enabled, primary?, reason?, code?, requiresOverride?,
 *                overrideAllowed?, blockers?, inputs?: [{ name, type, required, label, default?, options?, showIf? }],
 *                endpoint?: { method, path, body? } }
 * Disabled actions carry `reason` (+ `code`) and `blockers` (every guard that
 * blocks them, with its message); a disabled action that a manager may push
 * through has requiresOverride: true and overrideAllowed (by role).
 * Input types: text, url, money, date, select, checkbox, hidden, lineItems.
 * `showIf: 'otherInput'` shows an input only while that checkbox is ticked.
 */
import { can } from '../../core/rbac.js';
import { advanceGuards, blockersOf } from './guards.js';
import { toCanonicalStage, PROOF_BLOCKING, depositSatisfied } from './machines.js';
import { formatRand } from '../../core/money.js';

export const ACTION_LABELS = {
  price_quote:         'Price & send quote',
  send_quote:          'Send quote',
  resend_quote:        'Resend quote PDF',
  accept_and_order:    'Client accepted — create order',
  mark_accepted:       'Mark accepted',
  mark_declined:       'Mark declined',
  revise_quote:        'Revise quote',
  create_order:        'Create order',
  record_po:           'Purchase order',
  record_deposit:      'Record deposit',
  send_proof:          'Send design proof',
  mark_proof_approved: 'Approve design',
  mark_proof_revision: 'Client wants changes',
  start_production:    'Start production',
  mark_ready:          'Mark ready',
  record_balance:      'Record balance',
  mark_collected:      'Mark collected',
  open_ticket:         'Open ticket',
  resolve_ticket:      'Resolve ticket',
  release_hold:        'Release hold',
};

/** mark_collected's label when the order goes out by courier. */
export const MARK_DELIVERED_LABEL = 'Mark delivered';

const NOTES = { name: 'notes', type: 'text', required: false, label: 'Notes' };
const PO_NUMBER = { name: 'poNumber', type: 'text', required: false, label: 'Purchase order number' };
const DUE_DATE = { name: 'estimatedCompletion', type: 'date', required: false, label: 'Due date' };
/** Offered when the action itself clears the last thing blocking production. */
const START_NOW = [
  { name: 'startProduction', type: 'checkbox', required: false, label: 'Start production now', default: false },
  { ...DUE_DATE, showIf: 'startProduction' },
];
const TICKET_CATEGORIES = ['wrong_item', 'defective', 'missing_item', 'account_query', 'other'];
const money = (cents) => (cents == null ? null : Math.max(0, cents) / 100);

/**
 * @param {{
 *   state: string, flags?: string[], quotation?: object|null, order?: object|null,
 *   money?: { depositCents?: number|null, totalCents?: number|null, paidCents?: number },
 *   openTickets?: object[]  // open/in-progress ticket rows (id, …)
 * }} job   order rows carry the client's account_terms
 * @param {{ role?: string }|null} staff the caller
 * @returns {object[]}
 */
export function nextActions(job, staff) {
  const { state, flags = [], quotation = null, order = null, money: m = {}, openTickets = [] } = job || {};
  const actions = [];
  const qid = quotation?.id;
  const oid = order?.id;
  const onHold = flags.includes('ON_HOLD') || Boolean(order?.is_on_hold);
  const mayOverride = can(staff, 'order.override');
  const paid = m.paidCents ?? 0;
  const depositDue = m.depositCents != null ? Math.max(0, m.depositCents - paid) : null;
  const outstanding = m.totalCents != null ? Math.max(0, m.totalCents - paid) : null;

  const add = (key, extra = {}) => {
    const a = { key, label: ACTION_LABELS[key], enabled: true, ...extra };
    if (a.enabled) { delete a.reason; delete a.code; delete a.blockers; }
    actions.push(a);
    return a;
  };

  /**
   * A stage advance, disabled with the guards' reasons when any blocks it.
   * `ignore`: guard codes the action's own inputs can clear (e.g. a balance
   * recorded with "Mark collected") — they do not disable it.
   */
  const advance = (key, to, inputs, primary, { ignore = [], label } = {}) => {
    const failures = order
      ? advanceGuards(order, to).filter((g) => !ignore.includes(g.code))
      : [{ ok: false, code: 'NO_ORDER', message: 'No order yet', overridable: false }];
    const extra = { primary, inputs, endpoint: { method: 'POST', path: `/api/orders/${oid}/advance` }, ...(label ? { label } : {}) };
    if (!failures.length) return add(key, extra);
    const overridable = failures.every((g) => g.overridable);
    return add(key, {
      ...extra,
      primary: false,
      enabled: false,
      reason: failures[0].message,
      code: failures[0].code,
      blockers: blockersOf(failures),
      requiresOverride: overridable,
      overrideAllowed: overridable && mayOverride,
    });
  };

  const statusEndpoint = (status) => ({ method: 'PATCH', path: `/api/quotations/${qid}/status`, body: { status } });
  const proofInput = [
    { name: 'proofUrl', type: 'url', required: true, label: 'Proof link' },
    NOTES,
  ];
  const paymentInputs = (type, defCents, extra = []) => [
    { name: 'amount', type: 'money', required: true, label: 'Amount (R)', default: money(defCents) },
    { name: 'type', type: 'hidden', required: true, default: type },
    NOTES,
    ...extra,
  ];
  const convert = (body) => ({ method: 'POST', path: `/api/orders/convert-from-quotation/${qid}`, ...(body ? { body } : {}) });
  const proofApproved = (primary) => {
    // Approving clears the last block when the deposit is in (or not needed).
    const clearsLast = !onHold && depositSatisfied(order);
    return add('mark_proof_approved', {
      primary,
      inputs: [NOTES, ...(clearsLast ? START_NOW : [])],
      endpoint: { method: 'PATCH', path: `/api/orders/${oid}/proof/status`, body: { status: 'approved' } },
    });
  };
  const ticketInputs = [
    { name: 'category', type: 'select', required: true, label: 'Category', options: TICKET_CATEGORIES },
    { name: 'description', type: 'text', required: true, label: 'Description' },
  ];
  const openTicket = () => add('open_ticket', {
    inputs: ticketInputs,
    endpoint: { method: 'POST', path: '/api/tickets', body: { orderId: oid, clientId: order?.client_id } },
  });
  const resolveTickets = (primaryFirst) => {
    for (const [i, t] of openTickets.entries()) {
      add('resolve_ticket', {
        primary: primaryFirst && i === 0,
        ticketId: t.id,
        inputs: [{ name: 'resolutionNote', type: 'text', required: false, label: 'Resolution note' }],
        endpoint: { method: 'PATCH', path: `/api/tickets/${t.id}`, body: { status: 'resolved' } },
      });
    }
  };

  switch (state) {
    case 'PRICING':
      add('price_quote', {
        primary: true,
        inputs: [{ name: 'lineItems', type: 'lineItems', required: true, label: 'Line items' }],
        endpoint: { method: 'POST', path: `/api/quotations/${qid}/approve` },
      });
      add('mark_declined', { endpoint: statusEndpoint('rejected') });
      break;

    case 'QUOTED':
      // One step: the client said yes → mark the quote accepted and create the order.
      add('accept_and_order', { primary: true, inputs: [PO_NUMBER], endpoint: convert({ accept: true }) });
      add('resend_quote', { endpoint: { method: 'POST', path: `/api/quotations/${qid}/resend` } });
      add('mark_declined', { endpoint: statusEndpoint('rejected') });
      add('revise_quote', { endpoint: statusEndpoint('draft') });
      break;

    case 'EXPIRED':
    case 'DECLINED':
      add('revise_quote', { primary: true, endpoint: statusEndpoint('draft') });
      break;

    case 'ACCEPTED':
      add('create_order', { primary: true, inputs: [PO_NUMBER], endpoint: convert() });
      add('mark_declined', { endpoint: statusEndpoint('rejected') });
      break;

    case 'AWAITING_DEPOSIT': {
      const proofOut = PROOF_BLOCKING.includes(order?.proof_status || 'none');
      // The deposit clears the last block unless a proof is out or the order is on hold.
      add('record_deposit', {
        primary: true,
        inputs: paymentInputs('deposit', depositDue, !proofOut && !onHold ? START_NOW : []),
        endpoint: { method: 'POST', path: `/api/orders/${oid}/payments` },
      });
      if (!proofOut) {
        add('send_proof', { inputs: proofInput, endpoint: { method: 'POST', path: `/api/orders/${oid}/proof` } });
      } else {
        proofApproved(false);
      }
      advance('start_production', 'in_production', [DUE_DATE, NOTES], false);
      break;
    }

    case 'AWAITING_PROOF':
      proofApproved(true);
      if (order?.proof_status === 'sent') {
        add('mark_proof_revision', {
          inputs: [{ ...NOTES, required: true, label: 'What should change?' }],
          endpoint: { method: 'PATCH', path: `/api/orders/${oid}/proof/status`, body: { status: 'revision_requested' } },
        });
      }
      add('send_proof', { inputs: proofInput, endpoint: { method: 'POST', path: `/api/orders/${oid}/proof` } });
      advance('start_production', 'in_production', [DUE_DATE, NOTES], false);
      break;

    case 'READY_TO_PRODUCE':
      advance('start_production', 'in_production', [DUE_DATE, NOTES], true);
      if (toCanonicalStage(order?.stage) === 'deposit_pending') {
        add('send_proof', { inputs: proofInput, endpoint: { method: 'POST', path: `/api/orders/${oid}/proof` } });
      }
      break;

    case 'IN_PRODUCTION':
      advance('mark_ready', 'ready', [
        { name: 'deliveryType', type: 'select', required: true, label: 'Collection or delivery', default: 'collection', options: ['collection', 'delivery'] },
        { name: 'trackingNumber', type: 'text', required: false, label: 'Tracking number' },
        NOTES,
      ], true);
      if (outstanding == null || outstanding > 0) {
        add('record_balance', { inputs: paymentInputs('balance', outstanding), endpoint: { method: 'POST', path: `/api/orders/${oid}/payments` } });
      }
      break;

    case 'READY': {
      // Mark collected / delivered records the balance received at the counter in
      // the same step; the BALANCE_DUE guard still applies to what is left owing.
      const owes = outstanding == null ? order?.payment_status !== 'paid_in_full' : outstanding > 0;
      const delivered = order?.delivery_type === 'delivery';
      const inputs = [
        ...(owes ? [{ name: 'balanceAmount', type: 'money', required: false, label: 'Balance received now (R)', default: money(outstanding) }] : []),
        NOTES,
      ];
      const done = advance('mark_collected', 'completed', inputs, true, {
        ignore: owes ? ['BALANCE_DUE'] : [],
        label: delivered ? MARK_DELIVERED_LABEL : ACTION_LABELS.mark_collected,
      });
      if (owes) done.balanceDue = money(outstanding);
      break;
    }

    case 'COMPLETED':
      openTicket();
      break;

    case 'AFTER_SALES':
      resolveTickets(true);
      openTicket();
      break;

    default:
      break;
  }

  // Open tickets can be resolved whatever state the job is in.
  if (state !== 'AFTER_SALES' && openTickets.length) resolveTickets(false);

  if (onHold && order) {
    for (const a of actions) a.primary = false;
    actions.unshift({
      key: 'release_hold',
      label: ACTION_LABELS.release_hold,
      enabled: true,
      primary: true,
      endpoint: { method: 'PATCH', path: `/api/orders/${oid}/hold`, body: { isOnHold: false } },
    });
  }

  // Exactly one primary when anything is enabled: the first enabled action wins if none was marked.
  if (!actions.some((a) => a.primary && a.enabled)) {
    for (const a of actions) a.primary = false;
    const first = actions.find((a) => a.enabled);
    if (first) first.primary = true;
  } else {
    let seen = false;
    for (const a of actions) {
      if (a.primary && a.enabled && !seen) { seen = true; continue; }
      a.primary = false;
    }
  }
  return actions;
}

/**
 * The primary action when it can be done in one click (no input to fill: no
 * required input and nothing prefilled that the user should check) — for the
 * dashboard / board rows. → { key, label, endpoint, ticketId? } | null
 */
export function oneClickAction(actions) {
  const a = (actions || []).find((x) => x.primary && x.enabled);
  if (!a || !a.endpoint) return null;
  const inputs = (a.inputs ?? []).filter((i) => i.type !== 'hidden');
  const needsInput = inputs.some((i) => i.required || i.type === 'lineItems'
    || (i.type !== 'checkbox' && i.default !== undefined && i.default !== null));
  if (needsInput) return null;
  return { key: a.key, label: a.label, endpoint: a.endpoint, ...(a.ticketId ? { ticketId: a.ticketId } : {}) };
}

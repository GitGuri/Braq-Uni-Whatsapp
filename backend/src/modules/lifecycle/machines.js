/**
 * Every state machine of the job lifecycle, as data — the single source for
 * quotation statuses, order stages (incl. legacy aliases), payment / proof /
 * ticket statuses, conversation (bot) states and the derived job states.
 * Pure: no DB, no I/O. Served to the dashboard by GET /api/meta.
 */

// ── Quotations ───────────────────────────────────────────────────────────────
export const QUOTATION_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'];

export const QUOTATION_STATUS_LABELS = {
  draft: 'Pricing', sent: 'Sent', accepted: 'Accepted', rejected: 'Declined', expired: 'Expired',
};

/**
 * target status → { from: allowed source statuses, noOrder: refused once an order
 * exists, withinValidity: refused when the quote is past its validity date }.
 * 'draft' from sent/rejected/expired is "revise".
 */
export const QUOTATION_TRANSITIONS = Object.freeze({
  draft:    { from: ['sent', 'rejected', 'expired'], noOrder: true },
  sent:     { from: ['draft'] },
  accepted: { from: ['sent'], withinValidity: true },
  rejected: { from: ['draft', 'sent', 'accepted', 'expired'], noOrder: true },
  expired:  { from: ['sent'] },
});

/**
 * Can a quotation move `from` → `to`?
 * @param {{ hasOrder?: boolean, pastValidity?: boolean }} facts
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function quotationTransition(from, to, { hasOrder = false, pastValidity = false } = {}) {
  const rule = QUOTATION_TRANSITIONS[to];
  if (!rule) return { ok: false, code: 'INVALID_STATUS', message: `Invalid status: ${to}` };
  // A 'sent' quotation past its validity is reported (and treated) as expired.
  const effective = from === 'sent' && pastValidity ? 'expired' : from;
  if (rule.noOrder && hasOrder) {
    return { ok: false, code: 'ORDER_EXISTS', message: `Cannot change quotation status from '${effective}' to '${to}' — an order already exists for it` };
  }
  if (rule.withinValidity && (effective === 'expired' || pastValidity)) {
    return { ok: false, code: 'QUOTE_EXPIRED', message: `Cannot change quotation status from '${effective}' to '${to}' — the quotation has expired` };
  }
  if (!rule.from.includes(from)) {
    return { ok: false, code: 'INVALID_TRANSITION', message: `Cannot change quotation status from '${effective}' to '${to}'` };
  }
  return { ok: true };
}

/** A client may accept a quotation that was sent and is still within its validity. */
export const canClientAccept = (quotation) =>
  Boolean(quotation) && quotation.status === 'sent' && !quotation.past_validity && !quotation.is_expired;

// ── Order stages ─────────────────────────────────────────────────────────────
export const ORDER_STAGES = ['deposit_pending', 'in_production', 'ready', 'completed'];

/** Staff-facing labels (dashboard). */
export const STAGE_LABELS = {
  deposit_pending: 'Awaiting deposit',
  in_production:   'In production',
  ready:           'Ready',
  completed:       'Completed',
};

export const STAGE_META = [
  { key: 'deposit_pending', label: STAGE_LABELS.deposit_pending, short: 'Deposit',    description: 'Waiting for the client to pay the deposit' },
  { key: 'in_production',   label: STAGE_LABELS.in_production,   short: 'Production', description: 'Being made, branded and checked' },
  { key: 'ready',           label: STAGE_LABELS.ready,           short: 'Ready',      description: 'Packed — ready for collection or dispatch' },
  { key: 'completed',       label: STAGE_LABELS.completed,       short: 'Done',       description: 'Collected or delivered' },
];

/**
 * Orders created before the pipeline was collapsed to 4 stages may still carry
 * one of the old 10-stage values. They are mapped (never rewritten in the DB) so
 * they can be displayed, tracked and advanced like any other order.
 */
export const LEGACY_STAGE_MAP = Object.freeze({
  quotation_requested:     'deposit_pending',
  quotation_submitted:     'deposit_pending',
  po_received:             'deposit_pending',
  purchase_order_received: 'deposit_pending',
  design_approval_pending: 'deposit_pending',
  materials_procurement:   'in_production',
  production_scheduled:    'in_production',
  manufacturing:           'in_production',
  branding_embroidery:     'in_production',
  quality_control:         'in_production',
  packing_dispatch:        'ready',
});

/** Customer-facing (WhatsApp) stage names, incl. the legacy pipeline values. */
export const CLIENT_STAGE_LABELS = {
  deposit_pending:         'Awaiting Deposit',
  in_production:           'In Production',
  ready:                   'Ready / Dispatched',
  completed:               'Completed',
  quotation_requested:     'Quotation Requested',
  quotation_submitted:     'Quotation Sent',
  po_received:             'Order Confirmed',
  purchase_order_received: 'Order Confirmed',
  design_approval_pending: 'Awaiting Design Approval',
  materials_procurement:   'Sourcing Materials',
  production_scheduled:    'Scheduled for Production',
  manufacturing:           'In Production',
  branding_embroidery:     'Branding & Embroidery',
  quality_control:         'Quality Control',
  packing_dispatch:        'Packing & Dispatch',
};

/** Canonical 4-stage name for a (possibly legacy) stage, or null if unknown. */
export function toCanonicalStage(stage) {
  if (ORDER_STAGES.includes(stage)) return stage;
  return LEGACY_STAGE_MAP[stage] ?? null;
}

/** The stage after `stage` (canonical or legacy), or null at the end / for unknown stages. */
export function nextStage(stage) {
  const idx = ORDER_STAGES.indexOf(toCanonicalStage(stage));
  if (idx === -1 || idx === ORDER_STAGES.length - 1) return null;
  return ORDER_STAGES[idx + 1];
}

/** Staff label for a stage (legacy values report the stage they map to). */
export function stageLabelFor(stage) {
  const c = toCanonicalStage(stage);
  return c ? STAGE_LABELS[c] : String(stage ?? '').replace(/_/g, ' ');
}

// ── Payments ─────────────────────────────────────────────────────────────────
// orders.payment_status only ever moves forward. Legacy rows may carry
// 'deposit_required' (≈ unpaid) or 'not_required' (nothing owed).
export const PAYMENT_STATUSES = ['unpaid', 'deposit_paid', 'paid_in_full'];
export const LEGACY_PAYMENT_STATUSES = ['deposit_required', 'not_required'];
export const PAYMENT_STATUS_LABELS = {
  unpaid: 'Unpaid', deposit_paid: 'Deposit paid', paid_in_full: 'Paid in full',
  deposit_required: 'Deposit required', not_required: 'No payment required',
};
export const PAYMENT_TYPES = ['deposit', 'balance', 'full'];
export const PAYMENT_RANK = { unpaid: 0, deposit_required: 0, deposit_paid: 1, paid_in_full: 2, not_required: 2 };

/** Deposit recorded (or nothing owed). */
export const isDepositPaid = (paymentStatus) => (PAYMENT_RANK[paymentStatus] ?? 0) >= 1;
/**
 * No deposit is needed before production: it was paid, or the client trades on
 * account terms (orders rows carry the client's `account_terms`).
 */
export const depositSatisfied = (order) => Boolean(order?.account_terms) || isDepositPaid(order?.payment_status);
/** Paid in full (or nothing owed). */
export const isPaidInFull = (paymentStatus) => (PAYMENT_RANK[paymentStatus] ?? 0) >= 2;

// ── Design proofs ────────────────────────────────────────────────────────────
export const PROOF_STATUSES = ['none', 'sent', 'approved', 'revision_requested'];
export const PROOF_STATUS_LABELS = {
  none: 'No proof', sent: 'Awaiting approval', approved: 'Approved', revision_requested: 'Changes requested',
};
/** Proof states that block production: out with the client, or changes requested. */
export const PROOF_BLOCKING = ['sent', 'revision_requested'];

/**
 * from → allowed targets. 'sent' → 'sent' replaces a pending proof with a new
 * one; an approved proof may only be replaced before production starts.
 */
export const PROOF_TRANSITIONS = Object.freeze({
  none:               ['sent'],
  sent:               ['sent', 'approved', 'revision_requested'],
  revision_requested: ['sent'],
  approved:           ['sent'],
});

/**
 * @param {string} from current proof_status
 * @param {string} to   requested proof_status
 * @param {{ stage?: string }} order  the order's (possibly legacy) stage
 */
export function proofTransition(from, to, { stage } = {}) {
  if (!PROOF_STATUSES.includes(to) || to === 'none') {
    return { ok: false, code: 'INVALID_STATUS', message: `Invalid proof status: ${to}` };
  }
  const current = from || 'none';
  if (!(PROOF_TRANSITIONS[current] || []).includes(to)) {
    return { ok: false, code: 'PROOF_TRANSITION', message: `Cannot change the proof from '${current}' to '${to}'` };
  }
  if (current === 'approved' && to === 'sent' && toCanonicalStage(stage) !== 'deposit_pending' && stage != null) {
    return { ok: false, code: 'PROOF_TRANSITION', message: 'The proof was approved and production has started — a new proof can no longer be sent' };
  }
  return { ok: true };
}

// ── Tickets ──────────────────────────────────────────────────────────────────
export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
export const TICKET_STATUS_LABELS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };
export const TICKET_CATEGORIES = ['wrong_item', 'defective', 'missing_item', 'account_query', 'other'];
export const TICKET_CATEGORY_LABELS = {
  wrong_item: 'Wrong item', defective: 'Defective item', missing_item: 'Missing item',
  account_query: 'Account query', other: 'Other',
};
export const OPEN_TICKET_STATUSES = ['open', 'in_progress'];

/** from → allowed targets (setting the current status again is always allowed). */
export const TICKET_TRANSITIONS = Object.freeze({
  open:        ['in_progress', 'resolved', 'closed'],
  in_progress: ['open', 'resolved', 'closed'],
  resolved:    ['closed', 'open'],
  closed:      ['open'],
});

export function ticketTransition(from, to) {
  if (!TICKET_STATUSES.includes(to)) return { ok: false, code: 'INVALID_STATUS', message: `Invalid ticket status: ${to}` };
  if (from === to || (TICKET_TRANSITIONS[from] || []).includes(to)) return { ok: true };
  return { ok: false, code: 'TICKET_TRANSITION', message: `Cannot change the ticket from '${from}' to '${to}'` };
}

// ── Conversations (bot) ──────────────────────────────────────────────────────
/** Conversation states in which a human consultant is (about to be) talking to the client. */
export const HUMAN_STATES = ['awaiting_consultant', 'consultant_active'];

/** Every state the WhatsApp bot puts a conversation in. */
export const BOT_STATES = [
  'main_menu',
  'retail_menu', 'retail_pricing', 'retail_size_ask', 'retail_layby', 'retail_hours',
  'retail_collection_ask', 'retail_school_select',
  'corporate_menu', 'corporate_repeat_order_ask', 'corporate_manufacturing_ask',
  'corporate_delivery_ask', 'corporate_account_query',
  'quotation_ask_description', 'quotation_gathering',
  'order_ask_method', 'order_ask_reference', 'order_gathering', 'order_confirm_quote',
  'order_confirm_direct', 'order_tracking_ask',
  'ticket_ask_category', 'ticket_ask_description',
  'proof_review', 'proof_revision_describe',
  'registration_name', 'registration_org_or_school', 'registration_address',
  ...HUMAN_STATES,
];

// ── Client / product enums ───────────────────────────────────────────────────
export const CLIENT_TYPES = ['retail', 'school', 'corporate', 'hospitality', 'church', 'security', 'government', 'reseller'];
export const PRODUCT_CATEGORIES = ['school_wear', 'knitwear', 'medical_wear', 'outdoor_wear', 'corporate_wear', 'safety_wear'];

// ── Job states (derived; see derive.js) ──────────────────────────────────────
export const JOB_STATES = {
  PRICING:          { label: 'Pricing',            description: 'Quote needs pricing and sending' },
  QUOTED:           { label: 'Quoted',             description: 'Quote sent — waiting for the client' },
  EXPIRED:          { label: 'Expired',            description: 'Quote lapsed before the client accepted' },
  DECLINED:         { label: 'Declined',           description: 'The client declined the quote' },
  ACCEPTED:         { label: 'Accepted',           description: 'The client accepted the quote — create the order' },
  AWAITING_DEPOSIT: { label: 'Awaiting deposit',   description: 'Order created — waiting for the deposit' },
  AWAITING_PROOF:   { label: 'Proof',              description: 'Design proof is with the client' },
  READY_TO_PRODUCE: { label: 'Ready to produce',   description: 'Nothing blocks production — set a due date and start' },
  IN_PRODUCTION:    { label: 'In production',      description: 'Being made, branded and checked' },
  READY:            { label: 'Ready',              description: 'Ready for collection or dispatched' },
  COMPLETED:        { label: 'Completed',          description: 'Collected or delivered' },
  AFTER_SALES:      { label: 'After-sales',        description: 'Completed with an open ticket' },
  CANCELLED:        { label: 'Cancelled',          description: 'The order was cancelled' },
};
export const JOB_STATE_KEYS = Object.keys(JOB_STATES);

/** Journey order shown on the job page (terminal side-states excluded). */
export const JOB_JOURNEY = ['PRICING', 'QUOTED', 'ACCEPTED', 'AWAITING_DEPOSIT', 'AWAITING_PROOF', 'READY_TO_PRODUCE', 'IN_PRODUCTION', 'READY', 'COMPLETED'];

/**
 * Job flags.
 *   WITH_CONSULTANT  the client is waiting for a consultant (conversation awaiting_consultant)
 *   OVERDUE          quote SLA breached while pricing, due date passed, or an
 *                    accepted quote's validity passed before the order was created
 *   BALANCE_DUE      ready for collection / delivery but not paid in full
 */
export const JOB_FLAGS = {
  ON_HOLD:         { label: 'On hold' },
  WITH_CONSULTANT: { label: 'Client waiting' },
  OVERDUE:         { label: 'Overdue' },
  BALANCE_DUE:     { label: 'Balance due' },
  UNASSIGNED:      { label: 'Unassigned' },
};

/** Conversation state in which the client is waiting for a person (WITH_CONSULTANT flag). */
export const CLIENT_WAITING_STATE = 'awaiting_consultant';

/**
 * Dashboard work queues, highest priority first. Each active job sits in at
 * most one (see sql.js queueSql); the dashboard renders them in this order.
 */
export const JOB_QUEUES = [
  { key: 'accepted',   label: 'Client accepted — create order', hint: 'The client said yes — create the order' },
  { key: 'pricing',    label: 'Needs pricing',                  hint: 'Price the quote and send it' },
  { key: 'follow_up',  label: 'Quoted — follow up',             hint: 'Sent over 3 days ago, or expiring within 5 days' },
  { key: 'deposit',    label: 'Awaiting deposit',               hint: 'Order created — chase the deposit' },
  { key: 'proof',      label: 'Proof waiting',                  hint: 'Waiting on the client to approve the design' },
  { key: 'produce',    label: 'Ready to produce',               hint: 'Set a due date and start production' },
  { key: 'due_soon',   label: 'Due soon',                       hint: 'In production, due within 3 days' },
  { key: 'ready',      label: 'Ready — balance owed',           hint: 'Collect the balance when the client collects' },
  { key: 'after_sales', label: 'After-sales',                   hint: 'Completed jobs with an open ticket' },
];
export const JOB_QUEUE_KEYS = JOB_QUEUES.map((q) => q.key);
/** Follow up a sent quote after this many days, or when it expires within EXPIRING_DAYS. */
export const FOLLOW_UP_DAYS = 3;
export const EXPIRING_DAYS = 5;
/** "Due soon": in production with a due date within this many days (or past). */
export const DUE_SOON_DAYS = 3;

/** States where nothing more is expected (no owner needed, never overdue). */
export const TERMINAL_JOB_STATES = ['COMPLETED', 'DECLINED', 'EXPIRED', 'CANCELLED'];

/**
 * Jobs: a job is a quotation plus its order and tickets (no table of its own).
 *  - listJobs: the board (state / queue / owner / overdue / search filters,
 *              counts per state, queue and flag; each row's one-click next action)
 *  - getJob:   everything about one job + merged history timeline + lifecycle
 *  - lifecycleForOrder / lifecycleForQuotation: the `lifecycle` object for detail endpoints
 */
import { query } from '../../core/db.js';
import { HttpError, pageParams } from '../../core/errors.js';
import {
  JOB_STATES, JOB_STATE_KEYS, JOB_QUEUE_KEYS, HUMAN_STATES, OPEN_TICKET_STATUSES, CLIENT_WAITING_STATE,
} from '../lifecycle/machines.js';
import {
  jobStateSql, overdueSql, unassignedSql, balanceDueSql, queueSql,
  PAST_VALIDITY_SQL, IS_EXPIRED_SQL, EXPIRES_ON_SQL,
} from '../lifecycle/sql.js';
import { buildLifecycle, orderMoney, nextActions, oneClickAction } from '../lifecycle/index.js';
import { getQuotationById } from '../quotations/service.js';
import { listSizeEntries } from '../orders/sizes.js';

const OPEN_LIST = OPEN_TICKET_STATUSES.map((s) => `'${s}'`).join(', ');
const OPEN_TICKETS_SQL = `(SELECT COUNT(*)::int FROM tickets t WHERE t.order_id = o.id AND t.status IN (${OPEN_LIST}))`;
const STATE_SQL = jobStateSql({ openTickets: OPEN_TICKETS_SQL, accountTerms: 'c.account_terms' });

const BASE_SQL = `
  SELECT q.id               AS quotation_id,
         o.id               AS order_id,
         q.reference        AS quotation_reference,
         o.reference        AS order_reference,
         q.client_id,
         c.name             AS client_name,
         c.organisation,
         c.whatsapp_number,
         c.account_terms,
         q.total,
         q.status           AS quotation_status,
         q.approved_at,
         ${EXPIRES_ON_SQL}  AS expires_on,
         ${PAST_VALIDITY_SQL} AS past_validity,
         o.estimated_completion_date AS due_date,
         o.stage, o.payment_status, o.proof_status, o.delivery_type,
         o.deposit_amount, o.balance_amount, o.total_amount,
         (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.order_id = o.id) AS paid_amount,
         ARRAY(SELECT t.id FROM tickets t WHERE t.order_id = o.id AND t.status IN (${OPEN_LIST}) ORDER BY t.created_at) AS open_ticket_ids,
         COALESCE(o.assigned_staff_id, q.assigned_staff_id) AS owner_id,
         s.name             AS owner_name,
         GREATEST(q.updated_at, COALESCE(o.updated_at, q.updated_at)) AS updated_at,
         q.created_at,
         COALESCE(o.is_on_hold, false) AS on_hold,
         cv.state           AS conversation_state,
         ${STATE_SQL}       AS state,
         ${overdueSql(STATE_SQL)}    AS overdue,
         ${balanceDueSql(STATE_SQL)} AS balance_due,
         ${unassignedSql(STATE_SQL)} AS unassigned
  FROM quotations q
  JOIN clients c ON c.id = q.client_id
  LEFT JOIN LATERAL (SELECT * FROM orders WHERE quotation_id = q.id ORDER BY created_at DESC LIMIT 1) o ON true
  LEFT JOIN LATERAL (SELECT state FROM conversations WHERE client_id = q.client_id AND is_open = true
                     ORDER BY created_at DESC LIMIT 1) cv ON true
  LEFT JOIN staff s ON s.id = COALESCE(o.assigned_staff_id, q.assigned_staff_id)`;

/** BASE_SQL plus the dashboard queue (from the derived columns, computed once per row). */
const ROWS_SQL = `SELECT b0.*, ${queueSql('b0')} AS queue FROM (${BASE_SQL}) b0`;

function flagsOf(row) {
  const flags = [];
  if (row.on_hold) flags.push('ON_HOLD');
  if (row.conversation_state === CLIENT_WAITING_STATE) flags.push('WITH_CONSULTANT');
  if (row.overdue) flags.push('OVERDUE');
  if (row.balance_due) flags.push('BALANCE_DUE');
  if (row.unassigned) flags.push('UNASSIGNED');
  return flags;
}

/** The row's primary next action when it takes one click (lifecycle oneClickAction), else null. */
function primaryActionOf(row, flags, staff) {
  const quotation = { id: row.quotation_id, status: row.quotation_status, total: row.total, past_validity: row.past_validity };
  const order = row.order_id ? {
    id: row.order_id, client_id: row.client_id, stage: row.stage, payment_status: row.payment_status,
    proof_status: row.proof_status, is_on_hold: row.on_hold, delivery_type: row.delivery_type,
    account_terms: row.account_terms, deposit_amount: row.deposit_amount, balance_amount: row.balance_amount,
    total_amount: row.total_amount,
  } : null;
  const money = orderMoney(order, [{ amount: row.paid_amount }], quotation);
  const openTickets = (row.open_ticket_ids || []).map((id) => ({ id }));
  return oneClickAction(nextActions({ state: row.state, flags, quotation, order, money, openTickets }, staff));
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

/**
 * GET /api/jobs
 * @param {{ state?: string, queue?: string, owner?: 'me'|'unassigned', overdue?: string, search?: string,
 *           clientId?: string, page?, limit? }} filters  state / queue take comma lists
 * @param {{ id: string }} staff the caller (owner=me; decides which actions are one-click)
 * @returns {{ items, total, page, limit, counts, queueCounts, flagCounts }}
 *   counts (per state), queueCounts and flagCounts ignore the state / queue filters and respect the others.
 */
export async function listJobs({ state, queue, owner, overdue, search, clientId, ...paging } = {}, staff) {
  const { page, limit, offset } = pageParams(paging, { defaultLimit: 50, maxLimit: 200 });
  const where = [];
  const params = [];

  if (owner === 'me') { params.push(staff?.id ?? null); where.push(`b.owner_id = $${params.length}`); }
  else if (owner === 'unassigned') where.push('b.owner_id IS NULL');
  else if (owner) throw new HttpError(400, "owner must be 'me' or 'unassigned'");
  if (overdue === 'true') where.push('b.overdue');
  if (clientId) { params.push(clientId); where.push(`b.client_id = $${params.length}`); }
  if (typeof search === 'string' && search.trim()) {
    params.push(`%${escapeLike(search.trim())}%`);
    const p = `$${params.length}`;
    where.push(`(b.quotation_reference ILIKE ${p} OR b.order_reference ILIKE ${p} OR b.client_name ILIKE ${p}
                 OR b.organisation ILIKE ${p} OR b.whatsapp_number ILIKE ${p})`);
  }

  const states = csv(state).map((s) => s.toUpperCase());
  const unknown = states.filter((s) => !JOB_STATE_KEYS.includes(s));
  if (unknown.length) throw new HttpError(400, `Unknown job state: ${unknown.join(', ')}`);
  const queues = csv(queue);
  const unknownQueue = queues.filter((s) => !JOB_QUEUE_KEYS.includes(s));
  if (unknownQueue.length) throw new HttpError(400, `Unknown queue: ${unknownQueue.join(', ')}`);

  const baseWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: countRows } = await query(
    `SELECT b.state, b.queue, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE b.overdue)::int     AS overdue,
            COUNT(*) FILTER (WHERE b.balance_due)::int AS balance_due,
            COUNT(*) FILTER (WHERE b.unassigned)::int  AS unassigned,
            COUNT(*) FILTER (WHERE b.on_hold)::int     AS on_hold,
            COUNT(*) FILTER (WHERE b.conversation_state = '${CLIENT_WAITING_STATE}')::int AS waiting
     FROM (${ROWS_SQL}) b ${baseWhere} GROUP BY b.state, b.queue`,
    params
  );
  const counts = Object.fromEntries(JOB_STATE_KEYS.map((k) => [k, 0]));
  const queueCounts = Object.fromEntries(JOB_QUEUE_KEYS.map((k) => [k, 0]));
  const flagCounts = { OVERDUE: 0, BALANCE_DUE: 0, UNASSIGNED: 0, ON_HOLD: 0, WITH_CONSULTANT: 0 };
  for (const r of countRows) {
    counts[r.state] = (counts[r.state] ?? 0) + r.n;
    if (r.queue) queueCounts[r.queue] += r.n;
    flagCounts.OVERDUE += r.overdue;
    flagCounts.BALANCE_DUE += r.balance_due;
    flagCounts.UNASSIGNED += r.unassigned;
    flagCounts.ON_HOLD += r.on_hold;
    flagCounts.WITH_CONSULTANT += r.waiting;
  }

  const listParams = [...params];
  const listWhere = [...where];
  if (states.length) { listParams.push(states); listWhere.push(`b.state = ANY($${listParams.length}::text[])`); }
  if (queues.length) { listParams.push(queues); listWhere.push(`b.queue = ANY($${listParams.length}::text[])`); }
  const whereSql = listWhere.length ? `WHERE ${listWhere.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT b.* FROM (${ROWS_SQL}) b ${whereSql}
     ORDER BY b.overdue DESC, b.updated_at DESC, b.quotation_id
     LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}`,
    [...listParams, limit, offset]
  );
  const inStates = (r) => !states.length || states.includes(r.state);
  const inQueues = (r) => !queues.length || queues.includes(r.queue);
  const total = countRows.filter((r) => inStates(r) && inQueues(r)).reduce((s, r) => s + r.n, 0);

  const items = rows.map((r) => {
    const flags = flagsOf(r);
    return {
      quotation_id:        r.quotation_id,
      order_id:            r.order_id,
      quotation_reference: r.quotation_reference,
      order_reference:     r.order_reference,
      client_id:           r.client_id,
      client_name:         r.client_name,
      organisation:        r.organisation,
      account_terms:       r.account_terms === true,
      state:               r.state,
      state_label:         JOB_STATES[r.state]?.label ?? r.state,
      flags,
      queue:               r.queue,
      total:               r.total,
      due_date:            r.due_date,
      sent_at:             r.approved_at,
      expires_on:          r.expires_on,
      owner_id:            r.owner_id,
      owner_name:          r.owner_name,
      updated_at:          r.updated_at,
      created_at:          r.created_at,
      primary_action:      primaryActionOf(r, flags, staff),
    };
  });
  return { items, total, page, limit, counts, queueCounts, flagCounts };
}

// ── Loading the rows of one job ──────────────────────────────────────────────
async function latestOrderForQuotation(quotationId) {
  const { rows } = await query(
    `SELECT o.*, s.name AS staff_name, c.account_terms
     FROM orders o
     JOIN clients c ON c.id = o.client_id
     LEFT JOIN staff s ON s.id = o.assigned_staff_id
     WHERE o.quotation_id = $1 ORDER BY o.created_at DESC LIMIT 1`,
    [quotationId]
  );
  return rows[0] || null;
}

async function quotationForLifecycle(quotationId) {
  if (!quotationId) return null;
  const { rows } = await query(
    `SELECT q.*, ${IS_EXPIRED_SQL} AS is_expired, ${PAST_VALIDITY_SQL} AS past_validity FROM quotations q WHERE q.id = $1`,
    [quotationId]
  );
  return rows[0] || null;
}

const ticketsForOrder = async (orderId) => (orderId
  ? (await query(
    `SELECT t.*, s.name AS assigned_name FROM tickets t LEFT JOIN staff s ON s.id = t.assigned_staff_id
     WHERE t.order_id = $1 ORDER BY t.created_at DESC`, [orderId])).rows
  : []);

/** The job's conversation: the quote's / order's own, else the client's open (or latest) one. */
async function conversationFor({ clientId, conversationId }) {
  const { rows } = await query(
    `SELECT cv.id, cv.state, cv.is_open, cv.assigned_staff_id, s.name AS assigned_staff_name,
            cv.last_message_at, cv.created_at,
            (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = cv.id
               AND m.direction = 'inbound' AND m.is_read_by_staff = false) AS unread_count,
            (SELECT json_build_object('body', m.body, 'direction', m.direction, 'created_at', m.created_at)
               FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
            (SELECT json_build_object('body', m.body, 'direction', m.direction, 'created_at', m.created_at)
               FROM messages m WHERE m.conversation_id = cv.id AND m.direction = 'inbound'
               ORDER BY m.created_at DESC LIMIT 1) AS last_inbound
     FROM conversations cv
     LEFT JOIN staff s ON s.id = cv.assigned_staff_id
     WHERE ${conversationId ? 'cv.id = $1' : 'cv.client_id = $1'}
     ORDER BY cv.is_open DESC, cv.last_message_at DESC
     LIMIT 1`,
    [conversationId || clientId]
  );
  const c = rows[0] || null;
  if (c) {
    c.with_consultant = HUMAN_STATES.includes(c.state);
    c.client_waiting = c.is_open !== false && c.state === CLIENT_WAITING_STATE;
  }
  return c;
}

/** `lifecycle` for GET /orders/:id (detail = getOrderById result). */
export async function lifecycleForOrder({ order, payments = [] }, staff) {
  const [quotation, tickets, conversation] = await Promise.all([
    quotationForLifecycle(order.quotation_id),
    ticketsForOrder(order.id),
    conversationFor({ clientId: order.client_id, conversationId: order.conversation_id }),
  ]);
  return buildLifecycle({ quotation, order, payments, tickets, conversation }, staff);
}

/** `lifecycle` for GET /quotations/:id (quotation = getQuotationById row). */
export async function lifecycleForQuotation(quotation, staff) {
  const order = await latestOrderForQuotation(quotation.id);
  const [payments, tickets, conversation] = await Promise.all([
    order ? query('SELECT * FROM payments WHERE order_id = $1', [order.id]).then((r) => r.rows) : [],
    ticketsForOrder(order?.id),
    conversationFor({ clientId: quotation.client_id, conversationId: quotation.conversation_id ?? order?.conversation_id }),
  ]);
  return buildLifecycle({ quotation, order, payments, tickets, conversation }, staff);
}

// ── One job ──────────────────────────────────────────────────────────────────
const MESSAGE_LIMIT = 200;

/**
 * Merged history: quotation events, stage changes (incl. overrides), payments,
 * proof events, purchase orders, tickets and the conversation's messages — oldest first.
 * Each entry: { at, type, actor_name?, data }.
 */
async function jobHistory({ quotation, order, payments, tickets, conversation }) {
  const events = [];
  const push = (at, type, data = {}, actorName = null) => { if (at) events.push({ at, type, actor_name: actorName, data }); };

  const { rows: jobEvents } = await query(
    `SELECT e.*, s.name AS actor_name FROM job_events e LEFT JOIN staff s ON s.id = e.actor_id
     WHERE e.quotation_id = $1 OR ($2::uuid IS NOT NULL AND e.order_id = $2)
     ORDER BY e.created_at, e.id`,
    [quotation.id, order?.id ?? null]
  );
  const has = (type) => jobEvents.some((e) => e.type === type);

  push(quotation.created_at, 'quotation.created', { reference: quotation.reference, auto_quoted: quotation.auto_quoted, notes: quotation.notes ?? null });
  if (quotation.approved_at && !has('quotation.sent') && quotation.status !== 'draft') {
    push(quotation.approved_at, 'quotation.sent', { total: quotation.total, legacy: true });
  }
  for (const e of jobEvents) push(e.created_at, e.type, e.data || {}, e.actor_name);

  if (order) {
    const { rows: stages } = await query(
      `SELECT h.*, s.name AS changed_by_name FROM order_stage_history h LEFT JOIN staff s ON s.id = h.changed_by
       WHERE h.order_id = $1 ORDER BY h.created_at, h.id`,
      [order.id]
    );
    stages.forEach((h, i) => {
      const data = { stage: h.stage, from_stage: h.from_stage, notes: h.notes, reference: order.reference };
      if (h.override_reason || h.overridden_guards?.length) {
        data.override = { reason: h.override_reason, guards: h.overridden_guards || [] };
      }
      push(h.created_at, i === 0 && !h.from_stage ? 'order.created' : (data.override ? 'stage.overridden' : 'stage.changed'), data, h.changed_by_name);
    });
    for (const p of payments) push(p.created_at, 'payment.recorded', { type: p.type, amount: p.amount, currency: p.currency, notes: p.notes }, p.recorded_by_name ?? null);
    if (order.proof_sent_at && !has('proof.sent')) push(order.proof_sent_at, 'proof.sent', { proofUrl: order.proof_url, legacy: true });
  }
  for (const t of tickets) push(t.created_at, 'ticket.opened', { ticketId: t.id, category: t.category, description: t.description });

  if (conversation) {
    const { rows: msgs } = await query(
      `SELECT * FROM (
         SELECT id, direction, body, created_at, status FROM messages
         WHERE conversation_id = $1 AND created_at >= $2
         ORDER BY created_at DESC LIMIT ${MESSAGE_LIMIT}) m
       ORDER BY created_at`,
      [conversation.id, quotation.created_at]
    );
    for (const m of msgs) push(m.created_at, 'message', { id: m.id, direction: m.direction, body: m.body, status: m.status });
  }

  return events.sort((a, b) => new Date(a.at) - new Date(b.at));
}

/**
 * GET /api/jobs/:quotationId
 * @returns {{ quotation, order, payments, sizes, purchaseOrders, tickets, conversation, client, history, lifecycle }}
 */
export async function getJob(quotationId, staff) {
  const quotation = await getQuotationById(quotationId);
  const order = await latestOrderForQuotation(quotationId);
  const [payments, sizes, tickets, conversation, clientRows, purchaseOrders] = await Promise.all([
    order ? query(
      `SELECT p.*, s.name AS recorded_by_name FROM payments p LEFT JOIN staff s ON s.id = p.recorded_by
       WHERE p.order_id = $1 ORDER BY p.created_at DESC`, [order.id]).then((r) => r.rows) : [],
    order ? listSizeEntries(order.id) : [],
    ticketsForOrder(order?.id),
    conversationFor({ clientId: quotation.client_id, conversationId: quotation.conversation_id ?? order?.conversation_id }),
    query(
      `SELECT c.*, s.name AS account_terms_set_by_name FROM clients c
       LEFT JOIN staff s ON s.id = c.account_terms_set_by WHERE c.id = $1`, [quotation.client_id]).then((r) => r.rows),
    query(
      `SELECT po.*, s.name AS validated_by_name FROM purchase_orders po LEFT JOIN staff s ON s.id = po.validated_by
       WHERE po.quotation_id = $1 ORDER BY po.created_at DESC`, [quotationId]).then((r) => r.rows),
  ]);
  const history = await jobHistory({ quotation, order, payments, tickets, conversation });
  const lifecycle = buildLifecycle({ quotation, order, payments, tickets, conversation }, staff);
  return { quotation, order, payments, sizes, purchaseOrders, tickets, conversation, client: clientRows[0] || null, history, lifecycle };
}

/** GET /api/jobs/by-order/:orderId → { orderId, quotationId } (quotationId null for a legacy order without a quote). */
export async function jobForOrder(orderId) {
  const { rows } = await query('SELECT id, quotation_id FROM orders WHERE id = $1', [orderId]);
  if (!rows.length) throw new HttpError(404, 'Order not found');
  return { orderId: rows[0].id, quotationId: rows[0].quotation_id };
}

/**
 * SQL subquery: the client's most relevant job as JSON { quotation_id, state }
 * (an active job before a finished one, then the most recently updated), or
 * NULL. For lists that show a job state per client (the inbox).
 * @param {string} clientIdSql SQL for the client id (e.g. 'cl.id')
 */
export function latestJobSql(clientIdSql) {
  const terminal = `(${STATE_SQL} IN ('COMPLETED', 'DECLINED', 'EXPIRED', 'CANCELLED'))`;
  return `(SELECT json_build_object('quotation_id', q.id, 'state', ${STATE_SQL})
           FROM quotations q
           JOIN clients c ON c.id = q.client_id
           LEFT JOIN LATERAL (SELECT * FROM orders WHERE quotation_id = q.id ORDER BY created_at DESC LIMIT 1) o ON true
           WHERE q.client_id = ${clientIdSql}
           ORDER BY ${terminal} ASC, GREATEST(q.updated_at, COALESCE(o.updated_at, q.updated_at)) DESC
           LIMIT 1)`;
}

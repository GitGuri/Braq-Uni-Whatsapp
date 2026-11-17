import { query, withTransaction } from '../../core/db.js';
import { HttpError, pageParams } from '../../core/errors.js';
import { TICKET_SLA_HOURS } from '../../core/money.js';
import { TICKET_STATUSES, ticketTransition, OPEN_TICKET_STATUSES } from '../lifecycle/machines.js';
import { TEMPLATES } from '../bot/templates.js';
import { queueWhatsAppText, TEMPLATE_FALLBACKS } from '../notifications/whatsapp.js';
import { recordJobEvent } from '../jobs/events.js';

export { TICKET_STATUSES };

const ORDER_REF_RE = /\bBRQ-O-(?:\d{8}-\d{4}|\d{5,})\b/i;

/**
 * The order a client's ticket is about: an order reference quoted in the text
 * (the client's own orders only), else the client's single active order, else —
 * when nothing is active — their most recent order. Ambiguous → null.
 * @returns {Promise<{ id, reference } | null>}
 */
export async function findOrderForTicket(clientId, text = '') {
  const ref = ORDER_REF_RE.exec(String(text || ''))?.[0]?.toUpperCase();
  if (ref) {
    const { rows } = await query('SELECT id, reference FROM orders WHERE client_id = $1 AND reference = $2', [clientId, ref]);
    if (rows.length) return rows[0];
  }
  const { rows: active } = await query(
    `SELECT id, reference FROM orders
     WHERE client_id = $1 AND stage <> 'completed' AND cancelled_at IS NULL
     ORDER BY created_at DESC LIMIT 2`,
    [clientId]
  );
  if (active.length === 1) return active[0];
  if (active.length > 1) return null;
  const { rows: recent } = await query(
    'SELECT id, reference FROM orders WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1',
    [clientId]
  );
  return recent[0] || null;
}

/**
 * A ticket raised by the client on WhatsApp. sourceEventId (the inbound event):
 * a replay of the same bot turn returns the ticket it already created (DAT-2).
 */
export async function createTicket({ clientId, orderId, category, description, sourceEventId = null }) {
  const slaDueAt = new Date(Date.now() + TICKET_SLA_HOURS * 60 * 60 * 1000);
  const { rows } = await query(
    `INSERT INTO tickets (client_id, order_id, category, description, sla_due_at, source_event_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [clientId, orderId || null, category, description, slaDueAt, sourceEventId]
  );
  if (rows.length) return rows[0];
  const { rows: earlier } = await query('SELECT * FROM tickets WHERE source_event_id = $1', [sourceEventId]);
  return earlier[0];
}

/** Staff open a ticket for a client (optionally on one of their orders); assigned to the creator. */
export async function createTicketByStaff({ clientId, orderId = null, category, description }, actor) {
  const { rows: clients } = await query('SELECT id FROM clients WHERE id = $1', [clientId]);
  if (!clients.length) throw new HttpError(400, 'Client not found');
  if (orderId) {
    const { rows } = await query('SELECT client_id FROM orders WHERE id = $1', [orderId]);
    if (!rows.length) throw new HttpError(400, 'Order not found');
    if (rows[0].client_id !== clientId) throw new HttpError(400, 'Order belongs to a different client');
  }
  const slaDueAt = new Date(Date.now() + TICKET_SLA_HOURS * 60 * 60 * 1000);
  const { rows } = await query(
    `INSERT INTO tickets (client_id, order_id, category, description, sla_due_at, assigned_staff_id, claimed_at)
     VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6::uuid IS NULL THEN NULL ELSE NOW() END) RETURNING *`,
    [clientId, orderId, category, description, slaDueAt, actor?.id ?? null]
  );
  return rows[0];
}

// Returns { items, total, page, limit }.
export async function listTickets({ status, overdue, clientId, orderId, page, limit } = {}) {
  const pg = pageParams({ page, limit }, { defaultLimit: 30 });
  const params = [];
  let where = ['1=1'];

  if (status) {
    if (!TICKET_STATUSES.includes(status)) {
      throw new HttpError(400, `Invalid status filter: must be one of ${TICKET_STATUSES.join(', ')}`);
    }
    params.push(status); where.push(`t.status = $${params.length}`);
  }
  if (overdue === 'true') where.push(`t.status IN ('open','in_progress') AND t.sla_due_at < NOW()`);
  if (clientId) { params.push(clientId); where.push(`t.client_id = $${params.length}`); }
  if (orderId)  { params.push(orderId);  where.push(`t.order_id = $${params.length}`); }

  const filterParams = [...params];
  params.push(pg.limit); params.push(pg.offset);

  const { rows } = await query(
    `SELECT t.*,
            c.name            AS client_name,
            c.whatsapp_number AS client_wa,
            s.name            AS assigned_name,
            o.reference       AS order_reference,
            o.quotation_id    AS quotation_id,
            (t.sla_due_at < NOW() AND t.status IN ('open','in_progress')) AS is_overdue
     FROM tickets t
     LEFT JOIN clients c ON t.client_id       = c.id
     LEFT JOIN staff   s ON t.assigned_staff_id = s.id
     LEFT JOIN orders  o ON t.order_id        = o.id
     WHERE ${where.join(' AND ')}
     ORDER BY t.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const { rows: countRows } = await query(`SELECT COUNT(*)::int AS total FROM tickets t WHERE ${where.join(' AND ')}`, filterParams);
  return { items: rows, total: countRows[0].total, page: pg.page, limit: pg.limit };
}

export async function getTicketById(id) {
  const { rows } = await query(
    `SELECT t.*,
            c.name            AS client_name,
            c.whatsapp_number AS client_wa,
            o.reference       AS order_reference,
            o.quotation_id    AS quotation_id,
            o.stage           AS order_stage,
            s.name            AS assigned_name,
            (SELECT cv.id FROM conversations cv WHERE cv.client_id = t.client_id
             ORDER BY cv.is_open DESC, cv.last_message_at DESC LIMIT 1) AS conversation_id,
            (t.sla_due_at < NOW() AND t.status IN ('open','in_progress')) AS is_overdue
     FROM tickets t
     LEFT JOIN clients c ON t.client_id         = c.id
     LEFT JOIN orders  o ON t.order_id           = o.id
     LEFT JOIN staff   s ON t.assigned_staff_id  = s.id
     WHERE t.id = $1`,
    [id]
  );
  if (!rows.length) throw new HttpError(404, 'Ticket not found');
  return rows[0];
}

/**
 * Update status (ticket machine), assignee (null clears) and resolution note.
 * Resolving notifies the client on WhatsApp (queued with the update).
 */
export async function updateTicket(id, { status, assignedStaffId, resolutionNote } = {}, actor = null) {
  if (status === undefined && assignedStaffId === undefined && resolutionNote === undefined) {
    throw new HttpError(400, 'No fields to update');
  }
  if (assignedStaffId) {
    const { rows: staff } = await query('SELECT id FROM staff WHERE id = $1 AND is_active = true', [assignedStaffId]);
    if (!staff.length) throw new HttpError(400, 'assignedStaffId does not match an active staff member');
  }

  return withTransaction(async (tx) => {
    const { rows: cur } = await tx.query(
      `SELECT t.*, c.whatsapp_number AS client_wa, c.name AS client_name, o.reference AS order_reference, o.quotation_id
       FROM tickets t
       LEFT JOIN clients c ON c.id = t.client_id
       LEFT JOIN orders o  ON o.id = t.order_id
       WHERE t.id = $1 FOR UPDATE OF t`,
      [id]
    );
    if (!cur.length) throw new HttpError(404, 'Ticket not found');
    const before = cur[0];

    const setFields = ['updated_at = NOW()'];
    const params = [];
    if (status) {
      const verdict = ticketTransition(before.status, status);
      if (!verdict.ok) throw new HttpError(verdict.code === 'INVALID_STATUS' ? 400 : 409, verdict.message, { code: verdict.code });
      params.push(status);
      setFields.push(`status = $${params.length}`);
      // Keep the original resolution time when moving resolved → closed;
      // reopening (open / in_progress) clears it.
      if (['resolved', 'closed'].includes(status)) setFields.push('resolved_at = COALESCE(resolved_at, NOW())');
      else setFields.push('resolved_at = NULL');
    }
    if (assignedStaffId !== undefined) {
      params.push(assignedStaffId);
      setFields.push(`assigned_staff_id = $${params.length}`);
      setFields.push(assignedStaffId ? 'claimed_at = COALESCE(claimed_at, NOW())' : 'claimed_at = NULL');
    }
    if (resolutionNote !== undefined) {
      params.push(resolutionNote || null);
      setFields.push(`resolution_note = $${params.length}`);
    }

    params.push(id);
    const { rows } = await tx.query(
      `UPDATE tickets SET ${setFields.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    const ticket = rows[0];

    const newlyResolved = status === 'resolved' && before.status !== 'resolved' && before.status !== 'closed';
    if (newlyResolved) {
      await recordJobEvent(tx, {
        quotationId: before.quotation_id, orderId: before.order_id, type: 'ticket.resolved',
        actorId: actor?.id ?? null, data: { ticketId: id, note: ticket.resolution_note },
      });
      if (before.client_wa) {
        await queueWhatsAppText(tx, {
          to: before.client_wa,
          body: TEMPLATES.TICKET_RESOLVED({ reference: before.order_reference, note: ticket.resolution_note }),
          clientId: before.client_id,
          templateFallback: TEMPLATE_FALLBACKS.ticketResolved({
            client: { name: before.client_name }, reference: before.order_reference, note: ticket.resolution_note,
          }),
        }, { dedupeKey: `ticket:${id}:resolved:${new Date(ticket.resolved_at).getTime()}` });
      }
    }
    return ticket;
  });
}

export { OPEN_TICKET_STATUSES };

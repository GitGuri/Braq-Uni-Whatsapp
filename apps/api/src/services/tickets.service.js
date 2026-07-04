import { query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';

const SLA_FIRST_RESPONSE_HOURS = 1; // bot/consultant initial response window

// Escalation tiers, in hours since creation — used to compute a lazy "level"
// on read (0 = within SLA, 3 = badly overdue). No background job: staff query
// `overdue=true` rather than receiving a push alert.
const ESCALATION_TIERS = [1, 4, 24];

function computeEscalationLevel(createdAt) {
  const hoursElapsed = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  let level = 0;
  for (const tier of ESCALATION_TIERS) {
    if (hoursElapsed >= tier) level += 1;
  }
  return level;
}

export async function createTicket({ clientId, orderId, category, description }) {
  const slaDueAt = new Date(Date.now() + SLA_FIRST_RESPONSE_HOURS * 60 * 60 * 1000);
  const { rows } = await query(
    `INSERT INTO tickets (client_id, order_id, category, description, sla_due_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [clientId, orderId || null, category, description, slaDueAt]
  );
  return rows[0];
}

export async function listTickets({ status, overdue, page = 1, limit = 30 }) {
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [];
  let where = ['1=1'];

  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (overdue === 'true') where.push(`status IN ('open','in_progress') AND sla_due_at < NOW()`);

  params.push(parseInt(limit)); params.push(offset);

  const { rows } = await query(
    `SELECT t.*,
            c.name            AS client_name,
            c.whatsapp_number AS client_wa,
            s.name            AS assigned_name,
            (t.sla_due_at < NOW() AND t.status IN ('open','in_progress')) AS is_overdue
     FROM tickets t
     LEFT JOIN clients c ON t.client_id       = c.id
     LEFT JOIN staff   s ON t.assigned_staff_id = s.id
     WHERE ${where.join(' AND ')}
     ORDER BY t.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map(withComputedEscalation);
}

export async function getTicketById(id) {
  const { rows } = await query(
    `SELECT t.*,
            c.name            AS client_name,
            c.whatsapp_number AS client_wa,
            o.reference       AS order_reference,
            s.name            AS assigned_name,
            (t.sla_due_at < NOW() AND t.status IN ('open','in_progress')) AS is_overdue
     FROM tickets t
     LEFT JOIN clients c ON t.client_id         = c.id
     LEFT JOIN orders  o ON t.order_id           = o.id
     LEFT JOIN staff   s ON t.assigned_staff_id  = s.id
     WHERE t.id = $1`,
    [id]
  );
  if (!rows.length) throw new HttpError(404, 'Ticket not found');
  return withComputedEscalation(rows[0]);
}

function withComputedEscalation(ticket) {
  if (['resolved', 'closed'].includes(ticket.status)) return ticket;
  return { ...ticket, escalation_level: computeEscalationLevel(ticket.created_at) };
}

export async function updateTicket(id, { status, assignedStaffId }) {
  const setFields = ['updated_at = NOW()'];
  const params = [];

  if (status) {
    params.push(status);
    setFields.push(`status = $${params.length}`);
    if (['resolved', 'closed'].includes(status)) setFields.push('resolved_at = NOW()');
  }
  if (assignedStaffId) { params.push(assignedStaffId); setFields.push(`assigned_staff_id = $${params.length}`); }
  if (!params.length) throw new HttpError(400, 'No fields to update');

  params.push(id);
  const { rows } = await query(
    `UPDATE tickets SET ${setFields.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows.length) throw new HttpError(404, 'Ticket not found');
  return rows[0];
}

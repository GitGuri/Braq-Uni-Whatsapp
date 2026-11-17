import { z } from 'zod';
import * as ticketsService from './service.js';
import { sendError, validationBody, isUuid } from '../../core/errors.js';
import { paged } from '../../core/http.js';
import { query } from '../../core/db.js';

// assignedStaffId: null clears the assignee. Status changes follow the ticket
// machine (lifecycle); resolving notifies the client on WhatsApp.
const UpdateTicketSchema = z.object({
  status:         z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
  assignedStaffId: z.string().uuid({ message: 'assignedStaffId must be a staff UUID' }).nullable().optional(),
  resolutionNote: z.string().max(2000).nullable().optional(),
});

const CreateTicketSchema = z.object({
  clientId:    z.string().uuid(),
  orderId:     z.string().uuid().nullable().optional(),
  category:    z.enum(['wrong_item', 'defective', 'missing_item', 'account_query', 'other']),
  description: z.string().trim().min(5).max(5000),
});

function handleError(res, err, fallbackMessage) {
  return sendError(res, err, fallbackMessage);
}

// ── GET /tickets ─────────────────────────────────────────────────────────────
// Response: { items, total, page, limit, tickets (legacy key) }
export async function list(req, res) {
  try {
    const { status, overdue, page, limit } = req.query;
    const uuidOrUndef = (v) => (isUuid(v) ? v : undefined);
    const result = await ticketsService.listTickets({
      status, overdue, page, limit, clientId: uuidOrUndef(req.query.clientId), orderId: uuidOrUndef(req.query.orderId),
    });
    paged(res, 'tickets', result);
  } catch (err) {
    handleError(res, err, 'Failed to fetch tickets');
  }
}

export async function getById(req, res) {
  try {
    const ticket = await ticketsService.getTicketById(req.params.id);
    res.json({ ticket });
  } catch (err) {
    handleError(res, err, 'Failed to fetch ticket');
  }
}

// ── POST /tickets/:id/claim ───────────────────────────────────────────────────
export async function claim(req, res) {
  try {
    const { rows } = await query(
      `UPDATE tickets
       SET assigned_staff_id = $1, claimed_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND assigned_staff_id IS NULL
       RETURNING *`,
      [req.staff.id, req.params.id]
    );

    if (rows.length) return res.json({ ticket: rows[0] });

    const { rows: current } = await query(
      `SELECT t.id, s.name AS claimer_name
       FROM tickets t
       LEFT JOIN staff s ON s.id = t.assigned_staff_id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!current.length) return res.status(404).json({ error: 'Ticket not found' });

    return res.status(409).json({
      error: `Already claimed by ${current[0].claimer_name ?? 'another consultant'}`,
    });
  } catch (err) {
    handleError(res, err, 'Failed to claim ticket');
  }
}

export async function update(req, res) {
  const parsed = UpdateTicketSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    const ticket = await ticketsService.updateTicket(req.params.id, parsed.data, req.staff);
    res.json({ ticket });
  } catch (err) {
    handleError(res, err, 'Failed to update ticket');
  }
}

// ── POST /tickets ────────────────────────────────────────────────────────────
// Staff open a ticket for a client (optionally linked to one of their orders).
export async function create(req, res) {
  const parsed = CreateTicketSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));
  try {
    const created = await ticketsService.createTicketByStaff(parsed.data, req.staff);
    const ticket = await ticketsService.getTicketById(created.id);
    res.status(201).json({ ticket });
  } catch (err) {
    handleError(res, err, 'Failed to create ticket');
  }
}

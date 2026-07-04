import { z } from 'zod';
import * as ticketsService from '../services/tickets.service.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';
import { query } from '../db/pool.js';

const UpdateTicketSchema = z.object({
  status:         z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
  assignedStaffId: z.string().uuid().optional(),
});

function handleError(res, err, fallbackMessage) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  logger.error(fallbackMessage, { error: err.message });
  return res.status(500).json({ error: fallbackMessage });
}

export async function list(req, res) {
  try {
    const tickets = await ticketsService.listTickets(req.query);
    res.json({ tickets });
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
    logger.error('Failed to claim ticket', { error: err.message });
    res.status(500).json({ error: 'Failed to claim ticket' });
  }
}

export async function update(req, res) {
  const parsed = UpdateTicketSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const ticket = await ticketsService.updateTicket(req.params.id, parsed.data);
    res.json({ ticket });
  } catch (err) {
    handleError(res, err, 'Failed to update ticket');
  }
}

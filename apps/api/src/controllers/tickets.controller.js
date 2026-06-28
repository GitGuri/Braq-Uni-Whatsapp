import { z } from 'zod';
import * as ticketsService from '../services/tickets.service.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

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

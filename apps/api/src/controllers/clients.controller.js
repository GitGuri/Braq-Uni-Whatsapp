import { z } from 'zod';
import * as clientsService from '../services/clients.service.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

const UpdateClientSchema = z.object({
  name:          z.string().optional(),
  email:         z.string().email().optional(),
  clientType:    z.enum(['retail','school','corporate','hospitality','church','security','government','reseller']).optional(),
  organisation:  z.string().optional(),
  contactPerson: z.string().optional(),
  notes:         z.string().optional(),
  physicalAddress:        z.string().optional(),
  vatNumber:              z.string().optional(),
  preferredStoreLocation: z.string().optional(),
  schoolName:             z.string().optional(),
});

function handleError(res, err, fallbackMessage) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  logger.error(fallbackMessage, { error: err.message });
  return res.status(500).json({ error: fallbackMessage });
}

// ── GET /clients ────────────────────────────────────────────────────────────────
export async function list(req, res) {
  try {
    const clients = await clientsService.listClients(req.query);
    res.json({ clients });
  } catch (err) {
    handleError(res, err, 'Failed to fetch clients');
  }
}

// ── GET /clients/:id ──────────────────────────────────────────────────────────
export async function getById(req, res) {
  try {
    const result = await clientsService.getClientById(req.params.id);
    res.json(result);
  } catch (err) {
    handleError(res, err, 'Failed to fetch client');
  }
}

// ── PATCH /clients/:id ─────────────────────────────────────────────────────────
export async function update(req, res) {
  const parsed = UpdateClientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const client = await clientsService.updateClient(req.params.id, parsed.data);
    res.json({ client });
  } catch (err) {
    handleError(res, err, 'Failed to update client');
  }
}

import { z } from 'zod';
import * as staffService from '../services/staff.service.js';
import { generateToken } from '../middleware/auth.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(6),
});

const CreateStaffSchema = z.object({
  name:     z.string().min(1),
  email:    z.string().email(),
  password: z.string().min(8),
  role:     z.enum(['admin','consultant','manager']).default('consultant'),
});

function handleError(res, err, fallbackMessage) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  logger.error(fallbackMessage, { error: err.message });
  return res.status(500).json({ error: fallbackMessage });
}

// ── POST /staff/login ──────────────────────────────────────────────────────────
export async function login(req, res) {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const staff = await staffService.authenticate(parsed.data.email, parsed.data.password);
    const token = generateToken(staff);
    logger.info('Staff login', { email: staff.email, role: staff.role });
    res.json({
      token,
      staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role },
    });
  } catch (err) {
    handleError(res, err, 'Login failed');
  }
}

// ── GET /staff/me ──────────────────────────────────────────────────────────────
export async function me(req, res) {
  try {
    const staff = await staffService.getById(req.staff.id);
    res.json({ staff });
  } catch (err) {
    handleError(res, err, 'Failed to fetch profile');
  }
}

// ── GET /staff ─────────────────────────────────────────────────────────────────
export async function list(req, res) {
  try {
    const staff = await staffService.listAll();
    res.json({ staff });
  } catch (err) {
    handleError(res, err, 'Failed to fetch staff');
  }
}

// ── DELETE /staff/:id ─────────────────────────────────────────────────────────
export async function remove(req, res) {
  try {
    await staffService.remove(req.params.id);
    res.status(204).end();
  } catch (err) {
    handleError(res, err, 'Failed to delete staff member');
  }
}

// ── POST /staff ────────────────────────────────────────────────────────────────
export async function create(req, res) {
  const parsed = CreateStaffSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const staff = await staffService.create(parsed.data);
    res.status(201).json({ staff });
  } catch (err) {
    handleError(res, err, 'Failed to create staff member');
  }
}

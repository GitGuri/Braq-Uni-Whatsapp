import { z } from 'zod';
import * as staffService from './service.js';
import { generateToken } from '../../middleware/auth.js';
import { HttpError, sendError, validationBody, isUuid } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

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
  return sendError(res, err, fallbackMessage);
}

// ── POST /staff/login ──────────────────────────────────────────────────────────
export async function login(req, res) {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

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

// ── DELETE /staff/:id — remove access (deactivates; history keeps the name) ───
export async function remove(req, res) {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid staff id' });
  try {
    await staffService.remove(req.params.id, req.staff);
    logger.info('Staff access removed', { staffId: req.params.id, by: req.staff.id });
    res.status(204).end();
  } catch (err) {
    handleError(res, err, 'Failed to remove staff member');
  }
}

const UpdateStaffSchema = z.object({
  role:     z.enum(['admin', 'consultant', 'manager']).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, 'Nothing to update');

// ── PATCH /staff/:id — role, reactivate / deactivate, password reset (admin) ──
export async function update(req, res) {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid staff id' });
  const parsed = UpdateStaffSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));
  try {
    const staff = await staffService.update(req.params.id, req.staff, parsed.data);
    logger.info('Staff updated', { staffId: req.params.id, fields: Object.keys(parsed.data), by: req.staff.id });
    res.json({ staff });
  } catch (err) {
    handleError(res, err, 'Failed to update staff member');
  }
}

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword:     z.string().min(8).max(200),
});

// ── POST /staff/me/password — change your own password ───────────────────────
export async function changePassword(req, res) {
  const parsed = ChangePasswordSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));
  try {
    await staffService.changeOwnPassword(req.staff.id, parsed.data);
    res.status(204).end();
  } catch (err) {
    handleError(res, err, 'Failed to change password');
  }
}

// ── POST /staff ────────────────────────────────────────────────────────────────
export async function create(req, res) {
  const parsed = CreateStaffSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    const staff = await staffService.create(parsed.data);
    res.status(201).json({ staff });
  } catch (err) {
    handleError(res, err, 'Failed to create staff member');
  }
}

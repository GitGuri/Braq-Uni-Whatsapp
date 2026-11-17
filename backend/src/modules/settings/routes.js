import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requirePermission } from '../../core/rbac.js';
import { asyncHandler } from '../../core/http.js';
import { sendError } from '../../core/errors.js';
import * as settingsService from './service.js';

export const settingsRouter = express.Router();
settingsRouter.use(requireAuth);

// GET /api/settings — all settings (admin/manager only)
settingsRouter.get('/', requirePermission('settings.read'), asyncHandler(async (_req, res) => {
  try {
    res.json({ settings: await settingsService.listSettings() });
  } catch (err) {
    sendError(res, err, 'Failed to fetch settings');
  }
}));

// PATCH /api/settings/:key — update a single setting
settingsRouter.patch('/:key', requirePermission('settings.write'), asyncHandler(async (req, res) => {
  const { value } = req.body ?? {};
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  // Settings are stored as text: a nested object would be saved as "[object Object]" (SEC-10).
  if (!['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 2000) {
    return res.status(400).json({ error: 'value must be a string, number or boolean (max 2000 characters)' });
  }
  try {
    res.json({ setting: await settingsService.updateSetting(req.params.key, value) });
  } catch (err) {
    sendError(res, err, 'Failed to update setting');
  }
}));

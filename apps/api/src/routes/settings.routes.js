import express from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { query } from '../db/pool.js';

export const settingsRouter = express.Router();
settingsRouter.use(requireAuth);

// GET /api/settings — all settings (admin/manager only)
settingsRouter.get('/', requireRole('admin', 'manager'), async (_req, res) => {
  try {
    const { rows } = await query('SELECT key, value FROM settings ORDER BY key');
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PATCH /api/settings/:key — update a single setting
settingsRouter.patch('/:key', requireRole('admin', 'manager'), async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });

  try {
    const { rows } = await query(
      `UPDATE settings SET value = $1, updated_at = NOW()
       WHERE key = $2 RETURNING key, value`,
      [String(value), key]
    );
    if (!rows.length) return res.status(404).json({ error: 'Setting not found' });
    res.json({ setting: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

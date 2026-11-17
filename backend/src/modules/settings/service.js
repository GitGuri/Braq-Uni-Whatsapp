// Key/value settings (e.g. busy_mode).
import { query } from '../../core/db.js';
import { HttpError } from '../../core/errors.js';

/** All settings as { key: value }. */
export async function listSettings() {
  const { rows } = await query('SELECT key, value FROM settings ORDER BY key');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Update an existing setting (values are stored as text); 404 for an unknown key. */
export async function updateSetting(key, value) {
  const { rows } = await query(
    `UPDATE settings SET value = $1, updated_at = NOW()
     WHERE key = $2 RETURNING key, value`,
    [String(value), key]
  );
  if (!rows.length) throw new HttpError(404, 'Setting not found');
  return rows[0];
}

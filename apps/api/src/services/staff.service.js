import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';

// ── Verify email/password and return the staff record ────────────────────────
export async function authenticate(email, password) {
  const { rows } = await query(
    'SELECT * FROM staff WHERE email = $1 AND is_active = true',
    [email.toLowerCase()]
  );
  if (!rows.length) throw new HttpError(401, 'Invalid credentials');

  const staff = rows[0];
  const valid = await bcrypt.compare(password, staff.password_hash);
  if (!valid) throw new HttpError(401, 'Invalid credentials');

  return staff;
}

export async function getById(id) {
  const { rows } = await query(
    'SELECT id, name, email, role, created_at FROM staff WHERE id = $1',
    [id]
  );
  if (!rows.length) throw new HttpError(404, 'Staff not found');
  return rows[0];
}

export async function listAll() {
  const { rows } = await query(
    'SELECT id, name, email, role, is_active, created_at FROM staff ORDER BY name'
  );
  return rows;
}

export async function create({ name, email, password, role }) {
  const hash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await query(
      `INSERT INTO staff (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING id, name, email, role, created_at`,
      [name, email.toLowerCase(), hash, role]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'Email already exists');
    throw err;
  }
}

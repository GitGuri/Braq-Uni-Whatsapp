import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../../core/db.js';
import { HttpError } from '../../core/errors.js';

// A real cost-12 hash of a random string: an unknown email is compared against it
// so it takes as long as a wrong password (no account enumeration by timing, SEC-6).
const DUMMY_HASH = bcrypt.hashSync(`dummy-${Math.random()}`, 12);

// ── Verify email/password and return the staff record ────────────────────────
export async function authenticate(email, password) {
  const { rows } = await query(
    'SELECT * FROM staff WHERE email = $1 AND is_active = true',
    [email.toLowerCase()]
  );
  const staff = rows[0];
  const valid = await bcrypt.compare(password, staff?.password_hash ?? DUMMY_HASH);
  if (!staff || !valid) throw new HttpError(401, 'Invalid credentials');

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

/**
 * Lock the target and every active admin, then refuse a change that would leave
 * no active admin (nobody could manage staff any more). Runs on `tx`.
 * @returns {Promise<object>} the target row
 */
async function lockForStaffChange(tx, id) {
  const { rows } = await tx.query(
    `SELECT id, role, is_active FROM staff WHERE id = $1 OR (role = 'admin' AND is_active) ORDER BY id FOR UPDATE`,
    [id]
  );
  const target = rows.find((r) => r.id === id);
  if (!target) throw new HttpError(404, 'Staff not found');
  return { target, activeAdmins: rows.filter((r) => r.role === 'admin' && r.is_active) };
}

function assertKeepsAnAdmin({ target, activeAdmins }, { role, isActive }) {
  const losesAdmin = target.role === 'admin' && target.is_active
    && (isActive === false || (role && role !== 'admin'));
  if (losesAdmin && activeAdmins.length <= 1) {
    throw new HttpError(409, 'This is the last active admin — make someone else an admin first', { code: 'LAST_ADMIN' });
  }
}

/**
 * Remove a staff member's access (DELETE /staff/:id). The account is deactivated,
 * not deleted, so their name stays on the history they made (stage changes,
 * payments, events); requireAuth refuses their token at once (AUTH-2).
 */
export async function remove(id, actor) {
  if (actor?.id === id) throw new HttpError(400, 'You cannot remove your own account', { code: 'SELF' });
  await withTransaction(async (tx) => {
    const locked = await lockForStaffChange(tx, id);
    assertKeepsAnAdmin(locked, { isActive: false });
    await tx.query('UPDATE staff SET is_active = false WHERE id = $1', [id]);
  });
}

/** PATCH /staff/:id (admin): role, isActive (reactivate / deactivate), password reset. */
export async function update(id, actor, { role, isActive, password }) {
  if (actor?.id === id && (role !== undefined || isActive !== undefined)) {
    throw new HttpError(400, 'You cannot change your own role or access', { code: 'SELF' });
  }
  const hash = password ? await bcrypt.hash(password, 12) : null;
  return withTransaction(async (tx) => {
    const locked = await lockForStaffChange(tx, id);
    assertKeepsAnAdmin(locked, { role, isActive });
    const { rows } = await tx.query(
      `UPDATE staff SET role = COALESCE($2::staff_role, role), is_active = COALESCE($3, is_active),
              password_hash = COALESCE($4, password_hash)
       WHERE id = $1 RETURNING id, name, email, role, is_active, created_at`,
      [id, role ?? null, isActive ?? null, hash]
    );
    return rows[0];
  });
}

/** POST /staff/me/password: change your own password (the current one is required). */
export async function changeOwnPassword(id, { currentPassword, newPassword }) {
  const { rows } = await query('SELECT password_hash FROM staff WHERE id = $1 AND is_active = true', [id]);
  if (!rows.length || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
    throw new HttpError(400, 'Current password is incorrect', { code: 'BAD_PASSWORD' });
  }
  await query('UPDATE staff SET password_hash = $2 WHERE id = $1', [id, await bcrypt.hash(newPassword, 12)]);
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

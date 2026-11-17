import jwt from 'jsonwebtoken';
import { config } from '../core/config.js';
import { query } from '../core/db.js';
import { logger } from '../core/logger.js';
import { isUuid } from '../core/errors.js';

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorised — no token provided' });
  }

  const token = header.slice(7);
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Unauthorised — invalid or expired token' });
  }

  // A signed token whose id is not a staff id can never match an account.
  if (!isUuid(payload?.id)) {
    return res.status(401).json({ error: 'Unauthorised — invalid or expired token' });
  }

  // Re-check the account on every request so deactivation, deletion and role
  // changes take effect immediately rather than when the token expires.
  try {
    const { rows } = await query(
      'SELECT id, email, name, role FROM staff WHERE id = $1 AND is_active = true',
      [payload.id]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'Unauthorised — account inactive or removed' });
    }
    req.staff = { ...payload, ...rows[0] };
  } catch (err) {
    // The token was valid; the database could not be reached. A 401 here would
    // make the dashboard sign everyone out during a blip (SEC-5) — 503 is retryable.
    logger.error('Auth check could not reach the database', { error: err.message, code: err.code });
    return res.status(503).json({ error: 'Service temporarily unavailable — please try again' });
  }
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.staff?.role)) {
      return res.status(403).json({ error: 'Forbidden — insufficient permissions' });
    }
    next();
  };
}

export function generateToken(staff) {
  return jwt.sign(
    { id: staff.id, email: staff.email, role: staff.role, name: staff.name },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

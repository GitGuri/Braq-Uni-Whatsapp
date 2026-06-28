import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { query } from '../db/pool.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorised — no token provided' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.staff = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorised — invalid or expired token' });
  }
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

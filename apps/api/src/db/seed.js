import bcrypt from 'bcryptjs';
import { pool, query } from './pool.js';
import { logger } from '../utils/logger.js';

async function seed() {
  const name     = process.env.SEED_ADMIN_NAME     || 'Admin';
  const email    = (process.env.SEED_ADMIN_EMAIL    || 'admin@braquni.com').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || 'changeme123';

  const { rows } = await query('SELECT id FROM staff WHERE email = $1', [email]);
  if (rows.length) {
    logger.info('Seed admin already exists, skipping', { email });
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  await query(
    `INSERT INTO staff (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'admin')`,
    [name, email, hash]
  );

  logger.info('Seed admin created', { email });
  if (!process.env.SEED_ADMIN_PASSWORD) {
    logger.warn('Using default seed password — set SEED_ADMIN_PASSWORD and re-seed for production', { email });
  }
}

seed()
  .catch((err) => {
    logger.error('Seed failed', { error: err.message });
    process.exitCode = 1;
  })
  .finally(() => pool.end());

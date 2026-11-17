/**
 * Create the first admin (README step 6). Safe to re-run: skips an existing email.
 *
 * Against production (NODE_ENV=production or a Supabase DATABASE_URL) the
 * password must be given: SEED_ADMIN_PASSWORD, at least MIN_PROD_PASSWORD
 * characters. The local default ('changeme123') is refused there.
 */
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { config } from '../core/config.js';
import { pool, query } from '../core/db.js';
import { logger } from '../core/logger.js';
import { productionReason, configTarget } from './safety.js';

export const DEFAULT_PASSWORD = 'changeme123';
export const MIN_PROD_PASSWORD = 12;

/** Why seeding must not run with these settings, or null. Pure. */
export function seedRefusal({ target, password }) {
  const prod = productionReason(target);
  if (!prod) return null;
  if (!password) {
    return `Refusing to seed: ${prod}. Set SEED_ADMIN_PASSWORD (at least ${MIN_PROD_PASSWORD} characters) — the default password is for local development only.`;
  }
  if (password === DEFAULT_PASSWORD || password.length < MIN_PROD_PASSWORD) {
    return `Refusing to seed: ${prod}. SEED_ADMIN_PASSWORD must be at least ${MIN_PROD_PASSWORD} characters and not the local default.`;
  }
  return null;
}

export async function seed() {
  const name     = process.env.SEED_ADMIN_NAME     || 'Admin';
  const email    = (process.env.SEED_ADMIN_EMAIL    || 'admin@braquni.com').toLowerCase();
  const given    = process.env.SEED_ADMIN_PASSWORD || '';

  const reason = seedRefusal({ target: configTarget(config), password: given });
  if (reason) throw new Error(reason);
  const password = given || DEFAULT_PASSWORD;

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
  if (!given) {
    logger.warn('Using the local default seed password — never use it outside local development', { email });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed()
    .catch((err) => {
      logger.error('Seed failed', { error: err.message });
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

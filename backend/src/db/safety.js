/**
 * Guards for the maintenance scripts in src/db: "is this the production database?"
 *
 * Production is NODE_ENV=production or a Supabase-hosted DATABASE_URL (production
 * lives on Supabase; local development and the test harness use a local Postgres).
 * Pure: takes { env, url, host } so it can be tested without a database.
 */

export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Hostname of the target database ('' when the URL cannot be parsed). */
export function dbHost({ url, host } = {}) {
  if (!url) return host || '';
  try { return new URL(url).hostname; } catch { return ''; }
}

/** True when the target is a Supabase host. */
export function isSupabase({ url, host } = {}) {
  const h = dbHost({ url, host });
  return /supabase\.(co|com|net)$/i.test(h) || /supabase/i.test(url || '');
}

/**
 * Why the target counts as production, or null when it does not.
 * @param {{ env?: string, url?: string, host?: string }} target
 */
export function productionReason({ env, url, host } = {}) {
  if (env === 'production') return 'NODE_ENV is production';
  if (isSupabase({ url, host })) return `${dbHost({ url, host }) || 'the target'} is a Supabase host (production)`;
  return null;
}

/** The target from the loaded config (core/config.js). */
export const configTarget = (config) => ({ env: config.env, url: config.db.url, host: config.db.host });
